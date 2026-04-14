#!/usr/bin/env python3
"""
TERA — Monitorar Leis (v1.1)
Script para verificar diariamente se as leis monitoradas sofreram alterações
no portal do Planalto ou em outras fontes oficiais.

Executado via GitHub Actions diariamente às 08:00 BRT.

Fluxo:
  1. Lê data/leis_monitoradas.json (lista de leis com URL e hash anterior)
  2. Para cada lei, faz GET na URL e calcula hash do conteúdo
  3. Se hash diferente → detectou alteração → registra diff
  4. Salva resultado em data/monitoramento.json
  5. Se houver alterações, envia email de notificação

Saída: data/monitoramento.json

Changelog v1.1:
  - Adicionado envio de email de alerta via SMTP (Gmail) quando alterações
    são detectadas em leis monitoradas.
  - Credenciais via variáveis de ambiente: GMAIL_USER, GMAIL_APP_PASSWORD.
  - Destinatário: tectributos.federal11@gmail.com
"""

import json
import hashlib
import os
import re
import smtplib
import sys
import traceback
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
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

# ── Configurações de Email ───────────────────────────────────
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587
EMAIL_DESTINATARIO = "tectributos.federal11@gmail.com"


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
        r"^(?:Art\.\s*\d+|§\s*\d+|Parágrafo único|[IVXLCDM]+\s*[\--—]|[a-z]\))",
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


