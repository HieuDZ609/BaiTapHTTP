#!/usr/bin/env bash
# Mở tunnel ngrok cho web app đang chạy ở cổng 3000.
#
# Trước khi chạy lần đầu:
#   ngrok config add-authtoken <TOKEN>
#
# Có thể đổi domain/cổng bằng biến môi trường:
#   NGROK_DOMAIN=abc.ngrok-free.dev PORT=3000 ./ngrok.sh
set -euo pipefail

PORT="${PORT:-3000}"
NGROK_DOMAIN="${NGROK_DOMAIN:-tint-humped-december.ngrok-free.dev}"

if ! command -v ngrok >/dev/null 2>&1; then
    echo "Chưa cài ngrok. Tải tại https://ngrok.com/download rồi giải nén vào ~/.local/bin." >&2
    exit 1
fi

echo "Mở tunnel: http://localhost:${PORT}  ->  https://${NGROK_DOMAIN}"
exec ngrok http "${PORT}" --url "https://${NGROK_DOMAIN}"
