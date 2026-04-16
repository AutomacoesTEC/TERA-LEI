#!/usr/bin/env python3
"""
TERA — Curadoria Semanal Tributária (v1.1)
==========================================
Agente de curadoria que "pesca" TODAS as publicações oficiais de interesse
tributário publicadas entre a segunda-feira e o domingo da semana anterior.

Fontes monitoradas (16 temas):
  LEGISLAÇÃO FEDERAL (Planalto):
    1. Lei Ordinária
    2. Decreto
    3. Lei Complementar
    4. Medidas Provisórias

  RECEITA FEDERAL (SIJUT2 / Normas):
    5.  Resolução CGSN
    6.  Instrução Normativa (IN)
    7.  Ato Declaratório Interpretativo (ADI)
    8.  Portaria (Port., Port. Conj., Port. Pes., PIM, Port. Norm.)
    9.  Solução de Consulta (SC)

  PGFN:
    10. Parecer Normativo PGFN

  DOU / CARF:
    11. Atos do CARF no Diário Oficial da União (Seção 1)

  STJ:
    12. Informativo de Jurisprudência STJ (RSS)
    13. Súmula STJ (nova numeração detectada)

  STF:
    14. Informativo Semanal STF
    15. Súmula STF (nova numeração detectada)
    16. Súmula Vinculante STF (nova numeração detectada)

  SPED:
    17. Informativo Portal SPED

Saída: data/curadoria_semanal.json  (resultado da semana)
       data/curadoria_semanal_historico.json  (histórico acumulado)

Executado via GitHub Actions toda segunda-feira às 10:00 UTC (07:00 BRT).
"""

import json
import os
import re
import smtplib
import sys
import time
import random
import traceback
from datetime import datetime, timedelta, timezone, date
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from urllib.parse import urljoin, urlencode

try:
    import requests
    from requests.exceptions import RequestException
    from requests.packages.urllib3.exceptions import InsecureRequestWarning
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
    from requests.exceptions import RequestException
    from bs4 import BeautifulSoup
    import feedparser
    import certifi

# Suprimir avisos de SSL quando verify=False (usado apenas como fallback)
requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

# Tentar importar cloudscraper (opcional, para bypass de Cloudflare)
try:
    import cloudscraper
    CLOUDSCRAPER_AVAILABLE = True
except ImportError:
    CLOUDSCRAPER_AVAILABLE = False

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURAÇÕES GLOBAIS
# ─────────────────────────────────────────────────────────────────────────────
BRT = timezone(timedelta(hours=-3))
AGORA = datetime.now(BRT)
TIMEOUT = 40
MAX_RETRIES = 4  # Aumentado para dar mais chances

# Sessão HTTP com headers realistas de navegador
SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
    "Referer": "https://www.google.com/",
})

DATA_DIR = Path("data")
SAIDA_SEMANA = DATA_DIR / "curadoria_semanal.json"
SAIDA_HISTORICO = DATA_DIR / "curadoria_semanal_historico.json"

EMAIL_DESTINATARIO = "tectributos.federal11@gmail.com"
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587


# ─────────────────────────────────────────────────────────────────────────────
# UTILITÁRIOS
# ─────────────────────────────────────────────────────────────────────────────
def log(msg: str):
    print(f"[{AGORA.strftime('%H:%M:%S')}] {msg}")


def calcular_periodo_semana() -> tuple[date, date]:
    """Calcula segunda-feira e domingo da semana ANTERIOR."""
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

    hoje = AGORA.date()
    dias_desde_segunda = hoje.weekday()
    domingo_passado = hoje - timedelta(days=dias_desde_segunda + 1)
    segunda_passada = domingo_passado - timedelta(days=6)
    return segunda_passada, domingo_passado


