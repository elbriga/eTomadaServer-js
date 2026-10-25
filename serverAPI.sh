#!/bin/bash

HOST=10.0.0.1:8080

ENDPOINT=$1
JSON=$2
METODO=$3

uso() {
    echo "USO: ./serverAPI.sh [ENDPOINT] [JSON] [METODO]" >&2
    echo >&2
    exit 1
}

[[ -z "$ENDPOINT" ]] && ENDPOINT=health
[[ -z "$METODO" ]] && METODO=GET

URL="http://$HOST/api/$ENDPOINT"

if [ ! -z "$JSON" ]; then
    echo "> POST para [$URL]" >&2
    echo "$JSON" | grep -q "\"getFile\":\"" && MODO_DOWNLOAD=1
    if [ "$MODO_DOWNLOAD" == "1" ]; then
        echo "> MODO_DOWNLOAD" >&2
        curl --connect-timeout 3 -s -v -X POST "$URL" -H "Content-Type: application/json" -d "$JSON"
        RET=$?
    else
        curl --connect-timeout 3 -s -v -X POST "$URL" -H "Content-Type: application/json" -d "$JSON" | jq .
        RET=${PIPESTATUS[0]} 
    fi
else
    echo "> $METODO para [$URL]" >&2
    curl --connect-timeout 3 -s -v -X "$METODO" "$URL" | jq .
    RET=${PIPESTATUS[0]} 
fi

echo >&2
echo >&2

exit $RET
