#!/usr/bin/env bash
# AgentDeck — sobe o painel (se ainda não estiver no ar) e abre numa janela de "app",
# sem barra de endereço/abas, via o modo --app do Chromium. Sem navegador Chromium,
# cai pra uma aba normal do navegador padrão.

# resolve symlink (ex.: chamado via ~/.local/bin/agentdeck) → vai pra pasta real do repo
cd "$(dirname "$(readlink -f "$0")")" || exit 1
# o GNOME não carrega ~/.bashrc, então o PATH gráfico pode não ter bun nem ~/.local/bin
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
# porta configurável (mesma var que o server.ts lê); default 7799
export AGENTDECK_PORT="${AGENTDECK_PORT:-7799}"
PORT="$AGENTDECK_PORT"
URL="http://localhost:$PORT"

listening() { ss -ltn 2>/dev/null | grep -q ":$PORT "; }

# 0) se já tem um servidor no ar mas é de uma versão antiga (ex.: depois de git pull),
#    reinicia pra carregar o código novo — senão o usuário fica "preso" na versão velha.
if listening; then
  running="$(curl -fsS "$URL/api/version" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  current="$(git rev-parse HEAD 2>/dev/null)"
  if [ -n "$running" ] && [ -n "$current" ] && [ "$running" != "$current" ]; then
    echo "AgentDeck no ar está desatualizado ($running) — reiniciando para $current…"
    fuser -k "$PORT/tcp" 2>/dev/null || true
    for _ in $(seq 1 30); do listening || break; sleep 0.1; done
  fi
fi

# 1) garante o servidor no ar (acha o bun no PATH ou no caminho padrão de instalação)
if ! listening; then
  BUN="$(command -v bun 2>/dev/null)"
  [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"
  if [ -z "$BUN" ]; then
    echo "Bun não encontrado. Instale com:  curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
  fi
  nohup "$BUN" server.ts >/tmp/agentdeck.log 2>&1 &
  for _ in $(seq 1 50); do listening && break; sleep 0.2; done
fi

# 2) acha um navegador Chromium por caminho absoluto (não depende do PATH gráfico nem
#    do handler padrão do sistema — que aqui pode estar sequestrado por outro app)
CHROME=""
for c in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge vivaldi-stable; do
  p="$(command -v "$c" 2>/dev/null)"; [ -n "$p" ] && { CHROME="$p"; break; }
done
if [ -z "$CHROME" ]; then
  for p in /usr/bin/google-chrome /usr/bin/google-chrome-stable /opt/google/chrome/google-chrome \
           /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium \
           /usr/bin/brave-browser /usr/bin/microsoft-edge; do
    [ -x "$p" ] && { CHROME="$p"; break; }
  done
fi

# 3) abre em modo app (janela limpa). --class/--name fazem usar o ícone do AgentDeck.
if [ -n "$CHROME" ]; then
  # --user-data-dir dedicado: força uma instância separada do Chrome, que respeita o
  # --class (senão a janela nasce do Chrome já aberto e agrupa/usa o ícone dele na barra).
  exec "$CHROME" --app="$URL" --class=AgentDeck --name=AgentDeck \
    --user-data-dir="$HOME/.local/share/agentdeck/chrome" \
    --no-first-run --no-default-browser-check >/dev/null 2>&1
fi

# 4) sem Chromium: tenta Firefox em "modo app". O Firefox não tem --app nativo, então
#    usamos um perfil dedicado com userChrome.css que esconde abas/barra (vira janela limpa).
#    --class faz o ícone agrupar como AgentDeck (testado: funciona até no Firefox snap).
FF="$(command -v firefox 2>/dev/null)"
if [ -n "$FF" ]; then
  # perfil dedicado num dir que o Firefox snap também consiga acessar
  if readlink -f "$FF" | grep -q '/snap/' || snap list firefox >/dev/null 2>&1; then
    FFDIR="$HOME/snap/firefox/common/agentdeck-profile"
  else
    FFDIR="$HOME/.local/share/agentdeck/firefox"
  fi
  mkdir -p "$FFDIR/chrome"
  grep -q legacyUserProfileCustomizations "$FFDIR/user.js" 2>/dev/null || \
    echo 'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);' >> "$FFDIR/user.js"
  printf '#TabsToolbar, #nav-bar, #PersonalToolbar { visibility: collapse !important; }\n' > "$FFDIR/chrome/userChrome.css"
  exec "$FF" --class=AgentDeck --name=AgentDeck --new-instance --profile "$FFDIR" "$URL" >/dev/null 2>&1
fi

# último recurso (nenhum navegador conhecido): handler do sistema
xdg-open "$URL" >/dev/null 2>&1