def data_no_periodo(data_texto: str, inicio: date, fim: date) -> bool:
    """Tenta parsear uma string de data em vários formatos e verifica se está no período."""
    formatos = [
        "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y",
        "%d/%m/%Y %H:%M", "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z",
        "%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z",
        "%d de %B de %Y",
    ]
    meses_pt = {
        "janeiro": "01", "fevereiro": "02", "março": "03",
        "abril": "04", "maio": "05", "junho": "06",
        "julho": "07", "agosto": "08", "setembro": "09",
        "outubro": "10", "novembro": "11", "dezembro": "12"
    }
    texto = data_texto.strip().lower()
    for mes, num in meses_pt.items():
        texto = texto.replace(mes, num)
    texto = texto.title() if texto else texto

    for fmt in formatos:
        try:
            d = datetime.strptime(texto, fmt)
            return inicio <= d.date() <= fim
        except (ValueError, TypeError):
            continue

    m = re.search(r'(\d{2})/(\d{2})/(\d{4})', data_texto)
    if m:
        try:
            d = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
            return inicio <= d <= fim
        except ValueError:
            pass

    m = re.search(r'(\d{4})-(\d{2})-(\d{2})', data_texto)
    if m:
        try:
            d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            return inicio <= d <= fim
        except ValueError:
            pass
    return False


def fetch(url: str, params: dict = None, use_cloudscraper: bool = False) -> tuple[str | None, str | None]:
    """
    GET com backoff exponencial e jitter, tratamento SSL robusto.
    Se use_cloudscraper=True e cloudscraper disponível, usa-o para bypass de anti-bot.
    """
    headers = None  # Usa os headers da sessão por padrão

    # Se solicitado e disponível, tenta usar cloudscraper primeiro
    if use_cloudscraper and CLOUDSCRAPER_AVAILABLE:
        scraper = cloudscraper.create_scraper(
            browser={'browser': 'chrome', 'platform': 'windows', 'mobile': False}
        )
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                r = scraper.get(url, params=params, timeout=TIMEOUT)
                r.raise_for_status()
                r.encoding = r.apparent_encoding or "utf-8"
                return r.text, None
            except Exception as e:
                last_err = e
                if attempt < MAX_RETRIES:
                    wait = (2 ** attempt) + random.uniform(0, 1)
                    time.sleep(wait)
                else:
                    break
        # Fallback para requests normal se cloudscraper falhar
        log(f"  ⚠ cloudscraper falhou, tentando requests normal...")

    # Usar requests normal com backoff exponencial
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            # Tenta primeiro com verificação SSL (certifi)
            r = SESSION.get(
                url, params=params, timeout=TIMEOUT,
                verify=certifi.where(), headers=headers
            )
            r.raise_for_status()
            r.encoding = r.apparent_encoding or "utf-8"
            return r.text, None
        except RequestException as e:
            # Se for erro de SSL, tenta com verify=False como último recurso
            if isinstance(e, requests.exceptions.SSLError):
                try:
                    r = SESSION.get(
                        url, params=params, timeout=TIMEOUT,
                        verify=False, headers=headers
                    )
                    r.raise_for_status()
                    r.encoding = r.apparent_encoding or "utf-8"
                    log(f"  ⚠ Conexão SSL não verificada para {url}")
                    return r.text, None
                except Exception as e2:
                    last_err = e2
            else:
                last_err = e

            # Se for 403/429, espera mais tempo
            if hasattr(e, 'response') and e.response is not None:
                status = e.response.status_code
                if status in (403, 429):
                    wait_time = (5 * attempt) + random.uniform(1, 3)
                    time.sleep(wait_time)
                    continue
                elif status in (404, 410):
                    return None, f"HTTP {status}"

            if attempt < MAX_RETRIES:
                wait = (2 ** attempt) + random.uniform(0, 1)
                time.sleep(wait)
            else:
                break
        except Exception as e:
            last_err = e
            if attempt < MAX_RETRIES:
                time.sleep(2 ** attempt)
            else:
                break

    return None, str(last_err) if 'last_err' in locals() else "Falha desconhecida"


def item(titulo: str, link: str, data_pub: str, fonte: str, extra: str = "") -> dict:
    return {
        "titulo": titulo.strip(),
        "link": link.strip(),
        "data_publicacao": data_pub.strip(),
        "fonte": fonte,
        "extra": extra.strip()
    }


# ─────────────────────────────────────────────────────────────────────────────
# SCRAPERS POR FONTE
# ─────────────────────────────────────────────────────────────────────────────

