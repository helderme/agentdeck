<div align="center">

<img src="icon.svg" alt="AgentDeck logo" width="88" />

# AgentDeck

**Your Claude Code & Codex sessions, in one deck.**

A local dashboard to **list, resume and open** your sessions, build multi-repo
**workspaces**, and **watch/stop** what you left running in the background — all
rendered, no PID hunting.

[**🔗 Live site**](https://helderme.github.io/agentdeck/) · [Get started](#get-started) · [Features](#features) · [Português](README.pt-BR.md)

</div>

> Runs **100% local** on `127.0.0.1` — nothing is exposed. A **Linux** tool (uses `ps`/`ss`;
> `code`, `docker`, a browser and a folder picker are optional).

## Get started

You only need **[Bun](https://bun.sh)** — about 2 minutes:

```bash
# 1) install Bun (once)
curl -fsSL https://bun.sh/install | bash

# 2) clone and install — adds a menu shortcut and opens the app
git clone https://github.com/helderme/agentdeck.git
cd agentdeck
./install.sh
```

`install.sh` adds an **AgentDeck** entry to your apps menu (with an icon) and an `agentdeck`
command, then **opens the app** right away (a clean `--app` window via Chromium; without it,
your default browser). To uninstall, delete `~/.local/share/applications/agentdeck.desktop`,
`~/.local/share/icons/hicolor/scalable/apps/agentdeck.svg` and `~/.local/bin/agentdeck`.

**Prefer not to install?** Run `./start.sh` (just opens the window), or `bun server.ts` and
open **http://localhost:7799**. To stop: **Ctrl+C** (doesn't kill Claude's processes, only the
panel). Port taken? `AGENTDECK_PORT=8080 ./start.sh`.

## What you need installed

| Tool | What it's for |
|---|---|
| **Bun** (required) | runs the server (`bun server.ts`) |
| `claude` / `codex` (CLIs) | start a **new session** and the resume command; *listing* works without them |
| Chromium browser (Chrome/Chromium/Brave/Edge) | clean app window; without it, falls back to your default browser |
| A terminal (`gnome-terminal`, `konsole`, `tilix`, `xterm`…) | open the new session in a real terminal |
| `code` (VS Code CLI) | the **Open in VS Code** button (folder + the conversation in the extension) |
| `zenity` / `kdialog` / `yad` | native folder picker |
| `docker` | list/stop containers in the **Processes** tab |
| `iproute2` (`ss`) + `psmisc` (`fuser`) | listening ports and **kill by port** |

Missing an optional one? Only its feature becomes unavailable — everything else runs the same.

## Features

**Sessions** — reads (never modifies) `~/.claude/projects` and `~/.codex/sessions`:
- Title, folder, last message ("where we left off"), origin (terminal/VS Code) and usage/model.
- **● active** when a live process is using that session.
- **Resume** (copies `claude --resume` / `codex resume`) and **Open in VS Code** (opens the
  folder **and** the conversation in the extension, via deep link).
- **New session**: pick the **agent** (Claude/Codex), then **model**, **effort** and
  **permission mode** — opens a terminal already with the flags.
- **Favorite (★)**, **pin (📌)**, **archive**, **rename** and **export/import** sessions
  (`.json`, with a heads-up about possible secrets).
- Filter by title/folder, pagination (20 at a time) and an **account chip** (email/plan —
  never the token).

**Workspaces** — group project folders and:
- **Open them all in VS Code** (multi-root window), or
- **open a single session aware of every repo** (root + the others via `--add-dir`), or
- **filter** the sessions by that workspace.

**Processes** — what's still running in the background:
- Processes started by Claude/by the panel, with PID, uptime, port and folder (cwd).
- **Stop** (by PID, port or container), **restart**, view the **log**, and **start** a new
  process (pick the folder + type the command).

**Light/dark** theme (follows your system) and **language** (English by default, with a
button to switch to Portuguese). Visual in the [Impeccable](https://impeccable.style/) style.

## Configuration

| Variable | Default | What |
|---|---|---|
| `AGENTDECK_PORT` | `7799` | the panel's port |

## Security

The panel **runs local commands** (opens terminals, kills processes, runs what you type),
so it listens **only on `127.0.0.1`** and **must never be exposed** or port-forwarded.
Built-in protections:

- **Loopback bind** + **Host** header validation (blocks DNS rebinding).
- **Origin guard** (Origin/Sec-Fetch-Site, *fail-closed*) on every POST — a web page open
  in your browser can't trigger the actions.
- External commands run via **`execFile`** (no shell) or with **escaped quotes**; `kill`
  only acts on recognized processes; import/export paths are validated.
- It **never** exposes the auth token — only account metadata (email/plan).

## Development

A single `server.ts` file (Bun server + embedded HTML/CSS/JS), no build step and **zero
production dependencies**.

```bash
bun server.ts      # boot the panel
bun test           # tests for the pure parsing/remap functions
bun install && bunx tsc --noEmit   # type-check (optional)
```

## License

[MIT](LICENSE) © Helder Medeiros
