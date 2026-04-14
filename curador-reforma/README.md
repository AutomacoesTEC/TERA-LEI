# TERA Curador Reforma v2

Curador automático de publicações da **Reforma Tributária do Consumo** (EC 132/2023 · LC 214/2025 · LC 227/2026).

Monitora 7 portais fiscais diariamente, coleta publicações do dia, grava JSON estruturado e envia e-mail de resumo.

---

## Portais monitorados

| Portal | URL | Método |
|--------|-----|--------|
| CT-e Informes | https://www.cte.fazenda.gov.br/portal/informe.aspx | cheerio |
| NF-e Notas Técnicas | https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY= | cheerio |
| CGIBS Notícias | https://www.cgibs.gov.br/noticias | **Puppeteer** (SPA) |
| MDF-e Notícias | https://dfe-portal.svrs.rs.gov.br/Mdfe/Noticias | cheerio |
| NF-ABI Documentos | https://dfe-portal.svrs.rs.gov.br/Nfabi/Documentos | cheerio |
| BP-e Notícias | https://dfe-portal.svrs.rs.gov.br/Bpe/Noticias | cheerio |
| NFS-e RTC | https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc | cheerio |

---

## Estrutura do projeto

```
curador-reforma/
├── curador-reforma.js       ← orquestrador principal
├── package.json
├── .env.example             ← modelo de variáveis de ambiente
├── src/
│   ├── parsers/             ← um arquivo por portal (sem parser genérico)
│   │   ├── cte.js
│   │   ├── nfe.js
│   │   ├── cgibs.js
│   │   ├── mdfe.js
│   │   ├── nfabi.js
│   │   ├── bpe.js
│   │   └── nfseRtc.js
│   └── utils/
│       ├── date.js          ← dayjs + timezone BRT
│       ├── email.js         ← Nodemailer + template HTML
│       └── logger.js        ← console + logs/curador.log
├── data/
│   └── reforma_curadoria.json   ← saída da execução
├── logs/
│   └── curador.log
└── pendente-publicacao/     ← cópia dos dias com itens encontrados
```

---

## Execução local

```bash
cp .env.example .env
# edite .env com suas credenciais

npm install
npm start
```

---

## Variáveis de ambiente

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `TELEGRAM_BOT_TOKEN` | Token do bot (via @BotFather) | `123456789:AABBcc...` |
| `TELEGRAM_CHAT_ID` | ID do chat/canal de destino | `-1001234567890` |
| `TIMEZONE` | Fuso horário | `America/Sao_Paulo` |
| `PUPPETEER_ARGS` | Flags do Chromium | `--no-sandbox` |

No GitHub Actions, configure `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` como **Secrets** do repositório.

---

## Formato de saída JSON

```json
{
  "dataVerificacao": "14/04/2026",
  "dataExecucao": "14/04/2026 19:00:00",
  "portais": [
    {
      "nome": "CT-e Informes",
      "url": "https://...",
      "consultadoEm": "14/04/2026 19:00:01",
      "encontrouItensHoje": false,
      "itens": [],
      "observacoes": "Nenhuma publicação encontrada para a data de hoje."
    }
  ],
  "totalItens": 0,
  "totalPortaisVerificados": 7,
  "totalPortaisComItens": 0,
  "totalPortaisSemItens": 7,
  "erros": []
}
```

### Campos de cada item

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `titulo` | string | Título exato da publicação |
| `dataPublicacao` | string | DD/MM/YYYY |
| `url` | string | Link direto para a publicação |
| `resumoCurto` | string | Até 50 palavras, sem opinião jurídica |
| `tags` | string[] | Tags automáticas (IBS, CBS, NT, Schema, RTC…) |
| `portalOrigem` | string | Nome do portal |
| `tipoConteudo` | string | nota técnica / informe / notícia / documentação técnica |
| `confianca` | string | `alta` / `media` / `baixa` |

---

## Comportamento de resiliência

- **Um portal falhando NÃO impede os demais** — cada parser tem try/catch independente
- Retry automático 2× em falhas transitórias (timeout 30s/tentativa)
- Delay de 2,5s entre portais
- E-mail enviado **sempre** — mesmo com 0 itens encontrados
- Erros registrados no campo `erros[]` do JSON e no `logs/curador.log`

---

## Integração com o workflow

O arquivo `curador-reforma/data/reforma_curadoria.json` gerado é lido automaticamente
pelo script Python inline no workflow `curadoria_reforma_v2.yml`, que mescla os itens
novos em `data/reforma_em_dia.json` (deduplicação por hash SHA-256 de url+título).