def scrape_planalto(url_base: str, inicio: date, fim: date, fonte_nome: str) -> list[dict]:
    """
    Scraper genérico para páginas do portal Planalto.
    Usa cloudscraper se disponível, pois o Planalto frequentemente bloqueia.
    """
    resultado = []
    # Tenta com cloudscraper para evitar bloqueios do Planalto
    html, erro = fetch(url_base, use_cloudscraper=True)
    if erro:
        log(f"  ✗ {fonte_nome}: {erro}")
        return resultado

    soup = BeautifulSoup(html, "lxml")
    tabelas = soup.find_all("table")

    for tabela in tabelas:
        linhas = tabela.find_all("tr")
        for linha in linhas[1:]:
            colunas = linha.find_all(["td", "th"])
            if len(colunas) < 2:
                continue

            link_tag = linha.find("a", href=True)
            if not link_tag:
                continue

            link_href = link_tag["href"]
            if not link_href.startswith("http"):
                link_href = urljoin(url_base, link_href)

            textos = [c.get_text(strip=True) for c in colunas]
            titulo_completo = " — ".join(t for t in textos if t)

            data_pub = ""
            for t in textos:
                m = re.search(r'\d{2}/\d{2}/\d{4}', t)
                if m:
                    data_pub = m.group()
                    break
                m2 = re.search(r'\d{4}-\d{2}-\d{2}', t)
                if m2:
                    data_pub = m2.group()
                    break

            if not data_pub:
                m = re.search(r'/(\d{4})/', link_href)
                if m:
                    data_pub = m.group(1)

            if data_pub and data_no_periodo(data_pub, inicio, fim):
                resultado.append(item(
                    titulo=titulo_completo,
                    link=link_href,
                    data_pub=data_pub,
                    fonte=fonte_nome
                ))
            elif not data_pub:
                resultado.append(item(
                    titulo=titulo_completo,
                    link=link_href,
                    data_pub="data não identificada",
                    fonte=fonte_nome,
                    extra="⚠ Data não extraída automaticamente — verificar manualmente"
                ))

    log(f"  ✓ {fonte_nome}: {len(resultado)} publicação(ões) no período")
    return resultado


def scrape_sijut2(url_base: str, inicio: date, fim: date, fonte_nome: str,
                  tipo_ids: str, paginas_max: int = 5) -> list[dict]:
    """Scraper para normas.receita.fazenda.gov.br (SIJUT2)."""
    resultado = []
    dt_ini_str = inicio.strftime("%d/%m/%Y")
    dt_fim_str = fim.strftime("%d/%m/%Y")

    base_params = {
        "tiposAtosSelecionados": tipo_ids,
        "tipoConsulta": "formulario",
        "tipoData": "2",
        "dt_inicio": dt_ini_str,
        "dt_fim": dt_fim_str,
        "optOrdem": "Publicacao_DESC",
    }

    BASE_URL = "https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action"
    BASE_LINK = "https://normas.receita.fazenda.gov.br/sijut2consulta/"

    for pagina in range(1, paginas_max + 1):
        params = {**base_params, "p": str(pagina)}
        html, erro = fetch(BASE_URL, params=params)
        if erro:
            log(f"  ✗ {fonte_nome} (pág {pagina}): {erro}")
            break

        soup = BeautifulSoup(html, "lxml")
        itens_pagina = soup.find_all("div", class_="resultado-item") or \
                       soup.find_all("tr", class_=re.compile(r"resultado|listagem", re.I))

        if not itens_pagina:
            resultados_div = soup.find("div", id=re.compile(r"resultado|listagem", re.I)) or \
                             soup.find("table", id=re.compile(r"resultado|listagem", re.I)) or \
                             soup.find("table")
            if resultados_div:
                itens_pagina = resultados_div.find_all("tr")

        if not itens_pagina:
            break

        encontrou_algum = False
        for elem in itens_pagina:
            link_tag = elem.find("a", href=True)
            if not link_tag:
                continue

            href = link_tag["href"]
            if not href.startswith("http"):
                href = urljoin(BASE_LINK, href)

            titulo_txt = link_tag.get_text(strip=True)
            if not titulo_txt:
                titulo_txt = elem.get_text(" ", strip=True)[:200]

            texto_linha = elem.get_text(" ", strip=True)
            data_pub = ""
            m = re.search(r'(\d{2}/\d{2}/\d{4})', texto_linha)
            if m:
                data_pub = m.group(1)

            if data_pub and data_no_periodo(data_pub, inicio, fim):
                resultado.append(item(titulo_txt, href, data_pub, fonte_nome))
                encontrou_algum = True
            elif not data_pub and href and "link" in href.lower():
                resultado.append(item(titulo_txt, href,
                                      "data não identificada", fonte_nome,
                                      "⚠ Verificar data manualmente"))
                encontrou_algum = True

        if not encontrou_algum:
            break

        proxima = soup.find("a", string=re.compile(r'[>»]|próxima|next', re.I))
        if not proxima:
            link_proxima_num = soup.find("a", string=str(pagina + 1))
            if not link_proxima_num:
                break

    log(f"  ✓ {fonte_nome}: {len(resultado)} publicação(ões) no período")
    return resultado


