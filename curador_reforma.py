#!/usr/bin/env python3
“””
TERA — Curador Reforma Tributária (v1.0)
Verifica diariamente 8 portais oficiais de publicações da Reforma Tributária
do Consumo (IBS/CBS/IS) e adiciona novos itens ao data/reforma_em_dia.json.

Executado via GitHub Actions diariamente às 19:00 BRT.

Portais monitorados:

1. CT-e Informes (https://www.cte.fazenda.gov.br/portal/informe.aspx)
1. NF-e Notas Técnicas (https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=)
1. CGIBS Notícias (https://www.cgibs.gov.br/noticias)
1. MDF-e Notícias (https://dfe-portal.svrs.rs.gov.br/Mdfe/Noticias)
1. NF-ABI Documentos (https://dfe-portal.svrs.rs.gov.br/Nfabi/Documentos)
1. BP-e Notícias (https://dfe-portal.svrs.rs.gov.br/Bpe/Noticias)
1. RFB RTC Documentação Técnica (https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc)
1. SPED Notícias (https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/declaracoes-e-demonstrativos/sped-sistema-publico-de-escrituracao-digital/noticias)

Saída: data/reforma_em_dia.json (acumulativo)
Email: resumo diário enviado para tectributos.federal11@gmail.com
“””

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
[sys.executable, “-m”, “pip”, “install”, “requests”, “beautifulsoup4”, “–quiet”]
)
import requests
from bs4 import BeautifulSoup

# ── Configurações ────────────────────────────────────────────

BRT = timezone(timedelta(hours=-3))
AGORA = datetime.now(BRT)
DATA_HOJE = AGORA.strftime(”%Y-%m-%d”)
DATA_HOJE_BR = AGORA.strftime(”%d/%m/%Y”)
TIMEOUT = 30
MAX_RETRIES = 2
HEADERS = {
“User-Agent”: “Auditec-Curador/1.0 (Fiscal Compliance)”,
“Accept”: “text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8”,
“Accept-Language”: “pt-BR,pt;q=0.9,en;q=0.5”,
}
DATA_DIR = Path(“data”)
SAIDA = DATA_DIR / “reforma_em_dia.json”
LOG_DIR = Path(“logs”)

# Email

SMTP_HOST = “smtp.gmail.com”
SMTP_PORT = 587
EMAIL_DEST = “tectributos.federal11@gmail.com”

# Tags automáticas por palavra-chave

TAG_RULES = {
“IBS”: [“ibs”, “imposto sobre bens”],
“CBS”: [“cbs”, “contribuição sobre bens”],
“IS”: [“imposto seletivo”, “seletivo”],
“NT”: [“nota técnica”, “nota tecnica”],
“RTC”: [“reforma tributária do consumo”, “rtc”],
“NF-e”: [“nf-e”, “nfe”, “nota fiscal eletrônica”],
“CT-e”: [“ct-e”, “cte”, “conhecimento de transporte”],
“NFS-e”: [“nfs-e”, “nfse”, “nota fiscal de serviço”],
“MDF-e”: [“mdf-e”, “mdfe”, “manifesto”],
“BP-e”: [“bp-e”, “bpe”, “bilhete de passagem”],
“DeRE”: [“dere”, “declaração de regimes”],
“Schema”: [“schema”, “leiaute”, “layout”, “xsd”],
“SPED”: [“sped”, “efd”, “escrituração digital”],
“Split Payment”: [“split payment”, “pagamento dividido”],
“Cashback”: [“cashback”, “devolução”],
“Simples”: [“simples nacional”, “microempresa”],
}

STATS = {“portais_ok”: [], “portais_erro”: [], “total_novos”: 0}

def log(msg):
ts = datetime.now(BRT).strftime(”%H:%M:%S”)
line = f”[{ts}] {msg}”
print(line)
try:
LOG_DIR.mkdir(parents=True, exist_ok=True)
with open(LOG_DIR / “curador.log”, “a”, encoding=“utf-8”) as f:
f.write(line + “\n”)
except Exception:
pass

def item_id(link, titulo):
raw = (link or “”).strip() + “|” + (titulo or “”).strip()
return hashlib.sha256(raw.encode(“utf-8”)).hexdigest()[:16]

def fetch_page(url, custom_headers=None):
headers = {**HEADERS, **(custom_headers or {})}
last_error = None
for attempt in range(1, MAX_RETRIES + 1):
try:
r = requests.get(url, headers=headers, timeout=TIMEOUT)
r.raise_for_status()
r.encoding = r.apparent_encoding or “utf-8”
return BeautifulSoup(r.text, “html.parser”), None
except requests.exceptions.Timeout:
last_error = f”Timeout ({attempt}/{MAX_RETRIES})”
except requests.exceptions.HTTPError as e:
last_error = f”HTTP {e.response.status_code}”
if e.response.status_code in (403, 429):
break
except requests.exceptions.ConnectionError:
last_error = f”Conexão falhou ({attempt}/{MAX_RETRIES})”
except Exception as e:
last_error = str(e)
break
return None, last_error

def extrair_data(texto):
if not texto:
return None
m = re.search(r”(\d{2})/(\d{2})/(\d{4})”, texto)
if m:
return f”{m.group(3)}-{m.group(2)}-{m.group(1)}”
m = re.search(r”(\d{4})-(\d{2})-(\d{2})”, texto)
if m:
return f”{m.group(1)}-{m.group(2)}-{m.group(3)}”
m = re.search(r”/(\d{4})/(\d{2})/(\d{2})/”, texto)
if m:
return f”{m.group(1)}-{m.group(2)}-{m.group(3)}”
meses = {
“janeiro”: “01”, “fevereiro”: “02”, “março”: “03”, “marco”: “03”,
“abril”: “04”, “maio”: “05”, “junho”: “06”, “julho”: “07”,
“agosto”: “08”, “setembro”: “09”, “outubro”: “10”,
“novembro”: “11”, “dezembro”: “12”,
}
m = re.search(r”(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})”, texto, re.IGNORECASE)
if m:
dia = m.group(1).zfill(2)
mes = meses.get(m.group(2).lower())
if mes:
return f”{m.group(3)}-{mes}-{dia}”
return None

def auto_tags(titulo, resumo=””):
texto = ((titulo or “”) + “ “ + (resumo or “”)).lower()
tags = []
for tag, keywords in TAG_RULES.items():
if any(kw in texto for kw in keywords):
tags.append(tag)
return tags if tags else [“RTC”]

def auto_categoria(titulo):
t = (titulo or “”).lower()
if re.search(r”nota\s+t[eé]cnica|nt\s+\d”, t):
return “Nota Técnica”
if re.search(r”ato\s+conjunto|ato\s+normativo|resolução|portaria|instrução”, t):
return “Ato Normativo”
if re.search(r”comunicado|esclarec|orienta”, t):
return “Comunicado”
if re.search(r”lei\s+complementar|decreto|emenda|plp\s+\d”, t):
return “Legislação”
if re.search(r”schema|leiaute|layout|xsd|xml”, t):
return “Sistema”
return “Orientação”

def criar_item(titulo, link, fonte, data=None, resumo=””):
titulo = (titulo or “”).strip()
if not titulo or len(titulo) < 8:
return None
link = (link or “”).strip()
if not link or “javascript:” in link.lower():
return None
data_item = data or DATA_HOJE
return {
“id”: item_id(link, titulo),
“data”: data_item,
“titulo”: titulo[:500],
“categoria”: auto_categoria(titulo),
“tags”: auto_tags(titulo, resumo),
“resumo”: (resumo or “”).strip()[:800],
“fonte”: fonte,
“link”: link,
}

# ── Portal 1: CT-e Informes ─────────────────────────────────

def scrape_cte():
url = “https://www.cte.fazenda.gov.br/portal/informe.aspx”
itens = []
log(“Buscando CT-e Informes…”)
soup, erro = fetch_page(url)
if erro:
log(f”  ✗ {erro}”)
STATS[“portais_erro”].append(f”CT-e: {erro}”)
return itens
try:
links = soup.find_all(“a”, href=True)
seen = set()
for a in links:
href = a.get(“href”, “”).strip()
titulo = a.get_text(strip=True)
if not titulo or len(titulo) < 10:
continue
if href.startswith(”/”):
href = “https://www.cte.fazenda.gov.br” + href
if not href.startswith(“http”) or href in seen:
continue
seen.add(href)
parent = a.find_parent([“tr”, “li”, “div”])
data = None
if parent:
data = extrair_data(parent.get_text())
if not data:
data = extrair_data(href)
if data == DATA_HOJE:
item = criar_item(titulo, href, “Portal CT-e”, data)
if item:
itens.append(item)
log(f”  → {len(itens)} itens de hoje”)
STATS[“portais_ok”].append(“CT-e”)
except Exception as e:
log(f”  ✗ Parsing: {e}”)
STATS[“portais_erro”].append(f”CT-e: {e}”)
return itens

# ── Portal 2: NF-e Notas Técnicas ───────────────────────────

def scrape_nfe():
url = “https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=”
itens = []
log(“Buscando NF-e Notas Técnicas…”)
soup, erro = fetch_page(url)
if erro:
log(f”  ✗ {erro}”)
STATS[“portais_erro”].append(f”NF-e: {erro}”)
return itens
try:
links = soup.find_all(“a”, href=True)
seen = set()
for a in links:
href = a.get(“href”, “”).strip()
titulo = a.get_text(strip=True)
if not titulo or len(titulo) < 10:
continue
if href.startswith(”/”):
href = “https://www.nfe.fazenda.gov.br” + href
elif not href.startswith(“http”):
href = “https://www.nfe.fazenda.gov.br/portal/” + href
if href in seen:
continue
seen.add(href)
data = None
pub_match = re.search(r”[Pp]ublicada?\s+em\s+(\d{2}/\d{2}/\d{4})”, titulo)
if pub_match:
data = extrair_data(pub_match.group(1))
if not data:
parent = a.find_parent([“tr”, “li”, “div”])
if parent:
for td in parent.find_all(“td”):
data = extrair_data(td.get_text())
if data:
break
if data == DATA_HOJE:
item = criar_item(titulo, href, “Portal NF-e”, data)
if item:
itens.append(item)
log(f”  → {len(itens)} itens de hoje”)
STATS[“portais_ok”].append(“NF-e”)
except Exception as e:
log(f”  ✗ Parsing: {e}”)
STATS[“portais_erro”].append(f”NF-e: {e}”)
return itens

# ── Portal 3: CGIBS ─────────────────────────────────────────

def scrape_cgibs():
url = “https://www.cgibs.gov.br/noticias”
itens = []
log(“Buscando CGIBS Notícias…”)
soup, erro = fetch_page(url)
if erro:
log(f”  ✗ {erro}”)
STATS[“portais_erro”].append(f”CGIBS: {erro}”)
return itens
try:
articles = soup.select(“article, .news-item, .card, .post, li, .item”)
if not articles:
main = soup.select_one(“main, #content, .content”)
if main:
articles = main.find_all([“article”, “div”, “li”], recursive=True)
seen = set()
for art in articles:
a_tag = art.find(“a”, href=True)
if not a_tag:
continue
href = a_tag.get(“href”, “”).strip()
titulo = a_tag.get_text(strip=True)
if not titulo or len(titulo) < 10:
continue
if href.startswith(”/”):
href = “https://www.cgibs.gov.br” + href
if not href.startswith(“http”) or href in seen:
continue
seen.add(href)
data = None
for sel in [“time”, “.date”, “.data”, “span.date”]:
el = art.select_one(sel)
if el:
dt = el.get(“datetime”, “”)
data = extrair_data(dt) or extrair_data(el.get_text())
if data:
break
if not data:
data = extrair_data(art.get_text())
if not data:
data = extrair_data(href)
if data == DATA_HOJE:
resumo = “”
p = art.select_one(“p, .resumo, .excerpt”)
if p and p != a_tag:
resumo = p.get_text(strip=True)
item = criar_item(titulo, href, “CGIBS”, data, resumo)
if item:
itens.append(item)
log(f”  → {len(itens)} itens de hoje”)
STATS[“portais_ok”].append(“CGIBS”)
except Exception as e:
log(f”  ✗ Parsing: {e}”)
STATS[“portais_erro”].append(f”CGIBS: {e}”)
return itens

# ── Portais 4-6: SVRS (MDF-e, NF-ABI, BP-e) ────────────────

def scrape_svrs(path, nome):
url = f”https://dfe-portal.svrs.rs.gov.br/{path}”
itens = []
log(f”Buscando {nome}…”)
soup, erro = fetch_page(url)
if erro:
log(f”  ✗ {erro}”)
STATS[“portais_erro”].append(f”{nome}: {erro}”)
return itens
try:
articles = soup.select(“article, .news-item, .card, li, tr, .item”)
seen = set()
for art in articles:
a_tag = art.find(“a”, href=True)
if not a_tag:
continue
href = a_tag.get(“href”, “”).strip()
titulo = a_tag.get_text(strip=True)
if not titulo or len(titulo) < 10:
continue
if href.startswith(”/”):
href = “https://dfe-portal.svrs.rs.gov.br” + href
if not href.startswith(“http”) or href in seen:
continue
seen.add(href)
data = None
for sel in [“time”, “.date”, “td”]:
el = art.select_one(sel)
if el:
data = extrair_data(el.get_text())
if data:
break
if not data:
data = extrair_data(art.get_text())
if data == DATA_HOJE:
item = criar_item(titulo, href, nome, data)
if item:
itens.append(item)
log(f”  → {len(itens)} itens de hoje”)
STATS[“portais_ok”].append(nome)
except Exception as e:
log(f”  ✗ Parsing: {e}”)
STATS[“portais_erro”].append(f”{nome}: {e}”)
return itens

# ── Portal 7: RFB RTC / NFS-e ───────────────────────────────

def scrape_rfb_rtc():
url = “https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc”
itens = []
log(“Buscando RFB RTC / NFS-e…”)
soup, erro = fetch_page(url)
if erro:
log(f”  ✗ {erro}”)
STATS[“portais_erro”].append(f”RFB RTC: {erro}”)
return itens
try:
links = soup.find_all(“a”, href=True)
seen = set()
for a in links:
href = a.get(“href”, “”).strip()
titulo = a.get_text(strip=True)
if not titulo or len(titulo) < 8:
continue
if href.startswith(”/”):
href = “https://www.gov.br” + href
if not href.startswith(“http”) or href in seen:
continue
seen.add(href)
parent = a.find_parent([“tr”, “li”, “div”, “article”])
data = None
if parent:
data = extrair_data(parent.get_text())
if data == DATA_HOJE:
item = criar_item(titulo, href, “Portal NFS-e/RTC”, data)
if item:
itens.append(item)
log(f”  → {len(itens)} itens de hoje”)
STATS[“portais_ok”].append(“RFB RTC”)
except Exception as e:
log(f”  ✗ Parsing: {e}”)
STATS[“portais_erro”].append(f”RFB RTC: {e}”)
return itens

# ── Portal 8: SPED Notícias ─────────────────────────────────

def scrape_sped():
url = “https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/declaracoes-e-demonstrativos/sped-sistema-publico-de-escrituracao-digital/noticias”
itens = []
log(“Buscando SPED Notícias…”)
soup, erro = fetch_page(url)
if erro:
log(f”  ✗ {erro}”)
STATS[“portais_erro”].append(f”SPED: {erro}”)
return itens
try:
articles = soup.select(
“article, .tileItem, .listagem-item, li.item, .news-item”
)
if not articles:
content = soup.select_one(”#content, main, .content-area”)
if content:
articles = content.find_all([“article”, “li”, “div”], recursive=True)
seen = set()
for art in articles:
a_tag = art if art.name == “a” else art.find(“a”, href=True)
if not a_tag:
continue
href = a_tag.get(“href”, “”).strip()
titulo = a_tag.get_text(strip=True)
if not titulo or len(titulo) < 15:
continue
if href.startswith(”/”):
href = “https://www.gov.br” + href
if not href.startswith(“http”) or href in seen:
continue
seen.add(href)
data = None
parent = a_tag.find_parent([“li”, “article”, “div”])
if parent:
for sel in [”.date”, “time”, “span.text-muted”]:
el = parent.select_one(sel)
if el:
data = extrair_data(el.get_text())
if data:
break
if not data:
data = extrair_data(parent.get_text())
if not data:
data = extrair_data(href)
if data == DATA_HOJE:
resumo = “”
if parent:
p = parent.select_one(”.descricao, p, .resumo”)
if p and p != a_tag:
resumo = p.get_text(strip=True)
item = criar_item(titulo, href, “SPED”, data, resumo)
if item:
itens.append(item)
log(f”  → {len(itens)} itens de hoje”)
STATS[“portais_ok”].append(“SPED”)
except Exception as e:
log(f”  ✗ Parsing: {e}”)
STATS[“portais_erro”].append(f”SPED: {e}”)
return itens

# ── Email de resumo diário ───────────────────────────────────

def enviar_email(novos_count, total):
gmail_user = os.environ.get(“GMAIL_USER”, “”).strip()
gmail_pass = os.environ.get(“GMAIL_APP_PASSWORD”, “”).strip()
if not gmail_user or not gmail_pass:
log(”  ⚠ Email não enviado: credenciais não configuradas.”)
return False
try:
msg = MIMEMultipart(“alternative”)
msg[“From”] = gmail_user
msg[“To”] = EMAIL_DEST
msg[“Subject”] = f”Reforma Tributária - Verificação {DATA_HOJE_BR}”

```
    corpo = (
        f"Verificados 8 portais. {novos_count} itens encontrados.\n\n"
        f"Portais OK: {', '.join(STATS['portais_ok']) or 'nenhum'}\n"
    )
    if STATS["portais_erro"]:
        corpo += f"Portais com erro: {', '.join(STATS['portais_erro'])}\n"
    corpo += f"\nTotal acumulado: {total} publicações no histórico.\n"
    corpo += f"Acesse data/reforma_em_dia.json para revisar.\n"

    msg.attach(MIMEText(corpo, "plain", "utf-8"))

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as server:
        server.ehlo()
        server.starttls()
        server.login(gmail_user, gmail_pass)
        server.sendmail(gmail_user, EMAIL_DEST, msg.as_string())

    log(f"  ✓ Email enviado para {EMAIL_DEST}")
    return True
except Exception as e:
    log(f"  ✗ Erro no email: {e}")
    return False
```

# ── Main ─────────────────────────────────────────────────────

def main():
log(f”═══ TERA Curador Reforma v1.0 — {DATA_HOJE_BR} ═══”)
DATA_DIR.mkdir(parents=True, exist_ok=True)

```
# Carregar histórico
historico = []
meta = {}
if SAIDA.exists():
    try:
        with open(SAIDA, "r", encoding="utf-8") as f:
            dados = json.load(f)
            historico = dados.get("itens", [])
            meta = {k: v for k, v in dados.items() if k != "itens"}
            log(f"Histórico: {len(historico)} itens existentes")
    except Exception as e:
        log(f"⚠ Erro no histórico: {e}")

# Coletar de todos os portais
novos = []

for fn in [
    scrape_cte, scrape_nfe, scrape_cgibs,
    lambda: scrape_svrs("Mdfe/Noticias", "MDF-e"),
    lambda: scrape_svrs("Nfabi/Documentos", "NF-ABI"),
    lambda: scrape_svrs("Bpe/Noticias", "BP-e"),
    scrape_rfb_rtc, scrape_sped,
]:
    try:
        import time
        novos.extend(fn())
        time.sleep(2)  # Delay entre portais
    except Exception as e:
        log(f"  ✗ Erro fatal: {e}")

# Deduplicar
ids_existentes = {item["id"] for item in historico}
adicionados = 0
for item in novos:
    if item["id"] not in ids_existentes:
        historico.append(item)
        ids_existentes.add(item["id"])
        adicionados += 1

STATS["total_novos"] = adicionados
historico.sort(key=lambda x: x.get("data", ""), reverse=True)

# Salvar
saida = {
    **meta,
    "ultima_atualizacao": AGORA.isoformat(),
    "itens": historico,
}
with open(SAIDA, "w", encoding="utf-8") as f:
    json.dump(saida, f, ensure_ascii=False, indent=2)

# Email (SEMPRE, mesmo com 0 itens)
enviar_email(adicionados, len(historico))

# Relatório
log("")
log("═══ RELATÓRIO ═══")
log(f"  Portais OK: {len(STATS['portais_ok'])}")
if STATS["portais_erro"]:
    log(f"  Portais com erro: {len(STATS['portais_erro'])}")
    for e in STATS["portais_erro"]:
        log(f"    ✗ {e}")
log(f"  Novos itens: {adicionados}")
log(f"  Total acumulado: {len(historico)}")
log("═══ Concluído ═══")
```

if **name** == “**main**”:
try:
main()
except Exception as e:
log(f”ERRO FATAL: {e}”)
traceback.print_exc()
sys.exit(1)
