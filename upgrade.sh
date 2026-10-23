
#!/bin/bash
set -euo pipefail

ENV="prod"
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

echo "=== STOP $SERVICE ==="
"${SUDO[@]}" systemctl stop "$SERVICE"

echo "=== BACKUP DB ==="
source /etc/etomada-server/${ENV}.env
if [ -f "$DB_PATH" ]; then
    cp -- "$DB_PATH" "${DB_PATH}.bak"
else
    echo "???????????????? DABATASE [$DB_PATH] nao encontrada!"
fi

echo "=== SYSTEMD RELOAD ==="
"${SUDO[@]}" systemctl daemon-reload

echo "=== START $SERVICE ==="
"${SUDO[@]}" systemctl start "$SERVICE"

echo "=== STATUS ==="
"${SUDO[@]}" systemctl --no-pager --full status "$SERVICE"

COMMIT_ATUAL=$(git rev-parse HEAD)
MENSAGEM="UPGRADE de [$COMMIT_ANTERIOR] para [$COMMIT_ATUAL] de $ENV concluido"

echo "=== $MENSAGEM ==="

# Lê a porta configurada para o ambiente
PORT=$("${SUDO[@]}" sed -nE \
    's/^[[:space:]]*PORT=([0-9]+)[[:space:]]*$/\1/p' \
    "/etc/etomada-server/${ENV}.env" | tail -n1)

if [[ -z "$PORT" ]]; then
    echo "ERRO: PORT nao encontrada no arquivo de ambiente"
    exit 1
fi

# Aguarda o Node.js iniciar
sleep 4

# Registra o upgrade pela API de logs
printf -v PAYLOAD \
    '{"deviceID":"SERVER","level":10,"module":"UPGRADE","timestamp":%s,"message":"%s"}' \
    "$(date +%s)" "$MENSAGEM"

curl -fsS \
    --retry 5 \
    --retry-connrefused \
    --retry-delay 1 \
    --connect-timeout 2 \
    --max-time 5 \
    -X POST "http://10.0.0.1:${PORT}/api/log" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD"

echo
echo "=== LOG DE UPGRADE REGISTRADO ==="