def scrape_stj_informativo(inicio: date, fim: date) -> list[dict]:
    """RSS oficial do Informativo de Jurisprudência do STJ."""
    resultado = []
    url = "https://processo.stj.jus.br/jurisprudencia/externo/InformativoFeed"
    try:
        feed = feedparser.parse(url)
        for entry in feed.entries:
            data_pub = ""
            if hasattr(entry, "published"):
                data_pub = entry.published
            elif hasattr(entry, "updated"):
                data_pub = entry.updated

            if data_pub and data_no_periodo(data_pub, inicio, fim):
                link = entry.link if hasattr(entry, "link") else ""
                titulo = entry.title if hasattr(entry, "title") else "Informativo STJ"
                resultado.append(item(titulo, link, data_pub, "Informativo STJ"))
    except Exception as e:
        log(f"  ✗ Informativo STJ (RSS): {e}")

    log(f"  ✓ Informativo STJ: {len(resultado)} edição(ões) no período")
    return resultado


def scrape_stj_sumulas(inicio: date, fim: date) -> list[dict]:
    """Súmulas STJ — detecta novas súmulas pela data de julgamento/publicação."""
    resultado = []
    url = "https://scon.stj.jus.br/SCON/sumulas"
    html, erro = fetch(url)
    if erro:
        log(f"  ✗ Súmula STJ: {erro}")
        return resultado

    soup = BeautifulSoup(html, "lxml")
    links = soup.find_all("a", href=True)
    for link_tag in links:
        href = link_tag["href"]
        texto = link_tag.get_text(strip=True)
        if re.search(r'sumula|s\d+', href, re.I) and re.search(r'\d+', texto):
            if not href.startswith("http"):
                href = urljoin(url, href)
            pai = link_tag.parent
            texto_ctx = pai.get_text(" ", strip=True) if pai else ""
            m = re.search(r'(\d{2}/\d{2}/\d{4})', texto_ctx)
            data_pub = m.group(1) if m else ""
            if data_pub and data_no_periodo(data_pub, inicio, fim):
                resultado.append(item(texto, href, data_pub, "Súmula STJ"))

    log(f"  ✓ Súmula STJ: {len(resultado)} nova(s) no período")
    return resultado


def scrape_stf_informativo(inicio: date, fim: date) -> list[dict]:
    """Informativo Semanal STF — lista de edições recentes."""
    resultado = []
    url = "https://www.stf.jus.br/portal/jurisprudencia/informativo/menuInformativo.asp"
    html, erro = fetch(url)
    if erro:
        log(f"  ✗ Informativo STF: {erro}")
        return resultado

    soup = BeautifulSoup(html, "lxml")
    links = soup.find_all("a", href=True)
    for link_tag in links:
        texto = link_tag.get_text(strip=True)
        href = link_tag["href"]
        if not href.startswith("http"):
            href = urljoin("https://www.stf.jus.br", href)

        pai = link_tag.find_parent(["td", "li", "div", "p"])
        texto_ctx = (pai.get_text(" ", strip=True) if pai else texto)

        m = re.search(r'(\d{2}/\d{2}/\d{4})', texto_ctx)
        data_pub = m.group(1) if m else ""

        if re.search(r'informativo|nformativo|\d{3,4}', texto, re.I):
            if data_pub and data_no_periodo(data_pub, inicio, fim):
                resultado.append(item(
                    titulo=texto_ctx[:150],
                    link=href,
                    data_pub=data_pub,
                    fonte="Informativo STF"
                ))

    log(f"  ✓ Informativo STF: {len(resultado)} edição(ões) no período")
    return resultado


