# Claude Terminal Control

Painel local pra **ver e finalizar** o que o Claude Code (VSCode) deixou rodando
em background (dev servers, etc.) + containers Docker. Visual renderizado, sem
precisar caçar PID na mão.

## Rodar

```bash
cd "$HOME/Área de trabalho/claude-terminal-control"
bun server.ts        # ou: ./start.sh   (abre o navegador sozinho)
```

Abre **http://localhost:7799**. Duas abas:

**Acompanhar** (atualiza sozinho a cada 2,5s):

- **Processos do Claude** — tudo que foi iniciado via Claude (detectado pela
  assinatura `.claude/shell-snapshots`), com PID, uptime e porta. **Finalizar**
  mata o processo e seus filhos (SIGTERM).
- **Containers Docker** — lista os ativos (ex.: `efex-tur-ddb-local`) com botão **Parar**.

**Sessões** (lidas sob demanda; clique em **Atualizar** para reescanear):

- Lista as sessões do **Claude** (`~/.claude/projects`) e do **Codex**
  (`~/.codex/sessions`), com a **pasta** onde cada uma roda e um **título** do
  que se trata. As fontes ligam/desligam pelos botões Claude/Codex (começa só Claude).
- Filtro por título ou pasta; o ícone de **lápis** renomeia a sessão (título
  customizado em `~/.claude/.terminal-control-names.json`; o automático fica
  preservado e volta se você limpar o nome); o ícone do **VS Code** abre a pasta;
  **Retomar** copia `claude --resume` ou `codex resume`; **Arquivar** tira a sessão
  da lista sem apagar nada (`~/.claude/.terminal-control-archived.json`).

O visual segue o [Impeccable](https://impeccable.style/): paleta quente em OKLCH,
tipografia Fraunces + Hanken Grotesk + JetBrains Mono, sem gradientes nem glows.

## Como funciona

Um HTML sozinho não consegue ler processos nem matar nada (sandbox do navegador).
Então tem um mini-servidor Bun (`server.ts`) que:
- `GET /api/state` → roda `ps` / `ss` / `docker ps` e devolve JSON.
- `GET /api/sessions?sources=claude,codex` → varre as fontes pedidas (default `claude`).
  No Claude, cada sessão é um `.jsonl` no nível raiz de uma pasta de projeto (os `.jsonl`
  aninhados em `<uuid>/subagents/` são subagentes e ficam de fora); título via `aiTitle`,
  com fallback pro 1º prompt. No Codex (`rollout-*.jsonl`), pasta vem do `session_meta`
  e o título do 1º texto do usuário. Ordena da mais recente pra mais antiga.
- `POST /api/open` → `code "<pasta>"`, abre a pasta da sessão no VS Code.
- `POST /api/rename` → grava/remove o nome customizado (chave `fonte:id`).
- `POST /api/archive` → grava/remove a chave `fonte:id` no arquivo de arquivados.
- `POST /api/kill` → `kill` (árvore de processos), `fuser -k <porta>` ou `docker stop`.

Tudo em `127.0.0.1`, nada exposto pra rede. Para fechar o painel: `Ctrl+C`
(isso **não** mata os processos do Claude, só o painel).
