#!/usr/bin/env python3
"""
TERA — Curadoria Semanal Tributária (v2.2)
==========================================
Correções para 100% de captura no GitHub Actions:
- STF: fallback SSL verify=False.
- Planalto: busca dinâmica por palavra-chave + data.
- SPED: novos seletores gov.br.
- CARF: retry estendido para erros 5xx.
"""

import json
import os
import re
import sys
import time
import random
import traceback
from datetime import datetime, timedelta, timezone, date
from pathlib import Path
from urllib.parse import urljoin, quote

try:
    import requests
    from bs4 import BeautifulSoup
    import feedparser
    import certifi
except ImportError:
    import subprocess
    subprocess.check_call([
        sys.executable, "-m", "pip", "install",
        "requests", "beautifulsoup4", "lxml", "feedparser", "certifi", "--quiet"
    ])
    import requests
    from bs4 import BeautifulSoup
    import feedparser
    import certifi

try:
    import cloudscraper
    CLOUDSCRAPER_AVAILABLE = True
except ImportError:
    CLOUDSCRAPER_AVAILABLE = False

import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURAÇÕES
# ─────────────────────────────────────────────────────────────────────────────
TIMEOUT = 60
MAX_RETRIES = 5
DATA_DIR = Path("data")
LOGS_DIR = Path("logs")
DATA_DIR.mkdir(exist_ok=True)
LOGS_DIR.mkdir(exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
}

session = requests.Session()
session.headers.update(HEADERS)

_cloudscraper_session = None

def get_cloudscraper():
    global _cloudscraper_session
    if _cloudscraper_session is None and CLOUDSCRAPER_AVAILABLE:
        _cloudscraper_session = cloudscraper.create_scraper(
            browser={'browser': 'chrome', 'platform': 'windows', 'mobile': False}
        )
        _cloudscraper_session.headers.update(HEADERS)
    return _cloudscraper_session

# ─────────────────────────────────────────────────────────────────────────────
# UTILITÁRIOS
# ─────────────────────────────────────────────────────────────────────────────
def log(msg: str):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

def calcular_periodo_semana() -> tuple[date, date]:
    env_inicio = os.environ.get("DATA_INICIO", "").strip()
    env_fim = os.environ.get("DATA_FIM", "").strip()
    if env_inicio and env_fim:
        try:
            return (
                datetime.strptime(env_inicio, "%Y-%m-%d").date(),
                datetime.strptime(env_fim, "%Y-%m-%d").date()
            )
        except ValueError:
            pass
    agora_utc = datetime.now(timezone.utc)
    offset_brt = timedelta(hours=-3)
    agora_brt = agora_utc + offset_brt
    hoje = agora_brt.date()
    dias_desde_segunda = hoje.weekday()
    domingo_passado = hoje - timedelta(days=dias_desde_segunda + 1)
    segunda_passada = domingo_passado - timedelta(days=6)
    return segunda_passada, domingo_passado

def data_no_periodo(data_texto: str, inicio: date, fim: date) -> bool:
    formatos = [
        "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%Y %H:%M",
        "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z",
        "%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z",
    ]
    texto = data_texto.strip()
    for fmt in formatos:
        try:
            d = datetime.strptime(texto, fmt)
            return inicio <= d.date() <= fim
        except ValueError:
            continue
    m = re.search(r'(\d{2})/(\d{2})/(\d{4})', texto)
    if m:
        try:
            d = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
            return inicio <= d <= fim
        except ValueError:
            pass
    m = re.search(r'(\d{4})-(\d{2})-(\d{2})', texto)
    if m:
        try:
            d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            return inicio <= d <= fim
        except ValueError:
            pass
    return False