def scrape_stf_sumulas(inicio: date, fim: date, vinculante: bool = False) -> list[dict]:
    """Súmulas STF (comuns ou vinculantes)."""
    resultado = []
    if vinculante:
        url = "http://www.stf.jus.br/portal/cms/verTexto.asp?servico=jurisprudenciaSumulaVinculante"
        fonte = "Súmula Vinculante STF"
    else:
        url = "https://www.stf.jus.br/portal/jurisprudencia/menuSumario.asp"
        fonte = "Súmula STF"

    html, erro = fetch(url)
    if erro:
        log(f"  ✗ {fonte}: {erro}")
        return resultado

    soup = BeautifulSoup(html, "lxml")
    links = soup.find_all("a", href=True)
    for link_tag in links:
        href = link_tag["href"]
        texto = link_tag.get_text(strip=True)
        if not href.startswith("http"):
            href = urljoin("https://www.stf.jus.br", href)
        pai = link_tag.find_parent(["td", "li", "div", "p"])
        texto_ctx = (pai.get_text(" ", strip=True) if pai else texto)[:200]
        m = re.search(r'(\d{2}/\d{2}/\d{4})', texto_ctx)
        data_pub = m.group(1) if m else ""
        if re.search(r'sumul|s\d+|\d+', texto, re.I) and data_pub:
            if data_no_periodo(data_pub, inicio, fim):
                resultado.append(item(texto_ctx[:150], href, data_pub, fonte))

    log(f"  ✓ {fonte}: {len(resultado)} nova(s) no período")
    return resultado


def scrape_sped(inicio: date, fim: date) -> list[dict]:
    """Portal SPED — destaques/notas técnicas/publicações recentes."""
    resultado = []
    url = "http://sped.rfb.gov.br"
    html, erro = fetch(url)
    if erro:
        log(f"  ✗ SPED: {erro}")
        return resultado

    soup = BeautifulSoup(html, "lxml")
    items_sped = soup.find_all(["article", "div"], class_=re.compile(
        r'portlet-body|asset-entry|news|destaque|item', re.I
    ))
    if not items_sped:
        items_sped = soup.find_all("li")

    for elem in items_sped:
        link_tag = elem.find("a", href=True)
        if not link_tag:
            continue
        href = link_tag["href"]
        if not href.startswith("http"):
            href = urljoin(url, href)
        titulo_txt = link_tag.get_text(strip=True) or elem.get_text(" ", strip=True)[:150]
        texto_elem = elem.get_text(" ", strip=True)
        m = re.search(r'(\d{2}/\d{2}/\d{4})', texto_elem)
        data_pub = m.group(1) if m else ""
        if data_pub and data_no_periodo(data_pub, inicio, fim):
            resultado.append(item(titulo_txt[:200], href, data_pub, "SPED"))
        elif not data_pub and href != url and len(titulo_txt) > 10:
            resultado.append(item(
                titulo_txt[:200], href,
                "data não identificada", "SPED",
                "⚠ Verificar data manualmente"
            ))

    log(f"  ✓ Portal SPED: {len(resultado)} publicação(ões) no período")
    return resultado


def scrape_pgfn_pareceres(inicio: date, fim: date) -> list[dict]:
    """Pareceres Normativos PGFN — por ano."""
    resultado = []
    ano = inicio.year
    url = f"https://www.gov.br/pgfn/pt-br/cidadania-tributaria/por-tipo-de-ato/pareceres-pgfn-cat-1/por-ano-1"
    html, erro = fetch(url)
    if erro:
        log(f"  ✗ PGFN Pareceres: {erro}")
        return resultado

    soup = BeautifulSoup(html, "lxml")
    links = soup.find_all("a", href=True)
    for link_tag in links:
        href = link_tag["href"]
        texto = link_tag.get_text(strip=True)
        if not href.startswith("http"):
            href = urljoin(url, href)
        if not texto or len(texto) < 5:
            continue
        pai = link_tag.find_parent(["td", "li", "div", "p", "article"])
        texto_ctx = (pai.get_text(" ", strip=True) if pai else texto)[:250]
        m = re.search(r'(\d{2}/\d{2}/\d{4})', texto_ctx)
        data_pub = m.group(1) if m else ""
        if data_pub and data_no_periodo(data_pub, inicio, fim):
            resultado.append(item(texto[:200], href, data_pub, "Parecer Normativo PGFN"))

    log(f"  ✓ PGFN Pareceres: {len(resultado)} publicação(ões) no período")
    return resultado


