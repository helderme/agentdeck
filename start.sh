#!/usr/bin/env bash
# Sobe o painel e abre no navegador.
cd "$(dirname "$0")" || exit 1
( sleep 1; xdg-open "http://localhost:7799" >/dev/null 2>&1 ) &
exec bun server.ts
