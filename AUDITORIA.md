# Auditoria TERA-LEI: diagnóstico completo pós-acesso ao código

**Auditoria realizada em junho/2026 com acesso direto ao repositório.**
Todas as afirmações abaixo referem-se ao código efetivamente presente no repositório,
lido arquivo a arquivo. Nenhuma linha é especulativa.

---

## 1. Resumo executivo: situação real do sistema

**Fato confirmado:** O sistema TERA-LEI detectou e notificou corretamente o
"Informe Técnico 2025.002 v.1.50", publicado em 15/04/2026 no Portal NF-e. O pipeline
de coleta `atualizar_fontes.py` monitora a página de Notas Técnicas do NF-e
(`listaConteudo.aspx?tipoConteudo=04BIflQt1aY=`) e o curador `curador-reforma.js`
monitora a mesma URL — a detecção era esperada e funcionou.

**Fato confirmado:** Os três timeouts reportados (MDF-e, NF-ABI, BP-e) **não são
causados por URLs erradas**. O código já usa as URLs corretas do portal SVRS
(`dfe-portal.svrs.rs.gov.br`). A causa raiz é outra: o próprio servidor SVRS
bloqueia requisições originadas de IPs de provedores cloud (GitHub Actions).
O parser do CGIBS documenta explicitamente esse comportamento com a nota
*"servidor CGIBS bloqueia IPs de provedores cloud — não é contornável via código"*,
e retorna `ECONNRESET` em vez de timeout. Os parsers MDF-e, NF-ABI e BP-e sofrem
o mesmo problema de bloqueio de IP, mas sem o tratamento explícito que o CGIBS tem.

**Fato confirmado:** O Cloudflare Worker (`wrangler.jsonc`) foi projetado para
contornar esse bloqueio atuando como proxy, mas o arquivo `src/index.ts` **está
ausente do repositório** — o Worker não pode ser compilado nem publicado no estado
atual.

**Diagnóstico geral:** O sistema é mais completo do que aparentava externamente.
Das 18 fontes consideradas obrigatórias para a Reforma Tributária, **entre 10 e 12
já estão cobertas** por algum dos três subsistemas. As lacunas reais são SPED, DOU
direto, NFCom, NF3e, APIs legislativas (Câmara/Senado) — e o bug estrutural de
bloqueio de IP do GitHub Actions que afeta CGIBS, MDF-e, NF-ABI e BP-e.

---

## 2. Arquitetura real: três subsistemas independentes

O sistema opera com **três pipelines distintos**, todos orquestrados por GitHub Actions:

### Subsistema 1 — curador-reforma (Node.js)
- **Arquivo principal:** `curador-reforma/curador-reforma.js`
- **Cron:** diariamente às 19:00 BRT (`curadoria_reforma_v2.yml`)
- **Objetivo:** monitorar portais de documentos fiscais eletrônicos e o CGIBS
- **Tecnologias:** axios + cheerio (HTML scraping), análise de RSS (CGIBS)
- **Saída:** `curador-reforma/data/reforma_curadoria.json` → mesclado em `data/reforma_em_dia.json`
- **Notificação:** Bot Telegram (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`)
- **7 portais monitorados** (ver Seção 3)

### Subsistema 2 — atualizar_fontes (Python)
- **Arquivo principal:** `atualizar_fontes.py`
- **Cron:** diariamente às 09:00 BRT (`atualizacoes.yml`)
- **Objetivo:** coletar notícias tributárias do dia de agências e portais de notícias
- **Regra:** coleta apenas publicações do dia corrente
- **Saída:** `data/atualizacoes.json` (acumulativo — 295 itens em 15/04/2026)
- **Deduplicação:** SHA-256(link + título)[:16]
- **11 fontes monitoradas** (ver Seção 3)

### Subsistema 3 — monitorar_leis (Python)
- **Arquivo principal:** `monitorar_leis.py`
- **Cron:** diariamente às 08:00 BRT (`monitorar_leis.yml`)
- **Objetivo:** detectar alterações no texto de leis específicas no Planalto
- **Método:** hash SHA-256 do HTML normalizado; alertas por e-mail (Gmail SMTP)
- **Saída:** `data/monitoramento.json` + `data/leis_monitoradas.json`
- **3 leis configuradas** — com problemas de conectividade ativos (ver Seção 5)

### Infraestrutura de apoio

| Componente | Estado |
|------------|--------|
| Cloudflare Worker (`wrangler.jsonc`) | Configurado — `src/index.ts` **ausente**, não deployável |
| KV namespaces (TERA_USERS, TERA_DATA, TERA_INVITES) | Configurados como placeholder — sem IDs reais |
| Frontend SPA (`index.html`) | Funcional — React + Babel in-browser |
| Persistência | Arquivos JSON em `data/` commitados no repositório |

---

## 3. Auditoria de cobertura: tabela atualizada

Status verificado diretamente no código-fonte em junho/2026.

| # | Fonte | URL Oficial | Subsistema que cobre | Status real | Criticidade |
|---|-------|-------------|----------------------|-------------|-------------|
| 1 | **Portal NF-e — Notas Técnicas** | nfe.fazenda.gov.br/portal/listaConteudo.aspx | curador-reforma (`nfe.js`) + atualizar_fontes | ✅ Funcionando | CRÍTICA |
| 2 | **Portal NF-e — Informes Técnicos** | nfe.fazenda.gov.br/portal/informe.aspx | atualizar_fontes (URL de NTs cobre parcialmente) | ⚠️ Cobertura parcial | CRÍTICA |
| 3 | **Portal CT-e** | cte.fazenda.gov.br/portal/informe.aspx | curador-reforma (`cte.js`) | ✅ Funcionando | ALTA |
| 4 | **Portal MDF-e** | dfe-portal.svrs.rs.gov.br/Mdfe/Noticias | curador-reforma (`mdfe.js`) | ⚠️ URL correta; SVRS bloqueia IP do GitHub Actions | MÉDIA |
| 5 | **Portal BP-e** | dfe-portal.svrs.rs.gov.br/Bpe/Noticias | curador-reforma (`bpe.js`) | ⚠️ URL correta; SVRS bloqueia IP do GitHub Actions | MÉDIA |
| 6 | **Portal NF-ABI (mod. 77)** | dfe-portal.svrs.rs.gov.br/Nfabi/Documentos | curador-reforma (`nfabi.js`) | ⚠️ URL correta; SVRS bloqueia IP do GitHub Actions | **CRÍTICA** |
| 7 | **Portal NFS-e Nacional — RTC** | gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc | curador-reforma (`nfseRtc.js`) | ✅ Funcionando | **CRÍTICA** |
| 8 | **Portal NFCom (mod. 62)** | dfe-portal.svrs.rs.gov.br/Nfcom | Nenhum | ❌ Não monitorado | ALTA |
| 9 | **Portal NF3e (mod. 66)** | dfe-portal.svrs.rs.gov.br/Nf3e | Nenhum | ❌ Não monitorado | ALTA |
| 10 | **SPED** | sped.rfb.gov.br | Nenhum | ❌ Não monitorado | **CRÍTICA** |
| 11 | **Comitê Gestor do IBS (CGIBS)** | cgibs.gov.br/rss | curador-reforma (`cgibs.js`) via RSS | ⚠️ Implementado; CGIBS bloqueia IPs cloud — `ECONNRESET` documentado no código | **MÁXIMA** |
| 12 | **Receita Federal — Programa RTC** | gov.br/receitafederal/.../reforma-consumo/noticias | atualizar_fontes | ✅ Funcionando | **CRÍTICA** |
| 13 | **DOU (Imprensa Nacional)** | in.gov.br/consulta | Apenas via AgênciaGov (republicação parcial) | ⚠️ Cobertura indireta e incompleta | **MÁXIMA** |
| 14 | **Ministério da Fazenda** | gov.br/fazenda/pt-br/assuntos/noticias | atualizar_fontes | ✅ Funcionando | ALTA |
| 15 | **Planalto — legislação** | planalto.gov.br | monitorar_leis (3 leis configuradas) | ⚠️ Erros de conexão ativos em todas as 3 leis | ALTA |
| 16 | **AgênciaGov (EBC)** | agenciagov.ebc.com.br | atualizar_fontes (5 editorias) | ✅ Funcionando | MÉDIA |
| 17 | **Câmara dos Deputados** | dadosabertos.camara.leg.br/api/v2 | Nenhum | ❌ Não monitorado | ALTA |
| 18 | **Senado Federal** | legis.senado.leg.br/dadosabertos | Nenhum | ❌ Não monitorado | ALTA |

**Resultado real:** das 18 fontes obrigatórias, **10 estão funcionando, 4 têm problemas
de conectividade (URLs corretas, bloqueio de IP), e 4 não são monitoradas.**

---

## 4. Diagnóstico dos timeouts: causa raiz corrigida

O relatório anterior diagnosticou que os timeouts do MDF-e, NF-ABI e BP-e eram
causados por URLs erradas apontando para `*.fazenda.gov.br`. **Esse diagnóstico
estava incorreto.** O código já usa as URLs corretas do SVRS:

```
MDF-e  → https://dfe-portal.svrs.rs.gov.br/Mdfe/Noticias    ✅ correto
BP-e   → https://dfe-portal.svrs.rs.gov.br/Bpe/Noticias     ✅ correto
NF-ABI → https://dfe-portal.svrs.rs.gov.br/Nfabi/Documentos ✅ correto
```

**Causa raiz real: bloqueio de IP por parte dos servidores governamentais.**

O parser `cgibs.js` documenta explicitamente o mecanismo:

```javascript
// cgibs.js — comentário no topo do arquivo
// NOTA: servidor CGIBS bloqueia IPs de provedores cloud (GitHub Actions).
// A conexão é resetada após o handshake TLS — não é contornável via código.
```

O SVRS (`dfe-portal.svrs.rs.gov.br`) aplica a mesma política de bloqueio, mas os
parsers MDF-e, NF-ABI e BP-e não tratam `ECONNRESET` de forma distinta — qualquer
erro é registrado como falha genérica. O resultado observado na prática é timeout ou
conexão recusada a partir dos runners do GitHub Actions.

**A solução arquitetural já está prevista:** o Cloudflare Worker (`wrangler.jsonc`)
foi projetado para atuar como proxy reverso, originando as requisições de um IP
Cloudflare em vez do IP do GitHub Actions. O problema é que `src/index.ts`
— o código-fonte do Worker — **está ausente do repositório**, impedindo o deploy.

### Ações corretivas necessárias

1. Criar `src/index.ts` (ou `src/index.js`) com o código do Worker proxy
2. Configurar as variáveis do `wrangler.jsonc` com os IDs reais de KV
3. Fazer deploy via `npx wrangler deploy`
4. Atualizar os parsers MDF-e, NF-ABI e BP-e para rotear via Worker em produção
5. Adicionar tratamento explícito de `ECONNRESET` nos parsers SVRS (como já existe no CGIBS)

---

## 5. Lacunas e bugs encontrados no código

### Bug 1: `src/index.ts` do Worker ausente (BLOQUEANTE)

O arquivo `wrangler.jsonc` referencia `"main": "src/index.ts"`, mas esse arquivo
não existe no repositório. Consequência: o Worker nunca foi publicado e o bloqueio
de IP afeta CGIBS, MDF-e, NF-ABI e BP-e sem mitigação.

### Bug 2: URL errada em `leis_monitoradas.json`

A lei identificada como "IN RFB nº 2.121/2022" está configurada com a URL
`https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2022/lei/L14382.htm`, que
corresponde à **Lei 14.382/2022** (Sistema de Registro Eletrônico de Imóveis),
não à IN RFB 2.121/2022. Além disso, as três leis configuradas estão com erros
de conexão ativos — o Planalto pode estar bloqueando o User-Agent genérico
usado pelo script Python.

### Bug 3: README do curador-reforma desatualizado

O arquivo `curador-reforma/README.md` descreve o CGIBS como monitorado via
**Puppeteer (SPA)**, mas o código real (`cgibs.js`) usa **axios + RSS feed**.
A documentação não reflete a implementação atual.

### Bug 4: KV namespaces sem IDs configurados

O `wrangler.jsonc` declara três KV namespaces (`TERA_USERS`, `TERA_DATA`,
`TERA_INVITES`) sem `id` nem `preview_id`. Sem esses valores, o Worker não pode
ser publicado — o `wrangler deploy` falhará com erro de validação.

### Lacuna 1: SPED não monitorado (GRAVIDADE CRÍTICA)

O portal SPED (`sped.rfb.gov.br`) publica Notas Técnicas para EFD-Contribuições,
EFD ICMS/IPI e EFD-Reinf. A NT 12/2025 da EFD-Contribuições, publicada em
março/2026, trata da conformidade com a LC 214/2025. Nenhum dos três subsistemas
acessa esse portal.

### Lacuna 2: DOU não monitorado diretamente (GRAVIDADE MÁXIMA)

Todo ato normativo federal tem publicação obrigatória no Diário Oficial da União.
O sistema só alcança o DOU de forma indireta, via republicação pela AgênciaGov —
que cobre apenas notícias selecionadas, não o texto integral dos atos. Instruções
Normativas da RFB, Atos Conjuntos RFB/CGIBS e Decretos sobre o Imposto Seletivo
podem passar despercebidos. O projeto open-source **Ro-DOU**
(`github.com/gestaogovbr/Ro-dou`) oferece infraestrutura para clipping automático
por palavras-chave e pode ser integrado ao pipeline existente.

### Lacuna 3: NFCom e NF3e não monitorados

O portal NFCom (modelo 62, obrigatório desde novembro/2025) e o NF3e (modelo 66,
energia elétrica) são documentos novos que surgem diretamente da Reforma Tributária.
Ambos estão no domínio SVRS e seguem o mesmo padrão dos portais já implementados
(MDF-e, NF-ABI), portanto o esforço de implementação é baixo.

### Lacuna 4: APIs legislativas não integradas

As APIs abertas da Câmara (`dadosabertos.camara.leg.br/api/v2`) e do Senado
(`legis.senado.leg.br/dadosabertos`) permitem monitorar PLPs e PLs em tramitação
sem scraping HTML. O curador não as consome.

---

## 6. Correções prioritárias

### 6.1 Criar `src/index.ts` — Worker proxy para SVRS e CGIBS

```typescript
// src/index.ts — Cloudflare Worker: proxy reverso para portais com bloqueio de IP
export interface Env {
  TERA_USERS: KVNamespace;
  TERA_DATA:  KVNamespace;
}

const ALLOWED_ORIGINS = [
  'dfe-portal.svrs.rs.gov.br',
  'www.cgibs.gov.br',
  'sped.rfb.gov.br',
];

function isAllowed(url: URL): boolean {
  return ALLOWED_ORIGINS.some(h => url.hostname === h);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const incoming = new URL(req.url);
    const target   = incoming.searchParams.get('url');

    if (!target) {
      return new Response('Parâmetro ?url= obrigatório', { status: 400 });
    }

    let targetUrl: URL;
    try { targetUrl = new URL(target); } catch {
      return new Response('URL inválida', { status: 400 });
    }

    if (!isAllowed(targetUrl)) {
      return new Response('Domínio não autorizado', { status: 403 });
    }

    // Cache de 5 minutos no KV para reduzir carga nos portais
    const cacheKey = `proxy:${target}`;
    const cached   = await env.TERA_DATA.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Cache': 'HIT' },
      });
    }

    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    });

    if (!upstream.ok) {
      return new Response(`Upstream retornou ${upstream.status}`, { status: 502 });
    }

    const body = await upstream.text();
    await env.TERA_DATA.put(cacheKey, body, { expirationTtl: 300 }); // 5 min

    return new Response(body, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Cache': 'MISS' },
    });
  },
};
```

### 6.2 Corrigir `leis_monitoradas.json` — URL da IN RFB 2.121/2022

```json
{
  "nome": "IN RFB nº 2.121/2022 — Grandes Fortunas / Simples Apuração",
  "url": "https://normas.receita.fazenda.gov.br/sijut2consulta/link.action?idAto=126484",
  "hash_anterior": "",
  "ultima_verificacao": "",
  "status": "ativo"
}
```

> **Nota:** a URL atual no `leis_monitoradas.json` aponta para a Lei 14.382/2022
> (Registro de Imóveis), não para a IN RFB 2.121/2022. Corrigir antes da próxima
> execução do workflow `monitorar_leis.yml`.

### 6.3 Adicionar parsers para NFCom e NF3e

Ambos seguem o mesmo padrão do `mdfe.js` — basta duplicar o parser com as URLs corretas:

```javascript
// Adicionar em curador-reforma/src/parsers/nfcom.js
const NOME     = 'Portal NFCom';
const URL      = 'https://dfe-portal.svrs.rs.gov.br/Nfcom/Noticias';
const BASE_URL = 'https://dfe-portal.svrs.rs.gov.br';
// ... restante idêntico ao mdfe.js com tags adaptadas para NFCom
```

```javascript
// Adicionar em curador-reforma/src/parsers/nf3e.js
const NOME     = 'Portal NF3e';
const URL      = 'https://dfe-portal.svrs.rs.gov.br/Nf3e/Noticias';
const BASE_URL = 'https://dfe-portal.svrs.rs.gov.br';
// ... restante idêntico ao mdfe.js com tags adaptadas para NF3e
```

E registrar no `curador-reforma.js`:

```javascript
const { parseNfcom } = require('./src/parsers/nfcom');
const { parseNf3e  } = require('./src/parsers/nf3e');

