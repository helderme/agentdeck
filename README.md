# AgentDeck

Painel local pra **listar e retomar as sessões** do Claude Code e do Codex (com
pasta, título e uso) e **ver/finalizar** o que ficou rodando em background (dev
servers, containers Docker). Visual renderizado, sem precisar caçar PID na mão.
O acento muda conforme as fontes ativas: só Claude (laranja), só Codex (verde),
ambos (azul).

## Rodar

Precisa do **[Bun](https://bun.sh)**. É uma ferramenta de **Linux** (usa `ps`/`ss`; `docker`,
`code` e `xdg-open` são opcionais — sem eles a feature correspondente só fica vazia).

```bash
# 1) instale o Bun (uma vez só)
curl -fsSL https://bun.sh/install | bash

# 2) clone e rode
git clone https://github.com/medeiroshelder/agentdeck.git
cd agentdeck
./start.sh           # sobe o painel e abre o navegador sozinho
```

Sem o `start.sh`, dá pra rodar direto com `bun server.ts`. Abre em
**http://localhost:7799**. Pra parar: **Ctrl+C** (não mata os processos do Claude, só o painel).

## Instalar como app (atalho no menu)

```bash
./install.sh
```

Cria um atalho **AgentDeck** no menu de aplicativos (com ícone) e o comando `agentdeck`
no terminal. Clicar no atalho sobe o servidor (se preciso) e abre numa **janela de app
limpa** — sem barra de endereço nem abas — usando o modo `--app` de um navegador
**Chromium** (Chrome/Chromium/Brave/Edge). Só com Firefox, cai pra uma aba normal.
O `start.sh` faz o mesmo. Pra desinstalar: apague `~/.local/share/applications/agentdeck.desktop`,
`~/.local/share/icons/hicolor/scalable/apps/agentdeck.svg` e `~/.local/bin/agentdeck`.

Duas abas, abrindo em **Sessões**:

**Sessões** (lidas sob demanda; clique em **Atualizar** para reescanear):

- Lista as sessões do **Claude** (`~/.claude/projects`) e do **Codex**
  (`~/.codex/sessions`), com a **pasta** onde cada uma roda e um **título** do
  que se trata. As fontes ligam/desligam pelos botões Claude/Codex (começa só Claude).
- Marca **● ativa** a sessão sendo escrita agora (arquivo tocado nos últimos 90s)
  ou citada por um processo vivo (ex.: `claude --resume <id>`). Mostra também um
  trecho da **última mensagem** ("onde paramos") abaixo do título, a **origem**
  (`terminal` ou `VS Code`, do campo `entrypoint`) e o **total de tokens** da sessão
  (saída no chip; entrada/cache no tooltip). Origem é só informativa — o resume
  funciona nas duas superfícies (CLI e extensão compartilham `~/.claude/projects`).
  O ícone do **VS Code** abre a pasta **e** a conversa na extensão (deep link por sessão).
- No cabeçalho, um **chip de conta** mostra quem está logado no Claude (nome · org ·
  plano, lido de `~/.claude.json` + `~/.claude/.credentials.json`); fica vermelho se
  não houver login. O token de auth nunca é exposto — só nome/org/plano e a validade.
- A **estrela** (★) favorita e o **pino** (📌) fixa a sessão no topo da lista
  (filtro "Favoritas" no cabeçalho; estado em `~/.claude/.terminal-control-flags.json`).
- Filtro por título ou pasta; **clicar no chip da pasta** filtra por aquele projeto.
  Atalhos de teclado: **`/`** foca a busca, **Esc** limpa, **Enter** retoma a 1ª da lista.
  O ícone de **lápis** renomeia a sessão (título customizado em
  `~/.claude/.terminal-control-names.json`; o automático fica preservado e volta se
  você limpar o nome). As ações são **ícones com tooltip** (passe o mouse): abrir no
  **VS Code**, **exportar** a sessão num `.json` (avisa se achar possíveis segredos),
  **retomar** (ícone de terminal — copia `claude --resume` / `codex resume` pro terminal)
  e **arquivar** (tira da lista sem apagar nada; `~/.claude/.terminal-control-archived.json`).
