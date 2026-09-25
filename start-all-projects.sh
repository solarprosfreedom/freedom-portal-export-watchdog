#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

export FREEDOM_EXPORT_MODE=all-projects
export INSTALLS_RELAY_PORT=8775
export INSTALLS_DETAIL_BATCH=16

exec node freedom-installs-export-server.mjs
