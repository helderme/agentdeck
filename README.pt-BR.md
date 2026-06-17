<div align="center">

<img src="icon.svg" alt="logo do AgentDeck" width="88" />

# AgentDeck

**Suas sessões do Claude Code e do Codex, em um deck.**

Painel local pra **listar, retomar e abrir** suas sessões, montar **workspaces**
multi-repo e **ver/finalizar** o que ficou rodando em background — tudo renderizado,
sem caçar PID no terminal.

[**🔗 Site**](https://helderme.github.io/agentdeck/) · [Começar](#começar) · [Features](#features) · [English](README.md)

</div>

> Roda **100% local** em `127.0.0.1` — nada é exposto pra fora. Ferramenta de **Linux**
> (usa `ps`/`ss`; `code`, `docker`, navegador e seletor de pasta são opcionais).

## Começar

Só precisa do **[Bun](https://bun.sh)** — uns 2 minutos:

```bash
# 1) instale o Bun (uma vez só)
curl -fsSL https://bun.sh/install | bash

# 2) clone e instale — coloca no menu e já abre o app
git clone https://github.com/helderme/agentdeck.git
cd agentdeck
./install.sh
```

O `install.sh` coloca um atalho **AgentDeck** no menu de aplicativos (com ícone) e o comando
`agentdeck`, e **já abre o app** (janela `--app` limpa via Chromium; sem ele, o navegador
padrão). Pra desinstalar, apague `~/.local/share/applications/agentdeck.desktop`,
`~/.local/share/icons/hicolor/scalable/apps/agentdeck.svg` e `~/.local/bin/agentdeck`.

**Não quer instalar?** Rode `./start.sh` (só abre a janela), ou `bun server.ts` e abra
**http://localhost:7799**. Pra parar: **Ctrl+C** (não mata os processos do Claude, só o
painel). Porta ocupada? `AGENTDECK_PORT=8080 ./start.sh`.

## O que precisa instalado

| Ferramenta | Pra quê |
|---|---|
| **Bun** (obrigatório) | roda o servidor (`bun server.ts`) |
| `claude` / `codex` (CLIs) | abrir uma **nova sessão** e o comando de retomar; a *listagem* funciona sem eles |
| Navegador Chromium (Chrome/Chromium/Brave/Edge) | janela de app limpa; sem ele cai pro navegador padrão |
| Um terminal (`gnome-terminal`, `konsole`, `tilix`, `xterm`…) | abrir a nova sessão num terminal real |
| `code` (VS Code CLI) | botão **Abrir no VS Code** (pasta + a conversa na extensão) |
| `zenity` / `kdialog` / `yad` | seletor de pasta nativo |
| `docker` | listar/parar containers na aba **Processos** |
| `iproute2` (`ss`) + `psmisc` (`fuser`) | portas em escuta e **finalizar por porta** |

Faltou alguma opcional? A feature correspondente só fica indisponível — o resto roda igual.

## Features

**Sessões** — lê (não modifica) `~/.claude/projects` e `~/.codex/sessions`:
- Título, pasta, última mensagem ("onde paramos"), origem (terminal/VS Code) e uso/modelo.
- **● ativa** quando um processo vivo está usando aquela sessão.
- **Retomar** (copia `claude --resume` / `codex resume`) e **Abrir no VS Code** (abre a
  pasta **e** a conversa na extensão, por deep link).
- **Nova sessão**: escolhe o **agente** (Claude/Codex) e então **modelo**, **effort** e
  **modo de permissão** — abre num terminal já com as flags.
- **Favoritar (★)**, **fixar (📌)**, **arquivar**, **renomear** e **exportar/importar**
  sessões (`.json`, com aviso de possíveis segredos).
- Filtro por título/pasta, paginação (20 por vez) e **chip de conta** (e-mail/plano —
  nunca o token).

**Workspaces** — agrupe pastas de projetos e:
- **Abra tudo no VS Code** (janela multi-root), ou
- **abra uma sessão só ciente de todos os repos** (raiz + os outros via `--add-dir`), ou
- **filtre** as sessões por aquele workspace.

**Processos** — o que ficou rodando em background:
- Processos iniciados pelo Claude/pela plataforma, com PID, tempo, porta e pasta (cwd).
- **Finalizar** (por PID, porta ou container), **reiniciar**, ver **log** e **iniciar**
  um processo novo (escolhe a pasta + digita o comando).

Tema **claro/escuro** (segue o sistema) e **idioma** (inglês por padrão, com botão pra
trocar pra português). Visual no estilo [Impeccable](https://impeccable.style/).

## Configuração

| Variável | Default | O quê |
|---|---|---|
| `AGENTDECK_PORT` | `7799` | porta do painel |

## Segurança

O painel **executa comandos locais** (abre terminais, mata processos, roda o que você
digitar), então roda **só em `127.0.0.1`** e **nunca deve ser exposto** nem ter a porta
encaminhada. As proteções embutidas:

- **Bind em loopback** + validação do header **Host** (barra DNS rebinding).
- **Guard de origem** (Origin/Sec-Fetch-Site, *fail-closed*) em todos os POST — uma página
  web aberta no navegador não consegue acionar as ações.
- Comandos externos rodam por **`execFile`** (sem shell) ou com **aspas escapadas**; `kill`
  só atua sobre processos reconhecidos; caminhos de import/export são validados.
- **Nunca** expõe o token de autenticação — só metadados de conta (e-mail/plano).

## Desenvolvimento

Arquivo único `server.ts` (servidor Bun + HTML/CSS/JS embutidos), sem build e **zero
dependências de produção**.

```bash
bun server.ts      # sobe o painel
bun test           # testes das funções puras de parsing/remap
bun install && bunx tsc --noEmit   # checagem de tipos (opcional)
```

## Licença

[MIT](LICENSE) © Helder Medeiros