- **Importar** (botão no cabeçalho) carrega um `.json` exportado e abre um modal com
  **preview** do remap (home, cwd, pasta codificada) — nada é escrito até você confirmar.
  Apontamentos fora da home aparecem pra você ignorar/ajustar.

**Processos** (atualiza a cada **2,5s** com a aba aberta; em segundo plano cai pra
**20s** e **pausa** quando a janela fica oculta — não fica martelando `ps`/`ss`/`docker` à toa):

- **Processos do Claude** — tudo que foi iniciado via Claude (detectado pela
  assinatura `.claude/shell-snapshots`), com PID, uptime e porta. **Finalizar**
  mata o processo e seus filhos (SIGTERM).
- **Containers Docker** — lista os ativos (ex.: `efex-tur-ddb-local`) com botão **Parar**.

O visual segue o [Impeccable](https://impeccable.style/): paleta quente em OKLCH,
tipografia Fraunces + Hanken Grotesk + JetBrains Mono, sem gradientes nem glows.
Tem **tema claro e escuro** (botão sol/lua; segue o sistema por padrão, lembra a
escolha; `?theme=light|dark` força um). Renomear é **inline** (lápis após o título).

## Como funciona

Um HTML sozinho não consegue ler processos nem matar nada (sandbox do navegador).
Então tem um mini-servidor Bun (`server.ts`) que:
- `GET /api/state` → roda `ps` / `ss` / `docker ps` e devolve JSON.
- `GET /api/account` → conta logada (e-mail, org, plano, validade do token) de `~/.claude.json`
  + `~/.claude/.credentials.json`. **Nunca** devolve o token/segredo, só os metadados.
- `GET /api/sessions?sources=claude,codex` → varre as fontes pedidas (default `claude`).
  No Claude, cada sessão é um `.jsonl` no nível raiz de uma pasta de projeto (os `.jsonl`
  aninhados em `<uuid>/subagents/` são subagentes e ficam de fora); título via `aiTitle`,
  com fallback pro 1º prompt. No Codex (`rollout-*.jsonl`), pasta vem do `session_meta`
  e o título do 1º texto do usuário. Ordena da mais recente pra mais antiga. O scan tem
  **cache por mtime** (só relê/grep o que mudou) e lotea o `grep` pra não estourar `ARG_MAX`.
- `POST /api/open` → abre a pasta no VS Code via `execFile` (sem shell). Pra sessões do
  Claude, ~1,5s depois dispara o deep link `vscode://anthropic.claude-code/open?session=<id>`
  (via `xdg-open`/`open`) pra extensão já abrir naquela conversa — sem precisar caçar no histórico.
- `POST /api/rename` → grava/remove o nome customizado (chave `fonte:id`).
- `POST /api/archive` → grava/remove a chave `fonte:id` no arquivo de arquivados.
- `POST /api/kill` → `kill` (árvore de processos), `fuser -k <porta>` ou `docker stop`.

**Segurança.** Tudo em `127.0.0.1`, mas isso não basta: os POSTs checam **Origin/
Sec-Fetch-Site** (barra CSRF de qualquer aba aberta na máquina), os comandos rodam
por `execFile` (sem `/bin/sh`, imune a `$()`/aspas), `kill` só aceita PID que ainda
é tarefa do Claude, e o import valida caminhos contra **path-traversal**. Os arquivos
de estado (favoritos/nomes/arquivados) são gravados de forma **atômica** (tmp+rename).
Para fechar o painel: `Ctrl+C` (isso **não** mata os processos do Claude, só o painel).

## Desenvolvimento

`bun server.ts` sobe o painel; nada de build. As funções puras de parsing/remap
têm testes: `bun test`. Checagem de tipos (opcional): `bun install` e `bunx tsc --noEmit`.
