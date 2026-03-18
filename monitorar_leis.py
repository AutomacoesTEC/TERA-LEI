#!/usr/bin/env python3
"""
TERA — Monitorar Leis (v1.0)
Script para verificar diariamente se as leis monitoradas sofreram alterações
no portal do Planalto ou em outras fontes oficiais.

Executado via GitHub Actions diariamente às 08:00 BRT.

Fluxo:
  1. Lê data/leis_monitoradas.json (lista de leis com URL e hash anterior)
  2. Para cada lei, faz GET na URL e calcula hash do conteúdo
  3. Se hash diferente → detectou alteração → registra diff
  4. Salva resultado em data/monitoramento.json
  5. Se houver alterações, envia email de notificação (opcional)

Saída: data/monitoramento.json
"""

import json
import hashlib
import re
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    import subprocess
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "requests", "beautifulsoup4", "--quiet"]
    )
    import requests
    from bs4 import BeautifulSoup

# ── Configurações ────────────────────────────────────────────
BRT = timezone(timedelta(hours=-3))
AGORA = datetime.now(BRT)
DATA_HOJE = AGORA.strftime("%Y-%m-%d")
TIMEOUT = 30
MAX_RETRIES = 2
HEADERS = {
    "User-Agent": "TERA-LegalMonitor/2.0 (naytributario.github.io/TERA-LEI; educational)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5",
}
DATA_DIR = Path("data")
LEIS_FILE = DATA_DIR / "leis_monitoradas.json"
SAIDA = DATA_DIR / "monitoramento.json"


def log(msg):
    print(f"[{datetime.now(BRT).strftime('%H:%M:%S')}] {msg}")


def fetch_text(url):
    """
    Faz GET com retry e retorna o texto HTML limpo da página.
    Retorna (texto, None) em sucesso ou (None, erro) em falha.
    """
    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
            r.raise_for_status()
            r.encoding = r.apparent_encoding or "utf-8"
            return r.text, None
        except requests.exceptions.Timeout:
            last_error = f"Timeout (tentativa {attempt}/{MAX_RETRIES})"
        except requests.exceptions.HTTPError as e:
            last_error = f"HTTP {e.response.status_code}"
            if e.response.status_code in (403, 429, 404):
                break
        except requests.exceptions.ConnectionError as e:
            last_error = f"Conexão falhou"
        except Exception as e:
            last_error = str(e)
            break
    return None, last_error


def extrair_corpo_lei(html_text):
    """
    Extrai apenas o corpo da lei (texto dos artigos) de uma página do Planalto,
    removendo menus, headers, footers e scripts.
    Retorna o texto limpo normalizado.
    """
    soup = BeautifulSoup(html_text, "html.parser")

    # Remover scripts, styles, nav, footer
    for tag in soup.find_all(["script", "style", "nav", "footer", "header", "noscript"]):
        tag.decompose()

    # O Planalto usa <div id="texto"> ou <div class="textoNorma"> ou <p> dentro do body
    corpo = None
    for sel in ["#texto", ".textoNorma", "#conteudoNorma", "article", ".DivNorma"]:
        corpo = soup.select_one(sel)
        if corpo:
            break

    if not corpo:
        corpo = soup.find("body") or soup

    # Extrair texto limpo
    texto = corpo.get_text(separator="\n", strip=True)

    # Normalizar: remover espaços extras, linhas em branco
    linhas = [l.strip() for l in texto.split("\n") if l.strip()]
    texto_normalizado = "\n".join(linhas)

    return texto_normalizado


def calcular_hash(texto):
    """Calcula SHA-256 do texto normalizado."""
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def detectar_alteracoes(texto_antigo, texto_novo):
    """
    Compara dois textos de lei e identifica diferenças.
    Retorna lista de alterações encontradas.
    """
    if not texto_antigo or not texto_novo:
        return [{"tipo": "INDISPONÍVEL", "detalhe": "Não foi possível comparar (texto anterior ou atual ausente)"}]

    linhas_antigas = set(texto_antigo.split("\n"))
    linhas_novas = set(texto_novo.split("\n"))

    adicionadas = linhas_novas - linhas_antigas
    removidas = linhas_antigas - linhas_novas

    alteracoes = []

    # Filtrar linhas significativas (artigos, parágrafos, etc.)
    re_dispositivo = re.compile(
        r"^(?:Art\.\s*\d+|§\s*\d+|Parágrafo único|[IVXLCDM]+\s*[\-–—]|[a-z]\))",
        re.IGNORECASE
    )

    for linha in sorted(adicionadas):
        if re_dispositivo.match(linha) or len(linha) > 30:
            alteracoes.append({
                "tipo": "ADICIONADO",
                "detalhe": linha[:300]
            })

    for linha in sorted(removidas):
        if re_dispositivo.match(linha) or len(linha) > 30:
            alteracoes.append({
                "tipo": "REMOVIDO",
                "detalhe": linha[:300]
            })

    # Se muitas alterações, resumir
    if len(alteracoes) > 50:
        total = len(alteracoes)
        alteracoes = alteracoes[:20]
        alteracoes.append({
            "tipo": "RESUMO",
            "detalhe": f"... e mais {total - 20} alterações detectadas. Verifique a lei completa."
        })

    return alteracoes