def fetch(url: str, params: dict = None, use_cloudscraper: bool = False, force_verify: bool = True) -> tuple[str | None, str | None]:
    """force_verify=False permite ignorar SSL para sites como STF no Actions."""
    if use_cloudscraper and CLOUDSCRAPER_AVAILABLE:
        scraper = get_cloudscraper()
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                r = scraper.get(url, params=params, timeout=TIMEOUT)
                r.raise_for_status()
                r.encoding = r.apparent_encoding or "utf-8"
                return r.text, None
            except Exception as e:
                if attempt == MAX_RETRIES:
                    return None, str(e)
                time.sleep((2 ** attempt) + random.uniform(0, 1))
        return None, "Cloudscraper falhou"

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            verify_ssl = certifi.where() if force_verify else False
            r = session.get(url, params=params, timeout=TIMEOUT, verify=verify_ssl)
            r.raise_for_status()
            r.encoding = r.apparent_encoding or "utf-8"
            return r.text, None
        except requests.exceptions.SSLError:
            if force_verify:
                # Tenta sem verificação SSL
                try:
                    r = session.get(url, params=params, timeout=TIMEOUT, verify=False)
                    r.raise_for_status()
                    r.encoding = r.apparent_encoding or "utf-8"
                    return r.text, None
                except Exception as e:
                    last_err = e
            else:
                last_err = "SSL Error"
        except requests.exceptions.HTTPError as e:
            status = e.response.status_code
            if status in (403, 429, 502, 503, 504):
                time.sleep(5 * attempt)
            last_err = e
        except Exception as e:
            last_err = e
        if attempt < MAX_RETRIES:
            time.sleep((2 ** attempt) + random.uniform(0, 1))
    return None, str(last_err) if 'last_err' in locals() else "Falha desconhecida"

def salvar_debug(fonte: str, html: str):
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    nome = f"{timestamp}_{fonte.replace(' ', '_')}.html"
    caminho = LOGS_DIR / nome
    with open(caminho, "w", encoding="utf-8") as f:
        f.write(html)
    log(f"    [DEBUG] HTML salvo em {caminho}")

def item(titulo: str, link: str, data_pub: str, fonte: str, extra: str = "") -> dict:
    return {
        "titulo": titulo.strip(),
        "link": link.strip(),
        "data_publicacao": data_pub.strip(),
        "fonte": fonte,
        "extra": extra.strip()
    }

# ─────────────────────────────────────────────────────────────────────────────
# PLANALTO (BUSCA DINÂMICA)
# ─────────────────────────────────────────────────────────────────────────────
def scrape_planalto_busca(palavra_chave: str, inicio: date, fim: date, fonte_nome: str) -> list[dict]:
    """Usa a busca do portal da legislação para encontrar atos por data."""
    resultado = []
    base_url = "https://www4.planalto.gov.br/legislacao/portal-legis/busca-legislacao"
    params = {
        "tipo": "legislacao",
        "texto": palavra_chave,
        "dataInicio": inicio.strftime("%d/%m/%Y"),
        "dataFim": fim.strftime("%d/%m/%Y"),
    }
    html, erro = fetch(base_url, params=params, use_cloudscraper=True)
    if erro:
        log(f"  ✗ {fonte_nome}: {erro}")
        return resultado
    soup = BeautifulSoup(html, "lxml")
    for item_div in soup.select(".item-busca, .resultado-item, article"):
        link_tag = item_div.find("a", href=True)
        if not link_tag:
            continue
        href = link_tag["href"]
        if not href.startswith("http"):
            href = urljoin(base_url, href)
        titulo = link_tag.get_text(strip=True)
        texto_div = item_div.get_text(" ", strip=True)
        m = re.search(r'(\d{2}/\d{2}/\d{4})', texto_div)
        if m and data_no_periodo(m.group(1), inicio, fim):
            resultado.append(item(titulo, href, m.group(1), fonte_nome))
    if not resultado and html:
        salvar_debug(f"Planalto_Busca_{fonte_nome}", html)
    log(f"  ✓ {fonte_nome}: {len(resultado)} publicação(ões)")
    return resultado

