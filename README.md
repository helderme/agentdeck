# Claude Terminal Control

Painel local pra **ver e finalizar** o que o Claude Code (VSCode) deixou rodando
em background (dev servers, etc.) + containers Docker. Visual renderizado, sem
precisar caçar PID na mão.

## Rodar

```bash
cd "$HOME/Área de trabalho/claude-terminal-control"
bun server.ts        # ou: ./start.sh   (abre o navegador sozinho)
```

Abre **http://localhost:7799**. Atualiza sozinho a cada 2,5s.

- **Processos do Claude** — tudo que foi iniciado via Claude (detectado pela
  assinatura `.claude/shell-snapshots`), com PID, uptime e porta. Botão
  **Finalizar** mata o processo + filhos (SIGTERM).
- **Containers Docker** — lista os ativos (ex.: `efex-tur-ddb-local`) com botão **Parar**.
- **Sessões do Claude** — todas as sessões do Claude Code na máquina, com a **pasta**
  onde cada uma roda e um **título** do que se trata. Tem campo de filtro (por título
  ou pasta) e o botão **Retomar**, que copia o `claude --resume <id>` da sessão.
  Carrega sob demanda — clique em **↻ Atualizar** para reescanear.

## Como funciona

Um HTML sozinho não consegue ler processos nem matar nada (sandbox do navegador).
Então tem um mini-servidor Bun (`server.ts`) que:
- `GET /api/state` → roda `ps` / `ss` / `docker ps` e devolve JSON.
- `GET /api/sessions` → varre `~/.claude/projects`. Cada sessão é um `.jsonl` no
  nível raiz de uma pasta de projeto (os `.jsonl` aninhados em `<uuid>/subagents/`
  são subagentes e ficam de fora). Por sessão, extrai via `grep`: a pasta real (`cwd`),
  o título (`aiTitle`, com fallback pro 1º prompt do usuário) e o horário de
  modificação. Ordena da mais recente pra mais antiga.
- `POST /api/kill` → `kill` (árvore de processos), `fuser -k <porta>` ou `docker stop`.

Tudo em `127.0.0.1` — nada exposto pra rede. Pra fechar o painel: `Ctrl+C`
(isso **não** mata os processos do Claude, só o painel).