def scrape_carf_dou(inicio: date, fim: date) -> list[dict]:
    """CARF no Diário Oficial da União."""
    resultado = []
    BASE_DOU = "https://www.in.gov.br/consulta/-/buscar/dou"
    params_base = {
        "q": '"Conselho Administrativo de Recursos Fiscais" OR "CARF"',
        "exactDate": "personalizado",
        "startDate": inicio.strftime("%d-%m-%Y"),
        "endDate": fim.strftime("%d-%m-%Y"),
        "section": "do1",
        "orgPub": "Ministério da Fazenda",
    }

    for secao, secao_nome in [("do1", "Seção 1"), ("do1_extra", "Seção 1 Extra"), ("do1_suplementar", "Seção 1 Suplementar")]:
        params = {**params_base, "section": secao}
        html, erro = fetch(BASE_DOU, params=params)
        if erro:
            log(f"  ✗ CARF DOU {secao_nome}: {erro}")
            continue

        soup = BeautifulSoup(html, "lxml")
        cards = soup.find_all("div", class_=re.compile(r'resultado|resultado-item|card', re.I))
        if not cards:
            cards = soup.find_all("article")
        if not cards:
            links_dou = soup.find_all("a", href=True, string=re.compile(r'CARF|Fazenda', re.I))
            for link_tag in links_dou:
                href = link_tag["href"]
                if not href.startswith("http"):
                    href = urljoin("https://www.in.gov.br", href)
                pai = link_tag.find_parent(["div", "li", "article"])
                texto_ctx = (pai.get_text(" ", strip=True) if pai else link_tag.get_text())[:250]
                m = re.search(r'(\d{2}/\d{2}/\d{4})', texto_ctx)
                data_pub = m.group(1) if m else ""
                if not data_pub or data_no_periodo(data_pub, inicio, fim):
                    resultado.append(item(
                        titulo=link_tag.get_text(strip=True)[:200],
                        link=href,
                        data_pub=data_pub or "ver DOU",
                        fonte=f"CARF — DOU {secao_nome}"
                    ))
            continue

        for card in cards:
            link_tag = card.find("a", href=True)
            if not link_tag:
                continue
            href = link_tag["href"]
            if not href.startswith("http"):
                href = urljoin("https://www.in.gov.br", href)
            texto_card = card.get_text(" ", strip=True)[:300]
            m = re.search(r'(\d{2}/\d{2}/\d{4})', texto_card)
            data_pub = m.group(1) if m else ""
            if not data_pub or data_no_periodo(data_pub, inicio, fim):
                resultado.append(item(
                    titulo=texto_card[:200],
                    link=href,
                    data_pub=data_pub or "ver DOU",
                    fonte=f"CARF — DOU {secao_nome}"
                ))

    log(f"  ✓ CARF (DOU): {len(resultado)} ato(s) no período")
    return resultado