# ── Execução principal ───────────────────────────────────────
def main():
    log(f"═══ TERA Monitorar Leis — {AGORA.strftime('%d/%m/%Y %H:%M')} BRT ═══")

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Carregar lista de leis monitoradas
    if not LEIS_FILE.exists():
        log("Nenhuma lei monitorada encontrada. Criando arquivo modelo...")
        modelo = {
            "descricao": "Lista de leis monitoradas pelo TERA. Adicione leis com nome, URL e o hash será preenchido automaticamente.",
            "leis": [
                {
                    "nome": "IN RFB nº 2.121/2022",
                    "url": "https://normasinternet2.receita.fazenda.gov.br/normasinternet/consulta.html?numero=2121&tipo=IN&ano=2022",
                    "hash_anterior": "",
                    "ultima_verificacao": "",
                    "status": "novo"
                }
            ]
        }
        with open(LEIS_FILE, "w", encoding="utf-8") as f:
            json.dump(modelo, f, ensure_ascii=False, indent=2)
        log(f"Arquivo modelo criado em {LEIS_FILE}")
        log("Adicione as leis que deseja monitorar e execute novamente.")
        return

    try:
        with open(LEIS_FILE, "r", encoding="utf-8") as f:
            dados = json.load(f)
    except Exception as e:
        log(f"✗ Erro ao ler {LEIS_FILE}: {e}")
        return

    leis = dados.get("leis", [])
    if not leis:
        log("Nenhuma lei na lista de monitoramento.")
        return

    log(f"{len(leis)} lei(s) monitorada(s)")

    # Carregar histórico de monitoramento
    historico = []
    if SAIDA.exists():
        try:
            with open(SAIDA, "r", encoding="utf-8") as f:
                hist_data = json.load(f)
                historico = hist_data.get("verificacoes", [])
        except Exception:
            pass

    # Verificar cada lei
    alteracoes_detectadas = []

    for lei in leis:
        nome = lei.get("nome", "Sem nome")
        url = lei.get("url", "")
        hash_anterior = lei.get("hash_anterior", "")

        if not url:
            log(f"  ⚠ {nome}: URL não configurada, pulando")
            continue

        log(f"  Verificando: {nome}...")

        html, erro = fetch_text(url)
        if erro:
            log(f"    ✗ Erro: {erro}")
            lei["ultima_verificacao"] = DATA_HOJE
            lei["status"] = f"erro: {erro}"
            continue

        # Extrair corpo e calcular hash
        texto = extrair_corpo_lei(html)
        hash_atual = calcular_hash(texto)

        lei["ultima_verificacao"] = DATA_HOJE

        if not hash_anterior:
            # Primeira verificação — apenas registrar o hash
            lei["hash_anterior"] = hash_atual
            lei["status"] = "baseline registrado"
            log(f"    ℹ Primeira verificação — baseline registrado (hash: {hash_atual[:12]}...)")
        elif hash_atual == hash_anterior:
            lei["status"] = "sem alteração"
            log(f"    ✓ Sem alteração detectada")
        else:
            # ALTERAÇÃO DETECTADA
            lei["status"] = f"ALTERAÇÃO DETECTADA em {DATA_HOJE}"
            lei["hash_anterior"] = hash_atual  # Atualiza para próxima comparação

            # Tentar detectar o que mudou
            # Para isso, precisaríamos do texto anterior salvo
            # Como só temos o hash, registramos que houve mudança
            log(f"    ⚠ ALTERAÇÃO DETECTADA! Hash anterior: {hash_anterior[:12]}... → Novo: {hash_atual[:12]}...")

            alteracao = {
                "data": DATA_HOJE,
                "lei": nome,
                "url": url,
                "hash_anterior": hash_anterior[:16],
                "hash_novo": hash_atual[:16],
                "mensagem": f"A lei '{nome}' apresentou alterações no portal. Verifique as modificações."
            }
            alteracoes_detectadas.append(alteracao)

    # Salvar leis atualizadas
    with open(LEIS_FILE, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)

    # Adicionar ao histórico
    verificacao = {
        "data": AGORA.isoformat(),
        "leis_verificadas": len(leis),
        "alteracoes": len(alteracoes_detectadas),
        "detalhes": alteracoes_detectadas
    }
    historico.insert(0, verificacao)

    # Limitar histórico a 365 dias
    if len(historico) > 365:
        historico = historico[:365]

    saida = {
        "ultima_verificacao": AGORA.isoformat(),
        "total_leis": len(leis),
        "alteracoes_pendentes": len(alteracoes_detectadas),
        "verificacoes": historico
    }

    with open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, indent=2)

    # Relatório
    log("")
    log("═══ RELATÓRIO ═══")
    log(f"  Leis verificadas: {len(leis)}")
    log(f"  Alterações detectadas: {len(alteracoes_detectadas)}")
    if alteracoes_detectadas:
        for alt in alteracoes_detectadas:
            log(f"    ⚠ {alt['lei']}: {alt['mensagem']}")
    else:
        log("  ✓ Nenhuma alteração detectada hoje")
    log("═══ Concluído ═══")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"ERRO FATAL: {e}")
        traceback.print_exc()
        sys.exit(1)