# ── Envio de Email de Alerta ─────────────────────────────────
def enviar_email_alerta(alteracoes_detectadas):
    """
    Envia email de alerta quando alterações são detectadas em leis monitoradas.
    Usa SMTP Gmail com credenciais via variáveis de ambiente.
    Retorna True em sucesso, False em falha (nunca interrompe a execução).
    """
    gmail_user = os.environ.get("GMAIL_USER", "").strip()
    gmail_password = os.environ.get("GMAIL_APP_PASSWORD", "").strip()

    if not gmail_user or not gmail_password:
        log("  ⚠ Email não enviado: GMAIL_USER e/ou GMAIL_APP_PASSWORD não configurados.")
        log("    Configure os secrets no repositório GitHub para ativar notificações por email.")
        return False

    if not alteracoes_detectadas:
        return False

    try:
        # Construir corpo HTML do email
        hora_brt = AGORA.strftime("%d/%m/%Y às %H:%M")
        qtd = len(alteracoes_detectadas)

        linhas_leis = ""
        for alt in alteracoes_detectadas:
            lei_nome = alt.get("lei", "Lei desconhecida")
            lei_url = alt.get("url", "")
            mensagem = alt.get("mensagem", "")
            hash_ant = alt.get("hash_anterior", "")
            hash_novo = alt.get("hash_novo", "")

            link_html = ""
            if lei_url:
                link_html = (
                    f'<a href="{lei_url}" '
                    f'style="color:#B8965A;text-decoration:underline;font-size:13px;">'
                    f'Verificar no portal →</a>'
                )

            linhas_leis += f"""
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #e0dcd4;">
                <div style="font-weight:700;font-size:15px;color:#1a1a1a;margin-bottom:4px;">
                  ⚠️ {lei_nome}
                </div>
                <div style="font-size:13px;color:#555;margin-bottom:6px;">
                  {mensagem}
                </div>
                <div style="font-size:11px;color:#888;margin-bottom:6px;">
                  Hash anterior: <code>{hash_ant}</code> → Novo: <code>{hash_novo}</code>
                </div>
                {link_html}
              </td>
            </tr>
            """

        html_body = f"""
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#f0ede6;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:20px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#a17c2f,#c9a23d);padding:24px 30px;text-align:center;">
      <div style="font-size:24px;font-weight:800;color:#ffffff;letter-spacing:2px;">TERA</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.85);letter-spacing:1px;margin-top:2px;">MONITORAMENTO DE LEIS</div>
    </div>

    <!-- Corpo -->
    <div style="padding:24px 30px;">
      <p style="font-size:15px;color:#1a1a1a;line-height:1.6;margin:0 0 16px;">
        Bom dia,
      </p>
      <p style="font-size:15px;color:#1a1a1a;line-height:1.6;margin:0 0 16px;">
        O monitoramento automático do TERA detectou <strong style="color:#c0392b;">{qtd} alteração(ões)</strong>
        em lei(s) monitorada(s) na verificação de <strong>{hora_brt} (BRT)</strong>.
      </p>

      <!-- Tabela de alterações -->
      <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#faf7f2;border-radius:8px;overflow:hidden;border:1px solid #e0dcd4;">
        <thead>
          <tr>
            <th style="padding:10px 16px;background:#a17c2f;color:#ffffff;text-align:left;font-size:13px;font-weight:600;">
              Leis com alteração detectada
            </th>
          </tr>
        </thead>
        <tbody>
          {linhas_leis}
        </tbody>
      </table>

      <p style="font-size:13px;color:#666;line-height:1.6;margin:16px 0 0;">
        <strong>Ação recomendada:</strong> verifique as alterações nos portais oficiais e atualize
        os estudos e consultas relacionados.
      </p>

      <p style="font-size:11px;color:#999;line-height:1.5;margin:20px 0 0;border-top:1px solid #e0dcd4;padding-top:16px;">
        Este é um email automático do sistema TERA — Raciocínio Jurídico.<br>
        Monitoramento executado em {hora_brt} (BRT).<br>
        Repositório: naytributario.github.io/TERA-LEI
      </p>
    </div>

  </div>
</body>
</html>
"""

        # Construir mensagem MIME
        msg = MIMEMultipart("alternative")
        msg["From"] = gmail_user
        msg["To"] = EMAIL_DESTINATARIO
        msg["Subject"] = f"⚠️ TERA — {qtd} alteração(ões) detectada(s) em lei(s) monitorada(s) — {hora_brt}"

        # Versão texto plano (fallback)
        texto_plano = f"TERA — Monitoramento de Leis\n\n"
        texto_plano += f"Verificação: {hora_brt} (BRT)\n"
        texto_plano += f"Alterações detectadas: {qtd}\n\n"
        for alt in alteracoes_detectadas:
            texto_plano += f"⚠ {alt.get('lei', 'Lei desconhecida')}\n"
            texto_plano += f"  {alt.get('mensagem', '')}\n"
            texto_plano += f"  Hash: {alt.get('hash_anterior', '')} → {alt.get('hash_novo', '')}\n"
            if alt.get("url"):
                texto_plano += f"  Link: {alt['url']}\n"
            texto_plano += "\n"
        texto_plano += "---\nEmail automático do TERA — naytributario.github.io/TERA-LEI\n"

        msg.attach(MIMEText(texto_plano, "plain", "utf-8"))
        msg.attach(MIMEText(html_body, "html", "utf-8"))

        # Enviar via SMTP
        log(f"  Enviando email de alerta para {EMAIL_DESTINATARIO}...")
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(gmail_user, gmail_password)
            server.sendmail(gmail_user, EMAIL_DESTINATARIO, msg.as_string())

        log(f"  ✓ Email de alerta enviado com sucesso para {EMAIL_DESTINATARIO}")
        return True

    except smtplib.SMTPAuthenticationError as e:
        log(f"  ✗ Falha na autenticação SMTP: {e}")
        log("    Verifique se GMAIL_APP_PASSWORD é uma senha de app válida.")
        return False
    except smtplib.SMTPException as e:
        log(f"  ✗ Erro SMTP ao enviar email: {e}")
        return False
    except Exception as e:
        log(f"  ✗ Erro inesperado ao enviar email: {e}")
        traceback.print_exc()
        return False


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

    # ── Enviar email de alerta se houver alterações ──────────
    if alteracoes_detectadas:
        enviar_email_alerta(alteracoes_detectadas)

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