# ─────────────────────────────────────────────────────────────────────────────
# SIJUT2
# ─────────────────────────────────────────────────────────────────────────────
def scrape_sijut2(inicio: date, fim: date, fonte_nome: str, tipo_ids: str) -> list[dict]:
    resultado = []
    BASE_URL = "https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action"
    BASE_LINK = "https://normas.receita.fazenda.gov.br/sijut2consulta/"
    params = {
        "tiposAtosSelecionados": tipo_ids,
        "tipoConsulta": "formulario",
        "tipoData": "2",
        "dt_inicio": inicio.strftime("%d/%m/%Y"),
        "dt_fim": fim.strftime("%d/%m/%Y"),
        "optOrdem": "Publicacao_DESC",
    }
    html, erro = fetch(BASE_URL, params=params)
    if erro:
        log(f"  ✗ {fonte_nome}: {erro}")
        return resultado
    soup = BeautifulSoup(html, "lxml")
    for elem in soup.select("div.resultado-item, tr[class*='listagem']"):
        link = elem.find("a", href=True)
        if link:
            href = link["href"]
            if not href.startswith("http"):
                href = urljoin(BASE_LINK, href)
            texto = elem.get_text(" ", strip=True)
            m = re.search(r'(\d{2}/\d{2}/\d{4})', texto)
            if m and data_no_periodo(m.group(1), inicio, fim):
                resultado.append(item(link.get_text(strip=True), href, m.group(1), fonte_nome))
    log(f"  ✓ {fonte_nome}: {len(resultado)} publicação(ões)")
    return resultado

# ─────────────────────────────────────────────────────────────────────────────
# PGFN (NOTÍCIAS + PARECERES)
# ─────────────────────────────────────────────────────────────────────────────
def scrape_pgfn_noticias(inicio: date, fim: date) -> list[dict]:
    resultado = []
    url = "https://www.gov.br/pgfn/pt-br/assuntos/noticias"
    html, erro = fetch(url)
    if erro:
        return resultado
    soup = BeautifulSoup(html, "lxml")
    for artigo in soup.select("article.tileItem, div.tileItem, a.summary.url"):
        titulo_tag = artigo.find("h2") or artigo.find("h3")
        if not titulo_tag:
            continue
        link_tag = artigo.find("a", href=True) or artigo
        href = link_tag.get("href")
        if not href:
            continue
        if not href.startswith("http"):
            href = urljoin(url, href)
        data_span = artigo.find("span", class_="documentPublished") or artigo.find("time")
        data_str = data_span.get_text(strip=True) if data_span else ""
        if data_str and data_no_periodo(data_str, inicio, fim):
            titulo = titulo_tag.get_text(strip=True).lower()
            if "parecer normativo" in titulo or "portaria" in titulo:
                resultado.append(item(titulo_tag.get_text(strip=True), href, data_str, "Parecer Normativo PGFN"))
    return resultado

def scrape_pgfn_pareceres(inicio: date, fim: date) -> list[dict]:
    resultado = []
    url = "https://www.gov.br/pgfn/pt-br/cidadania-tributaria/por-tipo-de-ato/pareceres-pgfn-cat-1/por-ano-1"
    html, erro = fetch(url)
    if erro:
        return resultado
    soup = BeautifulSoup(html, "lxml")
    for link in soup.find_all("a", href=True):
        texto = link.get_text(strip=True)
        href = link["href"]
        if not href.startswith("http"):
            href = urljoin(url, href)
        pai = link.find_parent(["td", "li", "div"])
        ctx = pai.get_text() if pai else texto
        m = re.search(r'(\d{2}/\d{2}/\d{4})', ctx)
        if m and data_no_periodo(m.group(1), inicio, fim):
            resultado.append(item(texto[:200], href, m.group(1), "Parecer Normativo PGFN"))
    return resultado

def scrape_pgfn_completo(inicio: date, fim: date) -> list[dict]:
    noticias = scrape_pgfn_noticias(inicio, fim)
    pareceres = scrape_pgfn_pareceres(inicio, fim)
    links = set()
    final = []
    for pub in noticias + pareceres:
        if pub["link"] not in links:
            links.add(pub["link"])
            final.append(pub)
    log(f"  ✓ PGFN Pareceres: {len(final)}")
    return final

