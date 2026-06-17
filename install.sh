#!/usr/bin/env bash
# Instala o AgentDeck como "app" no Linux: atalho no menu de aplicativos + ícone,
# e um comando `agentdeck` no terminal. Roda local, não precisa de root.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/scalable/apps"
BIN="$HOME/.local/bin"
mkdir -p "$APPS" "$ICONS" "$BIN"

cp "$DIR/icon.svg" "$ICONS/agentdeck.svg"
chmod +x "$DIR/start.sh"
ln -sf "$DIR/start.sh" "$BIN/agentdeck"   # comando `agentdeck` (se ~/.local/bin estiver no PATH)

# Exec aponta pro symlink (sem espaços) — o caminho do repo tem "Área de trabalho",
# e espaço no Exec faz o GNOME não achar o programa e esconder a entrada da busca.
cat > "$APPS/agentdeck.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=AgentDeck
Comment=Sessões do Claude Code/Codex e processos em background
Exec=$BIN/agentdeck
Icon=agentdeck
Terminal=false
Categories=Development;
Keywords=claude;codex;sessions;sessões;agent;ai;processos;
StartupWMClass=AgentDeck
EOF

update-desktop-database "$APPS" >/dev/null 2>&1 || true
gtk-update-icon-cache "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

echo "✓ AgentDeck instalado — no menu de apps e no comando 'agentdeck'."
if command -v bun >/dev/null 2>&1 || [ -x "$HOME/.bun/bin/bun" ]; then
  echo "→ Abrindo o app…"
  nohup "$BIN/agentdeck" >/dev/null 2>&1 &   # já abre (sobrevive ao fim do script via nohup)
else
  echo "⚠ Falta o Bun. Instale e depois rode 'agentdeck':"
  echo "    curl -fsSL https://bun.sh/install | bash"
fi
