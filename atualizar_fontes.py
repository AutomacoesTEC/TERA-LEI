#!/usr/bin/env python3
"""
TERA — Atualizar Fontes (v2.0)
Script para coleta automática de atualizações tributárias de fontes oficiais.
Executado via GitHub Actions diariamente às 09:00 (horário de Brasília).

Regras de Negócio:
  - Coleta SOMENTE publicações do dia corrente
  - Se não houver publicação nova no dia, não insere nada
  - Histórico acumulativo (limpeza apenas manual pelo usuário)
  - Cada fonte tem scraper dedicado com tratamento de erros isolado
  - Uma fonte falhando NÃO impede as demais

Fontes:
  1. AgênciaGov — Receita Federal
  2. AgênciaGov — Planalto
  3. AgênciaGov — Justiça
  4. AgênciaGov — Economia
  5. AgênciaGov — Comunicações
  6. CFC Notícias
  7. Jota Info (marcação premium)
  8. Ministério da Fazenda — Notícias
  9. RFB Reforma do Consumo
  10. Portal NFe — Notas Técnicas (somente)

Saída: data/atualizacoes.json
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
DATA_HOJE_BR = AGORA.strftime("%d/%m/%Y")
TIMEOUT = 30
MAX_RETRIES = 2
HEADERS = {
    "User-Agent": "TERA-LegalMonitor/2.0 (naytributario.github.io/TERA-LEI; educational)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5",
}
DATA_DIR = Path("data")
SAIDA = DATA_DIR / "atualizacoes.json"

# Estatísticas de execução
STATS = {
    "fontes_ok": [],
    "fontes_erro": [],
    "total_novos": 0,
}


def log(msg):
    """Log com timestamp BRT."""
    print(f"[{datetime.now(BRT).strftime('%H:%M:%S')}] {msg}")


def item_id(link, titulo):
    """Gera um ID único determinístico para evitar duplicatas."""
    raw = (link or "").strip() + "|" + (titulo or "").strip()
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def fetch_page(url, custom_headers=None):
    """
    Faz GET com retry e tratamento de erros robusto.
    Retorna (BeautifulSoup, None) em sucesso ou (None, str_erro) em falha.
    """
    headers = {**HEADERS, **(custom_headers or {})}
    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = requests.get(url, headers=headers, timeout=TIMEOUT)
            r.raise_for_status()
            r.encoding = r.apparent_encoding or "utf-8"
            return BeautifulSoup(r.text, "html.parser"), None
        except requests.exceptions.Timeout:
            last_error = f"Timeout após {TIMEOUT}s (tentativa {attempt}/{MAX_RETRIES})"
            log(f"    ⏱ {last_error}")
        except requests.exceptions.HTTPError as e:
            last_error = f"HTTP {e.response.status_code} (tentativa {attempt}/{MAX_RETRIES})"
            log(f"    ⚠ {last_error}")
            if e.response.status_code in (403, 429):
                break  # Não retentar em bloqueio
        except requests.exceptions.ConnectionError as e:
            last_error = f"Conexão falhou: {e} (tentativa {attempt}/{MAX_RETRIES})"
            log(f"    ✗ {last_error}")
        except Exception as e:
            last_error = f"Erro inesperado: {e}"
            log(f"    ✗ {last_error}")
            break

    return None, last_error


def extrair_data_texto(texto):
    """
    Extrai data no formato YYYY-MM-DD de um texto brasileiro.
    Suporta: DD/MM/YYYY, DD de mês de YYYY, YYYY-MM-DD
    Retorna None se não encontrar.
    """
    if not texto:
        return None

    # Formato DD/MM/YYYY
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", texto)
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"

    # Formato YYYY-MM-DD (ISO)
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", texto)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"

    # Formato YYYY/MM/DD em URL paths
    m = re.search(r"/(\d{4})/(\d{2})/(\d{2})/", texto)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"

    # Formato "DD de mês de YYYY"
    meses = {
        "janeiro": "01", "fevereiro": "02", "março": "03", "marco": "03",
        "abril": "04", "maio": "05", "junho": "06", "julho": "07",
        "agosto": "08", "setembro": "09", "outubro": "10",
        "novembro": "11", "dezembro": "12"
    }
    m = re.search(
        r"(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})", texto, re.IGNORECASE
    )
    if m:
        dia = m.group(1).zfill(2)
        mes = meses.get(m.group(2).lower())
        ano = m.group(3)
        if mes:
            return f"{ano}-{mes}-{dia}"

    return None


def e_data_hoje(data_str):
    """Verifica se a data extraída corresponde ao dia corrente."""
    return data_str == DATA_HOJE


def criar_item(titulo, link, portal, data=None, resumo="", premium=False):
    """
    Cria um item padronizado. Retorna None se a data não for hoje.
    """
    # Limpar título
    titulo = (titulo or "").strip()
    if not titulo or len(titulo) < 8:
        return None

    # Limpar link
    link = (link or "").strip()
    if not link or "javascript:" in link.lower():
        return None

    # Verificar data
    data_item = data or DATA_HOJE
    if not e_data_hoje(data_item):
        return None

    item = {
        "id": item_id(link, titulo),
        "data": data_item,
        "titulo": titulo[:500],
        "portal": portal,
        "link": link,
        "resumo": (resumo or "").strip()[:800],
    }
    if premium:
        item["premium"] = True

    return item


# ── Fonte 1-5: AgênciaGov (5 editorias) ─────────────────────
def scrape_agenciagov(editoria, portal_nome):
    """
    Coleta notícias da AgênciaGov EBC.
    Estrutura: cards com data, título e link.
    URL padrão: https://agenciagov.ebc.com.br/noticias/{editoria}
    """
    url = f"https://agenciagov.ebc.com.br/noticias/{editoria}"
    itens = []

    log(f"Buscando AgênciaGov — {portal_nome}...")
    soup, erro = fetch_page(url)
    if erro:
        log(f"  ✗ Falha: {erro}")
        STATS["fontes_erro"].append(f"AgênciaGov {portal_nome}: {erro}")
        return itens

    try:
        # AgênciaGov usa cards/artigos com links
        # Seletores comuns: article, .news-item, .card, .item-lista
        articles = soup.select(
            "article, .news-item, .card-news, .item-lista, "
            ".listagem-item, .noticias-lista li, .resultado-busca"
        )

        # Fallback: buscar no conteúdo principal
        if not articles:
            main = soup.select_one("main, #content, .content-area, .main-content")
            if main:
                articles = main.find_all(["article", "div", "li"], recursive=True)

        seen = set()
        for art in articles:
            a_tag = art.find("a", href=True)
            if not a_tag:
                continue

            href = a_tag.get("href", "").strip()
            titulo = a_tag.get_text(strip=True)

            # Resolver URLs relativas
            if href.startswith("/"):
                href = "https://agenciagov.ebc.com.br" + href
            if not href.startswith("http"):
                continue
            if href in seen:
                continue
            seen.add(href)

            # Extrair data do artigo
            data = None
            # Buscar em elementos de data comuns
            for sel in [".date", ".data", "time", ".publicado", "span.date",
                        ".meta-date", ".card-date"]:
                el = art.select_one(sel)
                if el:
                    data = extrair_data_texto(el.get_text())
                    if data:
                        break

            # Fallback: data no atributo datetime
            if not data:
                time_el = art.find("time")
                if time_el and time_el.get("datetime"):
                    data = extrair_data_texto(time_el["datetime"])

            # Fallback: data na URL
            if not data:
                data = extrair_data_texto(href)

            # Extrair resumo
            resumo = ""
            for sel in [".resumo", ".descricao", ".excerpt", "p"]:
                el = art.select_one(sel)
                if el and el != a_tag:
                    resumo = el.get_text(strip=True)
                    if resumo and len(resumo) > 20:
                        break
                    resumo = ""

            item = criar_item(titulo, href, portal_nome, data, resumo)
            if item:
                itens.append(item)

        log(f"  → {len(itens)} publicações de hoje encontradas")
        STATS["fontes_ok"].append(f"AgênciaGov {portal_nome}")

    except Exception as e:
        log(f"  ✗ Erro no parsing: {e}")
        STATS["fontes_erro"].append(f"AgênciaGov {portal_nome}: parsing - {e}")

    return itens


# ── Fonte 6: CFC Notícias ────────────────────────────────────
def scrape_cfc():
    """
    Coleta notícias do Conselho Federal de Contabilidade.
    URL: https://cfc.org.br/noticias/
    Estrutura WordPress padrão.
    """
    url = "https://cfc.org.br/noticias/"
    itens = []

    log("Buscando CFC Notícias...")
    soup, erro = fetch_page(url)
    if erro:
        log(f"  ✗ Falha: {erro}")
        STATS["fontes_erro"].append(f"CFC: {erro}")
        return itens

    try:
        # WordPress: posts em article ou .post
        articles = soup.select(
            "article, .post, .entry, .news-item, .type-post, .hentry"
        )

        # Fallback
        if not articles:
            main = soup.select_one("main, #main, .site-main, .content-area")
            if main:
                articles = main.find_all("article")

        seen = set()
        for art in articles:
            # Título e link
            a_tag = art.select_one("h2 a, h3 a, .entry-title a, .post-title a, a.title")
            if not a_tag:
                a_tag = art.find("a", href=True)
            if not a_tag:
                continue

            href = a_tag.get("href", "").strip()
            titulo = a_tag.get_text(strip=True)

            if not href.startswith("http"):
                if href.startswith("/"):
                    href = "https://cfc.org.br" + href
                else:
                    continue

            if href in seen:
                continue
            seen.add(href)

            # Data
            data = None
            for sel in ["time", ".date", ".entry-date", ".post-date",
                        ".published", "span.date"]:
                el = art.select_one(sel)
                if el:
                    dt_attr = el.get("datetime", "")
                    data = extrair_data_texto(dt_attr) or extrair_data_texto(el.get_text())
                    if data:
                        break

            # Resumo
            resumo = ""
            for sel in [".entry-summary", ".excerpt", ".entry-content p", "p"]:
                el = art.select_one(sel)
                if el:
                    resumo = el.get_text(strip=True)
                    if resumo and len(resumo) > 20:
                        break
                    resumo = ""

            item = criar_item(titulo, href, "CFC", data, resumo)
            if item:
                itens.append(item)

        log(f"  → {len(itens)} publicações de hoje encontradas")
        STATS["fontes_ok"].append("CFC")

    except Exception as e:
        log(f"  ✗ Erro no parsing: {e}")
        STATS["fontes_erro"].append(f"CFC: parsing - {e}")

    return itens


# ── Fonte 7: Jota Info ───────────────────────────────────────
def scrape_jota():
    """
    Coleta notícias do Jota.info.
    Publicações premium são marcadas com flag premium=True.
    """
    url = "https://www.jota.info/"
    itens = []

    log("Buscando Jota Info...")
    soup, erro = fetch_page(url)
    if erro:
        log(f"  ✗ Falha: {erro}")
        STATS["fontes_erro"].append(f"Jota: {erro}")
        return itens

    try:
        # Jota usa cards de notícia
        articles = soup.select(
            "article, .post-card, .news-card, .card, .entry, "
            ".jota-post, .list-item, .feed-item"
        )

        if not articles:
            main = soup.select_one("main, #content, .site-content")
            if main:
                articles = main.find_all(["article", "div"], class_=True)

        seen = set()
        for art in articles:
            a_tag = art.select_one("h2 a, h3 a, h4 a, .title a, a.post-link")
            if not a_tag:
                a_tag = art.find("a", href=True)
            if not a_tag:
                continue

            href = a_tag.get("href", "").strip()
            titulo = a_tag.get_text(strip=True)

            if not href.startswith("http"):
                if href.startswith("/"):
                    href = "https://www.jota.info" + href
                else:
                    continue

            if href in seen:
                continue
            seen.add(href)

            # Filtrar links genéricos de navegação
            if any(x in href.lower() for x in [
                "/autor/", "/tag/", "/categoria/", "/page/",
                "#", "/login", "/assine", "/sobre"
            ]):
                continue

            # Data
            data = None
            for sel in ["time", ".date", ".post-date", ".meta-date", "span.date"]:
                el = art.select_one(sel)
                if el:
                    dt_attr = el.get("datetime", "")
                    data = extrair_data_texto(dt_attr) or extrair_data_texto(el.get_text())
                    if data:
                        break

            # Detectar premium
            premium = False
            premium_indicators = art.select(
                ".premium, .pro, .paywall, .subscriber-only, "
                ".locked, .jota-pro, .badge-pro"
            )
            if premium_indicators:
                premium = True
            # Verificar texto/classes do artigo
            art_classes = " ".join(art.get("class", []))
            if any(p in art_classes.lower() for p in ["premium", "pro", "paywall"]):
                premium = True

            # Resumo
            resumo = ""
            for sel in [".excerpt", ".summary", ".description", "p"]:
                el = art.select_one(sel)
                if el:
                    resumo = el.get_text(strip=True)
                    if resumo and len(resumo) > 20:
                        break
                    resumo = ""

            item = criar_item(titulo, href, "Jota Info", data, resumo, premium=premium)
            if item:
                itens.append(item)

        log(f"  → {len(itens)} publicações de hoje encontradas")
        STATS["fontes_ok"].append("Jota Info")

    except Exception as e:
        log(f"  ✗ Erro no parsing: {e}")
        STATS["fontes_erro"].append(f"Jota: parsing - {e}")

    return itens


# ── Fonte 8: Ministério da Fazenda ───────────────────────────
def scrape_fazenda():
    """
    Coleta notícias do portal do Ministério da Fazenda.
    URL: https://www.gov.br/fazenda/pt-br/assuntos/noticias
    Estrutura: portal gov.br padrão.
    """
    url = "https://www.gov.br/fazenda/pt-br/assuntos/noticias"
    itens = []

    log("Buscando Ministério da Fazenda...")
    soup, erro = fetch_page(url)
    if erro:
        log(f"  ✗ Falha: {erro}")
        STATS["fontes_erro"].append(f"Fazenda: {erro}")
        return itens

    try:
        itens = _scrape_gov_br(soup, url, "Min. Fazenda")
        log(f"  → {len(itens)} publicações de hoje encontradas")
        STATS["fontes_ok"].append("Min. Fazenda")
    except Exception as e:
        log(f"  ✗ Erro no parsing: {e}")
        STATS["fontes_erro"].append(f"Fazenda: parsing - {e}")

    return itens


# ── Fonte 9: RFB Reforma do Consumo ──────────────────────────
def scrape_rfb_reforma():
    """
    Coleta notícias da página de Reforma do Consumo da RFB.
    """
    url = (
        "https://www.gov.br/receitafederal/pt-br/acesso-a-informacao/"
        "acoes-e-programas/programas-e-atividades/reforma-consumo/noticias"
    )
    itens = []

    log("Buscando RFB Reforma do Consumo...")
    soup, erro = fetch_page(url)
    if erro:
        log(f"  ✗ Falha: {erro}")
        STATS["fontes_erro"].append(f"RFB Reforma: {erro}")
        return itens

    try:
        itens = _scrape_gov_br(soup, url, "RFB Reforma")
        log(f"  → {len(itens)} publicações de hoje encontradas")
        STATS["fontes_ok"].append("RFB Reforma")
    except Exception as e:
        log(f"  ✗ Erro no parsing: {e}")
        STATS["fontes_erro"].append(f"RFB Reforma: parsing - {e}")

    return itens


def _scrape_gov_br(soup, base_url, portal_nome):
    """
    Parser reutilizável para portais gov.br (Fazenda, RFB, etc).
    Estrutura padrão: tiles/listagem com links, datas e resumos.
    Extrai data de múltiplos padrões incluindo texto inline "DD/MM/YYYY -".
    """
    itens = []

    # Seletores gov.br (ampliados para cobrir mais layouts)
    articles = soup.select(
        "article, .noticias a, .tileItem, .tile-content, "
        ".listagem-item, ul.noticias li, .item, "
        ".noticias-lista li, .lista-noticias li, "
        ".row .item, .news-item, .resultado"
    )

    # Fallback: buscar no conteúdo principal
    if not articles:
        content = soup.select_one("#content, #main-content, .content-area, main")
        if content:
            articles = content.find_all(["article", "li", "div"], recursive=True)

    seen = set()
    for art in articles:
        a_tag = art if art.name == "a" else art.find("a", href=True)
        if not a_tag:
            continue

        href = a_tag.get("href", "").strip()
        titulo = a_tag.get_text(strip=True)

        # Resolver URL
        if href.startswith("/"):
            href = "https://www.gov.br" + href
        if not href.startswith("http"):
            continue
        if href in seen:
            continue

        # Filtrar links genéricos (menus, âncoras)
        if len(titulo) < 15:
            continue
        if any(x in href.lower() for x in ["#", "javascript:", "/login", "/acesso"]):
            continue

        seen.add(href)

        # Data — buscar em múltiplas fontes
        data = None

        # 1. Elementos de data semânticos
        parent = a_tag.find_parent(["li", "article", "div"])
        if parent:
            for sel in [".date", ".data", "time", "span.publicado",
                        ".meta-date", ".tileDate", ".data-publicacao",
                        "span.text-muted"]:
                el = parent.select_one(sel)
                if el:
                    data = extrair_data_texto(el.get_text())
                    if data:
                        break

        # 2. Texto inline do parent (formato "DD/MM/YYYY -" comum no gov.br)
        if not data and parent:
            parent_text = parent.get_text()
            data = extrair_data_texto(parent_text)

        # 3. Data na URL (formato /YYYY/MM/DD/)
        if not data:
            data = extrair_data_texto(href)

        # Resumo
        resumo = ""
        if parent:
            for sel in [".descricao", ".description", ".resumo", "p", ".excerpt"]:
                el = parent.select_one(sel)
                if el and el != a_tag:
                    resumo = el.get_text(strip=True)
                    if len(resumo) > 20:
                        break
                    resumo = ""

        item = criar_item(titulo, href, portal_nome, data, resumo)
        if item:
            itens.append(item)

    return itens


# ── Fonte 10b: RFB Notícias Gerais ──────────────────────────
def scrape_rfb_noticias():
    """
    Coleta notícias gerais da Receita Federal.
    URL: https://www.gov.br/receitafederal/pt-br/assuntos/noticias
    Diferente da página de Reforma do Consumo.
    """
    url = "https://www.gov.br/receitafederal/pt-br/assuntos/noticias"
    itens = []

    log("Buscando RFB Notícias Gerais...")
    soup, erro = fetch_page(url)
    if erro:
        log(f"  ✗ Falha: {erro}")
        STATS["fontes_erro"].append(f"RFB Notícias: {erro}")
        return itens

    try:
        itens = _scrape_gov_br(soup, url, "RFB Notícias")
        log(f"  → {len(itens)} publicações de hoje encontradas")
        STATS["fontes_ok"].append("RFB Notícias")
    except Exception as e:
        log(f"  ✗ Erro no parsing: {e}")
        STATS["fontes_erro"].append(f"RFB Notícias: parsing - {e}")

    return itens

    return itens


# ── Fonte 10: Portal NFe — Somente Notas Técnicas ───────────
def scrape_nfe_notas_tecnicas():
    """
    Coleta SOMENTE Notas Técnicas do portal NFe/NFCe.
    Filtro rigoroso: apenas links que apontem para exibirArquivo.aspx
    e cujo título contenha "Nota Técnica".
    """
    url = "https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY="
    itens = []

    log("Buscando NFe — Notas Técnicas...")
    soup, erro = fetch_page(url)
    if erro:
        log(f"  ✗ Falha: {erro}")
        STATS["fontes_erro"].append(f"NFe NT: {erro}")
        return itens

    try:
        # Buscar todos os links da página
        all_links = soup.find_all("a", href=True)

        # Padrão de Nota Técnica real
        nt_pattern = re.compile(r"Nota\s+T[eé]cnica", re.IGNORECASE)
        arquivo_pattern = re.compile(r"exibirArquivo\.aspx", re.IGNORECASE)

        seen = set()
        for a in all_links:
            href = a.get("href", "").strip()
            titulo = a.get_text(strip=True)

            # FILTRO RIGOROSO 1: título deve conter "Nota Técnica"
            if not nt_pattern.search(titulo):
                continue

            # FILTRO RIGOROSO 2: link deve apontar para exibirArquivo.aspx
            if not arquivo_pattern.search(href):
                continue

            # Resolver URL relativa
            if href.startswith("/"):
                href = "https://www.nfe.fazenda.gov.br" + href
            elif not href.startswith("http"):
                href = "https://www.nfe.fazenda.gov.br/portal/" + href

            if href in seen:
                continue
            seen.add(href)

            # Extrair data de publicação do título
            # Formato: "Nota Técnica 2024.003 v.1.09 - Publicada em 11/03/2026"
            data = None
            pub_match = re.search(
                r"[Pp]ublicada\s+em\s+(\d{2}/\d{2}/\d{4})", titulo
            )
            if pub_match:
                data = extrair_data_texto(pub_match.group(1))

            # Fallback: buscar data no elemento pai (tabela)
            if not data:
                parent = a.find_parent(["tr", "li", "div"])
                if parent:
                    tds = parent.find_all("td")
                    for td in tds:
                        data = extrair_data_texto(td.get_text())
                        if data:
                            break

            item = criar_item(titulo, href, "NFe/NFCe", data)
            if item:
                itens.append(item)

        log(f"  → {len(itens)} Notas Técnicas de hoje encontradas")
        STATS["fontes_ok"].append("NFe/NFCe")

    except Exception as e:
        log(f"  ✗ Erro no parsing: {e}")
        STATS["fontes_erro"].append(f"NFe NT: parsing - {e}")

    return itens


# ── Deduplicação ─────────────────────────────────────────────
def deduplicar(itens):
    """Remove duplicatas por ID, preservando a primeira ocorrência."""
    seen = set()
    unicos = []
    for item in itens:
        if item["id"] not in seen:
            seen.add(item["id"])
            unicos.append(item)
    return unicos


# ── Execução principal ───────────────────────────────────────
def main():
    log(f"═══ TERA Atualizar Fontes v2.0 — {AGORA.strftime('%d/%m/%Y %H:%M')} BRT ═══")
    log(f"Data alvo: {DATA_HOJE} ({DATA_HOJE_BR})")
    log("")

    # Garante que o diretório data/ existe
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Carrega histórico existente
    historico = []
    if SAIDA.exists():
        try:
            with open(SAIDA, "r", encoding="utf-8") as f:
                dados = json.load(f)
                historico = dados.get("itens", [])
                log(f"Histórico carregado: {len(historico)} itens existentes")
        except (json.JSONDecodeError, KeyError) as e:
            log(f"⚠ Erro ao carregar histórico (será recriado): {e}")
        except Exception as e:
            log(f"⚠ Erro inesperado ao carregar histórico: {e}")

    # ── Coleta de todas as fontes ────────────────────────────
    novos = []

    # AgênciaGov (5 editorias)
    agencia_editorias = [
        ("receita-federal", "AgênciaGov — Receita Federal"),
        ("planalto", "AgênciaGov — Planalto"),
        ("justica", "AgênciaGov — Justiça"),
        ("economia", "AgênciaGov — Economia"),
        ("comunicacoes", "AgênciaGov — Comunicações"),
    ]
    for editoria, nome in agencia_editorias:
        try:
            novos.extend(scrape_agenciagov(editoria, nome))
        except Exception as e:
            log(f"  ✗ Erro fatal em {nome}: {e}")
            STATS["fontes_erro"].append(f"{nome}: fatal - {e}")

    # CFC
    try:
        novos.extend(scrape_cfc())
    except Exception as e:
        log(f"  ✗ Erro fatal em CFC: {e}")
        STATS["fontes_erro"].append(f"CFC: fatal - {e}")

    # Jota
    try:
        novos.extend(scrape_jota())
    except Exception as e:
        log(f"  ✗ Erro fatal em Jota: {e}")
        STATS["fontes_erro"].append(f"Jota: fatal - {e}")

    # Fazenda
    try:
        novos.extend(scrape_fazenda())
    except Exception as e:
        log(f"  ✗ Erro fatal em Fazenda: {e}")
        STATS["fontes_erro"].append(f"Fazenda: fatal - {e}")

    # RFB Reforma
    try:
        novos.extend(scrape_rfb_reforma())
    except Exception as e:
        log(f"  ✗ Erro fatal em RFB Reforma: {e}")
        STATS["fontes_erro"].append(f"RFB Reforma: fatal - {e}")

    # RFB Notícias Gerais
    try:
        novos.extend(scrape_rfb_noticias())
    except Exception as e:
        log(f"  ✗ Erro fatal em RFB Notícias: {e}")
        STATS["fontes_erro"].append(f"RFB Notícias: fatal - {e}")

    # NFe Notas Técnicas
    try:
        novos.extend(scrape_nfe_notas_tecnicas())
    except Exception as e:
        log(f"  ✗ Erro fatal em NFe: {e}")
        STATS["fontes_erro"].append(f"NFe: fatal - {e}")

    # ── Deduplicar novos ─────────────────────────────────────
    novos = deduplicar(novos)
    log(f"\nTotal de publicações novas (hoje): {len(novos)}")

    # ── Mesclar com histórico ────────────────────────────────
    ids_existentes = {item["id"] for item in historico}
    adicionados = 0
    for item in novos:
        if item["id"] not in ids_existentes:
            historico.append(item)
            ids_existentes.add(item["id"])
            adicionados += 1

    STATS["total_novos"] = adicionados

    # Ordenar por data (mais recente primeiro)
    historico.sort(key=lambda x: x.get("data", ""), reverse=True)

    # ── Salvar ───────────────────────────────────────────────
    saida = {
        "ultima_atualizacao": AGORA.isoformat(),
        "data_busca": DATA_HOJE,
        "total": len(historico),
        "novos_nesta_execucao": adicionados,
        "fontes": [
            "https://agenciagov.ebc.com.br/noticias/receita-federal",
            "https://agenciagov.ebc.com.br/noticias/planalto",
            "https://agenciagov.ebc.com.br/noticias/justica",
            "https://agenciagov.ebc.com.br/noticias/economia",
            "https://agenciagov.ebc.com.br/noticias/comunicacoes",
            "https://cfc.org.br/noticias/",
            "https://www.jota.info/",
            "https://www.gov.br/fazenda/pt-br/assuntos/noticias",
            "https://www.gov.br/receitafederal/pt-br/acesso-a-informacao/acoes-e-programas/programas-e-atividades/reforma-consumo/noticias",
            "https://www.gov.br/receitafederal/pt-br/assuntos/noticias",
            "https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=",
        ],
        "stats": {
            "fontes_ok": STATS["fontes_ok"],
            "fontes_erro": STATS["fontes_erro"],
        },
        "itens": historico,
    }

    with open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, indent=2)

    # ── Relatório final ──────────────────────────────────────
    log("")
    log("═══ RELATÓRIO ═══")
    log(f"  Fontes consultadas com sucesso: {len(STATS['fontes_ok'])}")
    for f_ok in STATS["fontes_ok"]:
        log(f"    ✓ {f_ok}")
    if STATS["fontes_erro"]:
        log(f"  Fontes com erro: {len(STATS['fontes_erro'])}")
        for f_err in STATS["fontes_erro"]:
            log(f"    ✗ {f_err}")
    log(f"  Novos itens adicionados: {adicionados}")
    log(f"  Total no histórico: {len(historico)}")
    log(f"  Arquivo salvo em: {SAIDA}")
    log("═══ Concluído ═══")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"ERRO FATAL NA EXECUÇÃO: {e}")
        traceback.print_exc()
        sys.exit(1)