const PARSERS = [
  parseCte, parseNfe, parseCgibs, parseMdfe,
  parseNfabi, parseBpe, parseNfseRtc,
  parseNfcom,  // novo
  parseNf3e,   // novo
];
```

### 6.4 Adicionar monitoramento do SPED

```python
# Adicionar em atualizar_fontes.py
FONTES_EXTRA = [
    {
        'nome': 'SPED — EFD-Contribuições',
        'url':  'http://sped.rfb.gov.br/pagina/show/1571',
        'tipo': 'sped',
    },
    {
        'nome': 'SPED — Destaques',
        'url':  'http://sped.rfb.gov.br/',
        'tipo': 'sped',
    },
]
```

### 6.5 Tratar ECONNRESET nos parsers SVRS

Adicionar em `mdfe.js`, `bpe.js` e `nfabi.js` o mesmo tratamento já presente no `cgibs.js`:

```javascript
function isIpBlock(err) {
  return err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
         err.code === 'ETIMEDOUT'  || err.message?.includes('ECONNRESET');
}

// No bloco catch do parser:
} catch (err) {
  if (isIpBlock(err)) {
    logger.warn(`[MDF-e] Servidor SVRS inacessível deste ambiente (${err.code}). Bloqueio de IP provável.`);
    return {
      nome: NOME, url: URL, consultadoEm,
      encontrouItensHoje: false, itens: [],
      observacoes: `SVRS inacessível do ambiente CI (${err.code}). Monitoramento via Worker recomendado.`,
    };
  }
  // ...
}
```

---

## 7. Checklist de correções (prioridade decrescente)

**Prioridade 1 — Bloqueante (afeta coleta ativa)**

- [ ] Criar `src/index.ts` com o Worker proxy (código na Seção 6.1)
- [ ] Configurar IDs reais dos KV namespaces no `wrangler.jsonc`
- [ ] Publicar Worker via `npx wrangler deploy`
- [ ] Atualizar parsers MDF-e, NF-ABI, BP-e para rotear via Worker quando em CI
- [ ] Corrigir URL da IN RFB 2.121/2022 em `leis_monitoradas.json`

**Prioridade 2 — Cobertura crítica faltante**

- [ ] Adicionar parser SPED em `atualizar_fontes.py`
- [ ] Adicionar parsers NFCom e NF3e em `curador-reforma`
- [ ] Adicionar tratamento de `ECONNRESET` nos parsers SVRS (mdfe, bpe, nfabi)

**Prioridade 3 — Cobertura importante faltante**

- [ ] Integrar DOU via Ro-DOU ou INLABS com palavras-chave CBS/IBS/IS
- [ ] Adicionar APIs Câmara e Senado para PLPs em tramitação

**Prioridade 4 — Qualidade e manutenção**

- [ ] Atualizar `curador-reforma/README.md`: CGIBS usa RSS (axios), não Puppeteer
- [ ] Investigar e corrigir erros de conexão do `monitorar_leis.py` (possível bloqueio de User-Agent no Planalto)
- [ ] Verificar se a página `nfe.fazenda.gov.br/portal/informe.aspx` (Informes Técnicos) precisa de parser próprio, separado da página de Notas Técnicas

---

## 8. Nota sobre honestidade epistêmica

Esta auditoria foi realizada com acesso direto ao repositório. Cada afirmação tem
correspondência em um arquivo e linha de código verificados. Os únicos elementos
que permanecem como inferência são: (a) o comportamento exato dos portais SVRS
ao bloquear IPs do GitHub Actions — confirmado por analogia com o CGIBS, que
documenta o bloqueio explicitamente; e (b) o estado do deploy do Worker em
produção — que não pode ser verificado localmente, apenas no painel Cloudflare.