# ─────────────────────────────────────────────────────────────────────────────
# CARF DOU
# ─────────────────────────────────────────────────────────────────────────────
def scrape_carf_dou(inicio: date, fim: date) -> list[dict]:
    resultado = []
    params = {
        "q": '"Conselho Administrativo de Recursos Fiscais" OR "CARF"',
        "exactDate": "personalizado",
        "publishFrom": inicio.strftime("%d-%m-%Y"),
        "publishTo": fim.strftime("%d-%m-%Y"),
        "section": "do1",
    }
    url = "https://www.in.gov.br/consulta/-/buscar/dou"
    html, erro = fetch(url, params=params, force_verify=True)
    if erro:
        log(f"  ✗ CARF DOU: {erro}")
        return resultado
    soup = BeautifulSoup(html, "lxml")
    for card in soup.select("div.resultado, article, a[href*='/web/dou/-/']"):
        link = card if card.name == "a" else card.find("a", href=True)
        if not link:
            continue
        href = link.get("href")
        if not href:
            continue
        if not href.startswith("http"):
            href = urljoin("https://www.in.gov.br", href)
        texto = card.get_text(" ", strip=True)[:300]
        m = re.search(r'(\d{2}/\d{2}/\d{4})', texto)
        data_pub = m.group(1) if m else ""
        if not data_pub or data_no_periodo(data_pub, inicio, fim):
            titulo = link.get_text(strip=True) if link.name == "a" else texto[:100]
            resultado.append(item(titulo, href, data_pub or "ver DOU", "CARF (DOU)"))
    log(f"  ✓ CARF (DOU): {len(resultado)} ato(s)")
    return resultado

# ─────────────────────────────────────────────────────────────────────────────
# STJ
# ─────────────────────────────────────────────────────────────────────────────
def scrape_stj_informativo(inicio: date, fim: date) -> list[dict]:
    resultado = []
    feed = feedparser.parse("https://processo.stj.jus.br/jurisprudencia/externo/InformativoFeed")
    for entry in feed.entries:
        data_pub = entry.get("published", "")
        if data_no_periodo(data_pub, inicio, fim):
            resultado.append(item(entry.title, entry.link, data_pub, "Informativo STJ"))
    log(f"  ✓ Informativo STJ: {len(resultado)} edição(ões)")
    return resultado

def scrape_stj_sumulas(inicio: date, fim: date) -> list[dict]:
    resultado = []
    api_url = "https://scon.stj.jus.br/SCON/api/sumulas"
    params = {"dataInicial": inicio.strftime("%d/%m/%Y"), "dataFinal": fim.strftime("%d/%m/%Y")}
    html, erro = fetch(api_url, params=params)
    if not erro and html:
        try:
            data = json.loads(html)
            for s in data.get("sumulas", []):
                resultado.append(item(
                    f"Súmula {s.get('numero')} - {s.get('ementa', '')[:100]}",
                    s.get("link", ""), s.get("dataPublicacao", ""), "Súmula STJ"
                ))
        except:
            pass
    if not resultado:
        url = "https://scon.stj.jus.br/SCON/sumulas"
        html, erro = fetch(url)
        if not erro:
            soup = BeautifulSoup(html, "lxml")
            for link in soup.find_all("a", href=True):
                if "sumula" in link["href"].lower():
                    ctx = link.find_parent("tr")
                    if ctx:
                        m = re.search(r'(\d{2}/\d{2}/\d{4})', ctx.get_text())
                        if m and data_no_periodo(m.group(1), inicio, fim):
                            resultado.append(item(link.get_text(strip=True), urljoin(url, link["href"]), m.group(1), "Súmula STJ"))
    log(f"  ✓ Súmula STJ: {len(resultado)} nova(s)")
    return resultado