# ─────────────────────────────────────────────────────────────────────────────
# ENVIO DE EMAIL (inalterado, por brevidade)
# ─────────────────────────────────────────────────────────────────────────────
def enviar_email_curadoria(resultado: dict, inicio: date, fim: date):
    gmail_user = os.environ.get("GMAIL_USER", "").strip()
    gmail_password = os.environ.get("GMAIL_APP_PASSWORD", "").strip()
    if not gmail_user or not gmail_password:
        log("  ⚠ Email não enviado: credenciais não configuradas.")
        return False

    total = sum(len(v) for v in resultado.values())
    periodo_str = f"{inicio.strftime('%d/%m/%Y')} a {fim.strftime('%d/%m/%Y')}"
    hora_brt = AGORA.strftime("%d/%m/%Y às %H:%M")

    secoes_html = ""
    for tema, publicacoes in resultado.items():
        if not publicacoes:
            secoes_html += f"""
            <tr><td style="padding:8px 16px;border-bottom:1px solid #e0dcd4;color:#888;font-style:italic;">
              <strong>{tema}</strong> — nenhuma publicação no período.
            </td></tr>"""
            continue

        secoes_html += f"""
        <tr>
          <td style="padding:10px 16px;background:#f5f0e8;border-bottom:1px solid #e0dcd4;">
            <strong style="color:#a17c2f;font-size:14px;">📌 {tema}</strong>
            <span style="color:#888;font-size:12px;margin-left:8px;">{len(publicacoes)} publicação(ões)</span>
          </td>
        </tr>"""
        for pub in publicacoes:
            extra_html = f'<br><span style="color:#c0392b;font-size:11px;">{pub["extra"]}</span>' if pub.get("extra") else ""
            secoes_html += f"""
        <tr>
          <td style="padding:8px 16px 8px 28px;border-bottom:1px solid #ece8e0;">
            <div style="font-size:13px;color:#1a1a1a;margin-bottom:3px;">{pub['titulo'][:200]}</div>
            <div style="font-size:12px;color:#666;">📅 {pub['data_publicacao']}</div>
            <a href="{pub['link']}" style="font-size:12px;color:#B8965A;text-decoration:underline;">
              Acessar publicação →
            </a>{extra_html}
          </td>
        </tr>"""

    html_body = f"""
<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede6;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:640px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
  <div style="background:linear-gradient(135deg,#a17c2f,#c9a23d);padding:24px 30px;text-align:center;">
    <div style="font-size:26px;font-weight:800;color:#fff;letter-spacing:2px;">TERA</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.85);letter-spacing:1px;margin-top:2px;">CURADORIA SEMANAL TRIBUTÁRIA</div>
  </div>
  <div style="padding:20px 30px 10px;">
    <p style="font-size:15px;color:#1a1a1a;">
      Bom dia! Segue a curadoria da semana <strong>{periodo_str}</strong>.<br>
      Foram encontradas <strong style="color:#a17c2f;">{total} publicação(ões)</strong> em {len(resultado)} temas monitorados.
    </p>
  </div>
  <table style="width:100%;border-collapse:collapse;">
    {secoes_html}
  </table>
  <div style="padding:16px 30px;border-top:1px solid #e0dcd4;">
    <p style="font-size:11px;color:#999;">
      Curadoria executada em {hora_brt} (BRT) — TERA / AutomacoesTEC/TERA-LEI<br>
      ⚠ Itens marcados com data não identificada requerem conferência manual.
    </p>
  </div>
</div>
</body></html>
"""

    texto_plano = f"TERA — Curadoria Semanal Tributária\n"
    texto_plano += f"Período: {periodo_str}\nTotal: {total} publicação(ões)\n\n"
    for tema, pubs in resultado.items():
        texto_plano += f"--- {tema} ({len(pubs)}) ---\n"
        for pub in pubs:
            texto_plano += f"  • {pub['titulo'][:100]}\n    {pub['data_publicacao']} | {pub['link']}\n"
        texto_plano += "\n"

    msg = MIMEMultipart("alternative")
    msg["From"] = gmail_user
    msg["To"] = EMAIL_DESTINATARIO
    msg["Subject"] = f"📋 TERA — Curadoria Semanal {periodo_str} — {total} publicações"
    msg.attach(MIMEText(texto_plano, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(gmail_user, gmail_password)
            server.sendmail(gmail_user, EMAIL_DESTINATARIO, msg.as_string())
        log(f"  ✓ Email enviado para {EMAIL_DESTINATARIO}")
        return True
    except Exception as e:
        log(f"  ✗ Erro ao enviar email: {e}")
        return False


# ─────────────────────────────────────────────────────────────────────────────
# EXECUÇÃO PRINCIPAL
# ─────────────────────────────────────────────────────────────────────────────
def main():
    inicio, fim = calcular_periodo_semana()
    log(f"═══ TERA Curadoria Semanal — {inicio.strftime('%d/%m/%Y')} a {fim.strftime('%d/%m/%Y')} ═══")
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    resultado: dict[str, list[dict]] = {}

    log("[1/16] Lei Ordinária (Planalto)...")
    resultado["Lei Ordinária"] = scrape_planalto(
        "https://www4.planalto.gov.br/legislacao/portal-legis/legislacao-1/leis-ordinarias/2026-leis-ordinarias",
        inicio, fim, "Lei Ordinária"
    )

    log("[2/16] Decreto (Planalto)...")
    resultado["Decreto"] = scrape_planalto(
        "https://www4.planalto.gov.br/legislacao/portal-legis/legislacao-1/decretos1/2026-decretos",
        inicio, fim, "Decreto"
    )

    log("[3/16] Lei Complementar (Planalto)...")
    resultado["Lei Complementar"] = scrape_planalto(
        "https://www4.planalto.gov.br/legislacao/portal-legis/legislacao-1/leis-complementares-1/todas-as-leis-complementares-1",
        inicio, fim, "Lei Complementar"
    )

    log("[4/16] Medida Provisória (Planalto)...")
    resultado["Medida Provisória"] = scrape_planalto(
        "https://www4.planalto.gov.br/legislacao/portal-legis/legislacao-1/medidas-provisorias/2023-a-2026",
        inicio, fim, "Medida Provisória"
    )

    log("[5/16] Resolução CGSN (SIJUT2)...")
    resultado["Resolução CGSN"] = scrape_sijut2(
        url_base="https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action",
        inicio=inicio, fim=fim,
        fonte_nome="Resolução CGSN",
        tipo_ids="67"
    )

    log("[6/16] Instrução Normativa (SIJUT2)...")
    resultado["Instrução Normativa (IN)"] = scrape_sijut2(
        url_base="https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action",
        inicio=inicio, fim=fim,
        fonte_nome="Instrução Normativa (IN)",
        tipo_ids="42"
    )

    log("[7/16] Ato Declaratório Interpretativo (SIJUT2)...")
    resultado["Ato Declaratório Interpretativo (ADI)"] = scrape_sijut2(
        url_base="https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action",
        inicio=inicio, fim=fim,
        fonte_nome="Ato Declaratório Interpretativo (ADI)",
        tipo_ids="10"
    )

    log("[8/16] Portaria (SIJUT2)...")
    resultado["Portaria"] = scrape_sijut2(
        url_base="https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action",
        inicio=inicio, fim=fim,
        fonte_nome="Portaria",
        tipo_ids="57; 81; 95; 80; 65"
    )

    log("[9/16] Solução de Consulta (SIJUT2)...")
    resultado["Solução de Consulta (SC)"] = scrape_sijut2(
        url_base="https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action",
        inicio=inicio, fim=fim,
        fonte_nome="Solução de Consulta (SC)",
        tipo_ids="72"
    )

    log("[10/16] Parecer Normativo PGFN...")
    resultado["Parecer Normativo PGFN"] = scrape_pgfn_pareceres(inicio, fim)

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

    total_publicacoes = sum(len(v) for v in resultado.values())
    saida = {
        "periodo": {
            "inicio": inicio.isoformat(),
            "fim": fim.isoformat(),
        },
        "gerado_em": AGORA.isoformat(),
        "total_publicacoes": total_publicacoes,
        "temas": len(resultado),
        "resultado": resultado
    }

    with open(SAIDA_SEMANA, "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, indent=2)
    log(f"  ✓ Resultado salvo em {SAIDA_SEMANA}")

    historico = []
    if SAIDA_HISTORICO.exists():
        try:
            with open(SAIDA_HISTORICO, "r", encoding="utf-8") as f:
                historico = json.load(f)
        except Exception:
            historico = []

    historico.insert(0, {
        "periodo": saida["periodo"],
        "gerado_em": saida["gerado_em"],
        "total_publicacoes": total_publicacoes,
        "resumo_por_tema": {k: len(v) for k, v in resultado.items()}
    })
    historico = historico[:52]
    with open(SAIDA_HISTORICO, "w", encoding="utf-8") as f:
        json.dump(historico, f, ensure_ascii=False, indent=2)
    log(f"  ✓ Histórico atualizado ({len(historico)} semana(s) registrada(s))")

    log("")
    log("═══ RELATÓRIO DA CURADORIA ═══")
    log(f"  Período: {inicio.strftime('%d/%m/%Y')} a {fim.strftime('%d/%m/%Y')}")
    log(f"  Total de publicações encontradas: {total_publicacoes}")
    for tema, pubs in resultado.items():
        status = "✓" if pubs else "·"
        log(f"  {status} {tema}: {len(pubs)}")
    log("═══ Concluído ═══")

    enviar_email_curadoria(resultado, inicio, fim)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"ERRO FATAL: {e}")
        traceback.print_exc()
        sys.exit(1)
