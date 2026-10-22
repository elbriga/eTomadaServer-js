
#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^(dev|prod)$ ]]; then
    echo "Uso: $0 <dev|prod>"
    exit 1
fi

ENV="$1"
SERVICE="etomada@${ENV}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$DIR"

# Usa sudo somente quando necessário
SUDO=()
if [[ $EUID -ne 0 ]]; then
    SUDO=(sudo)
fi

echo "=== eTomadaServer UPGRADE: $ENV ==="

echo "=== GIT PULL ==="
COMMIT_ANTERIOR=$(git rev-parse HEAD)
git pull --ff-only

echo "=== DEPENDENCIAS ==="
if [[ ! -d node_modules ]] ||
   ! git diff --quiet "$COMMIT_ANTERIOR" HEAD -- package.json package-lock.json; then
    npm ci --omit=dev --no-audit --no-fund
else
    echo "Dependencias inalteradas."
fi

echo "=== SYSTEMD RELOAD ==="
"${SUDO[@]}" systemctl daemon-reload

echo "=== RESTART $SERVICE ==="
"${SUDO[@]}" systemctl restart "$SERVICE"

echo "=== STATUS ==="
"${SUDO[@]}" systemctl --no-pager --full status "$SERVICE"

COMMIT_ATUAL=$(git rev-parse HEAD)
echo "=== UPGRADE DE [$COMMIT_ANTERIOR] para [$COMMIT_ATUAL] DE $ENV CONCLUIDO ==="