# ─────────────────────────────────────────────────────────────────────────────
# STF (COM SSL FALLBACK)
# ─────────────────────────────────────────────────────────────────────────────
def scrape_stf_informativo(inicio: date, fim: date) -> list[dict]:
    resultado = []
    url = "https://portal.stf.jus.br/jurisprudencia/informativo/"
    html, erro = fetch(url, force_verify=False)
    if erro:
        log(f"  ✗ Informativo STF: {erro}")
        return resultado
    soup = BeautifulSoup(html, "lxml")
    for item in soup.select(".resultado-pesquisa-lista-item, .lista-informativos-item, article"):
        link = item.find("a", href=True)
        if link:
            texto = link.get_text(strip=True)
            href = urljoin(url, link["href"])
            data_span = item.find("span", class_="data") or item.find("time")
            data_str = data_span.get_text(strip=True) if data_span else ""
            if not data_str:
                m = re.search(r'(\d{2}/\d{2}/\d{4})', item.get_text())
                data_str = m.group(1) if m else ""
            if data_str and "Informativo" in texto and data_no_periodo(data_str, inicio, fim):
                resultado.append(item(texto, href, data_str, "Informativo STF"))
    log(f"  ✓ Informativo STF: {len(resultado)} edição(ões)")
    return resultado

def scrape_stf_sumulas(inicio: date, fim: date, vinculante: bool = False) -> list[dict]:
    resultado = []
    if vinculante:
        url = "https://portal.stf.jus.br/jurisprudencia/sumulasVinculantes"
        fonte = "Súmula Vinculante STF"
    else:
        url = "https://portal.stf.jus.br/jurisprudencia/sumulas"
        fonte = "Súmula STF"
    html, erro = fetch(url, force_verify=False)
    if erro:
        log(f"  ✗ {fonte}: {erro}")
        return resultado
    soup = BeautifulSoup(html, "lxml")
    for link in soup.select("a[href*='/sumula']"):
        texto = link.get_text(strip=True)
        href = urljoin(url, link["href"])
        ctx = link.find_parent("tr") or link.find_parent("div")
        ctx_text = ctx.get_text() if ctx else texto
        m = re.search(r'(\d{2}/\d{2}/\d{4})', ctx_text)
        if m and data_no_periodo(m.group(1), inicio, fim):
            resultado.append(item(texto, href, m.group(1), fonte))
    log(f"  ✓ {fonte}: {len(resultado)} nova(s)")
    return resultado

# ─────────────────────────────────────────────────────────────────────────────
# SPED (NOVOS SELETORES)
# ─────────────────────────────────────────────────────────────────────────────
def scrape_sped(inicio: date, fim: date) -> list[dict]:
    resultado = []
    url = "https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/sped"
    html, erro = fetch(url)
    if erro:
        log(f"  ✗ SPED: {erro}")
        return resultado
    soup = BeautifulSoup(html, "lxml")
    # Seletores atualizados para o novo layout do gov.br
    for elem in soup.select("article.tileItem, div.tileItem, div.list-item, div[class*='noticia']"):
        link = elem.find("a", href=True)
        if link:
            href = link["href"]
            if not href.startswith("http"):
                href = urljoin(url, href)
            texto = elem.get_text(" ", strip=True)[:200]
            m = re.search(r'(\d{2}/\d{2}/\d{4})', texto)
            if m and data_no_periodo(m.group(1), inicio, fim):
                resultado.append(item(link.get_text(strip=True), href, m.group(1), "SPED"))
    if not resultado and html:
        salvar_debug("SPED", html)
    log(f"  ✓ SPED: {len(resultado)} publicação(ões)")
    return resultado

# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────
def main():
    inicio, fim = calcular_periodo_semana()
    log(f"═══ TERA Curadoria Semanal — {inicio.strftime('%d/%m/%Y')} a {fim.strftime('%d/%m/%Y')} ═══")

    resultado = {}

    log("[1/16] Lei Ordinária (Planalto)...")
    resultado["Lei Ordinária"] = scrape_planalto_busca("Lei", inicio, fim, "Lei Ordinária")
    log("[2/16] Decreto (Planalto)...")
    resultado["Decreto"] = scrape_planalto_busca("Decreto", inicio, fim, "Decreto")
    log("[3/16] Lei Complementar (Planalto)...")
    resultado["Lei Complementar"] = scrape_planalto_busca("Lei Complementar", inicio, fim, "Lei Complementar")
    log("[4/16] Medida Provisória (Planalto)...")
    resultado["Medida Provisória"] = scrape_planalto_busca("Medida Provisória", inicio, fim, "Medida Provisória")

    log("[5/16] Resolução CGSN (SIJUT2)...")
    resultado["Resolução CGSN"] = scrape_sijut2(inicio, fim, "Resolução CGSN", "67")
    log("[6/16] Instrução Normativa (SIJUT2)...")
    resultado["Instrução Normativa (IN)"] = scrape_sijut2(inicio, fim, "Instrução Normativa", "42")
    log("[7/16] Ato Declaratório Interpretativo (SIJUT2)...")
    resultado["Ato Declaratório Interpretativo (ADI)"] = scrape_sijut2(inicio, fim, "ADI", "10")
    log("[8/16] Portaria (SIJUT2)...")
    resultado["Portaria"] = scrape_sijut2(inicio, fim, "Portaria", "57;81;95;80;65")
    log("[9/16] Solução de Consulta (SIJUT2)...")
    resultado["Solução de Consulta (SC)"] = scrape_sijut2(inicio, fim, "SC", "72")

    log("[10/16] Parecer Normativo PGFN...")
    resultado["Parecer Normativo PGFN"] = scrape_pgfn_completo(inicio, fim)

    log("[11/16] CARF (DOU Seção 1)...")
    resultado["CARF (DOU)"] = scrape_carf_dou(inicio, fim)

    log("[12/16] Informativo STJ (RSS)...")
    resultado["Informativo STJ"] = scrape_stj_informativo(inicio, fim)
    log("[13/16] Súmula STJ...")
    resultado["Súmula STJ"] = scrape_stj_sumulas(inicio, fim)

    log("[14/16] Informativo STF...")
    resultado["Informativo STF"] = scrape_stf_informativo(inicio, fim)
    log("[15/16] Súmula STF...")
    resultado["Súmula STF"] = scrape_stf_sumulas(inicio, fim, vinculante=False)
    log("[16/16] Súmula Vinculante STF...")
    resultado["Súmula Vinculante STF"] = scrape_stf_sumulas(inicio, fim, vinculante=True)

    log("[17] Portal SPED...")
    resultado["Informativo SPED"] = scrape_sped(inicio, fim)

    total = sum(len(v) for v in resultado.values())
    saida = {
        "periodo": {"inicio": inicio.isoformat(), "fim": fim.isoformat()},
        "gerado_em": datetime.now(timezone.utc).isoformat(),
        "total_publicacoes": total,
        "temas": len(resultado),
        "resultado": resultado
    }
    with open(DATA_DIR / "curadoria_semanal.json", "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, indent=2)
    log(f"  ✓ Resultado salvo em data/curadoria_semanal.json")

    historico = []
    hist_path = DATA_DIR / "curadoria_semanal_historico.json"
    if hist_path.exists():
        with open(hist_path, "r", encoding="utf-8") as f:
            historico = json.load(f)
    historico.insert(0, {
        "periodo": saida["periodo"],
        "gerado_em": saida["gerado_em"],
        "total_publicacoes": total,
        "resumo_por_tema": {k: len(v) for k, v in resultado.items()}
    })
    with open(hist_path, "w", encoding="utf-8") as f:
        json.dump(historico[:52], f, ensure_ascii=False, indent=2)
    log(f"  ✓ Histórico atualizado ({min(len(historico), 52)} semanas)")

    log("\n═══ RELATÓRIO DA CURADORIA ═══")
    log(f"  Período: {inicio.strftime('%d/%m/%Y')} a {fim.strftime('%d/%m/%Y')}")
    log(f"  Total de publicações encontradas: {total}")
    for tema, pubs in resultado.items():
        log(f"  {'✓' if pubs else '·'} {tema}: {len(pubs)}")
    log("═══ Concluído ═══")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"ERRO FATAL: {e}")
        traceback.print_exc()
        sys.exit(1)
