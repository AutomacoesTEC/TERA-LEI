# TERA — Caderno Eletrônico de Raciocínio Jurídico

O **TERA** é uma plataforma avançada de gestão de conhecimento jurídico e tributário, projetada para centralizar o monitoramento de legislações, notícias fiscais e o acompanhamento detalhado da **Reforma Tributária do Consumo** (IBS/CBS/IS).

Desenvolvido como uma Single Page Application (SPA) robusta, o sistema combina uma interface intuitiva com automações poderosas baseadas em Python e Node.js para garantir que o profissional do direito esteja sempre atualizado com as fontes oficiais.

---

## 🚀 Funcionalidades Principais

### 1. Biblioteca Jurídica Inteligente
*   **Leitor de Leis:** Visualização estruturada de legislações com suporte a marcações, anotações e anexos.
*   **Parser de Dispositivos:** Identificação automática de Partes, Livros, Títulos, Capítulos, Seções, Artigos, Incisos e Alíneas.
*   **Status de Vigência:** Diferenciação visual entre dispositivos vigentes e revogados.
*   **Busca Geral:** Pesquisa indexada em toda a biblioteca de leis e anotações.

### 2. Monitoramento de Legislação (Python)
*   **Vigilância Diária:** Script `monitorar_leis.py` que verifica alterações nos portais oficiais (Planalto e outros).
*   **Detecção de Mudanças:** Comparação de hashes de conteúdo para identificar atualizações em tempo real.
*   **Alertas por E-mail:** Notificações automáticas via SMTP (Gmail) quando uma lei monitorada sofre alteração.

### 3. Curadoria da Reforma Tributária (Node.js)
*   **Monitoramento de 7 Portais:** Coleta automatizada de Notas Técnicas, Informes e Notícias de portais como CT-e, NF-e, CGIBS, MDF-e, NF-ABI, BP-e e NFS-e.
*   **Resiliência:** Parsers independentes por portal com tratamento de erros e retentativas automáticas.
*   **Notificações via Telegram:** Envio de resumos estruturados diretamente para canais de comunicação.
*   **Deduplicação Inteligente:** Algoritmo de hash SHA-256 para evitar itens duplicados e identificar notas técnicas superadas.

### 4. Atualizações Tributárias e Notícias
*   **Fontes Oficiais e Especializadas:** Coleta diária de notícias da AgênciaGov, CFC, Jota, Ministério da Fazenda e Receita Federal.
*   **Histórico Acumulativo:** Base de dados `data/atualizacoes.json` mantida e atualizada via GitHub Actions.

---

## 🛠️ Arquitetura Técnica

O projeto é organizado em uma estrutura modular que separa a interface do usuário das automações de backend:

*   **Frontend:** SPA monolítica em `index.html` utilizando **React 18**, **Babel** (runtime transpilation) e **D3.js** para visualizações.
*   **Backend/Proxy:** Implementado com **Cloudflare Workers** (`wrangler.jsonc`) para gestão de usuários e persistência em KV (Key-Value).
*   **Automações (GitHub Actions):**
    *   `atualizacoes.yml`: Atualiza notícias tributárias diariamente.
    *   `monitorar_leis.yml`: Verifica mudanças em leis específicas.
    *   `curadoria_reforma_v2.yml`: Executa o curador Node.js e integra os dados da Reforma.

---

## 📂 Estrutura de Pastas

```text
TERA-LEI/
├── index.html              # Interface principal (React SPA)
├── monitorar_leis.py       # Script de monitoramento de legislação
├── atualizar_fontes.py     # Scraper de notícias tributárias
├── data/                   # Base de dados JSON (Leis, Notícias, Reforma)
├── curador-reforma/        # Subprojeto Node.js para curadoria da Reforma
│   ├── curador-reforma.js  # Orquestrador principal
│   └── src/parsers/        # Parsers específicos por portal fiscal
└── .github/workflows/      # Automações do GitHub Actions
```

---

## ⚙️ Configuração e Execução

### Interface (Frontend)
A interface é autocontida no `index.html`. Para desenvolvimento local, basta abrir o arquivo em um navegador ou utilizar um servidor estático simples.

### Automações (Backend)
Para executar os scripts de coleta localmente:

1.  **Python (Monitoramento/Notícias):**
    ```bash
    pip install requests beautifulsoup4
    python monitorar_leis.py
    python atualizar_fontes.py
    ```

2.  **Node.js (Curador Reforma):**
    ```bash
    cd curador-reforma
    npm install
    npm start
    ```

---

## 📄 Licença e Créditos

Desenvolvido por **AutomacoesTEC**.
*TERA — Raciocínio Jurídico*
