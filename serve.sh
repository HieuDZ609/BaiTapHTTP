#!/usr/bin/env bash
# Chạy cả web app và tunnel ngrok ở chế độ nền, log ghi vào .run/.
# Dùng khi muốn "bật một lần rồi quên", thay vì mở hai terminal.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
NGROK_DOMAIN="${NGROK_DOMAIN:-tint-humped-december.ngrok-free.dev}"
NGROK_BIN="$(command -v ngrok || echo "$HOME/.local/bin/ngrok")"

mkdir -p .run

if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
    echo "• Web app đã chạy sẵn ở cổng ${PORT}"
else
    setsid nohup node server.js > .run/server.log 2>&1 < /dev/null &
    echo $! > .run/server.pid
    sleep 1
    echo "• Đã khởi động web app (pid $(cat .run/server.pid))"
fi

if ss -ltn 2>/dev/null | grep -q ':4040 '; then
    echo "• ngrok đã chạy sẵn"
else
    if [[ ! -x "$NGROK_BIN" ]]; then
        echo "  ! Chưa cài ngrok — bỏ qua tunnel. Tải tại https://ngrok.com/download" >&2
    else
        setsid nohup "$NGROK_BIN" http "${PORT}" --url "https://${NGROK_DOMAIN}" \
            --log=stdout > .run/ngrok.log 2>&1 < /dev/null &
        sleep 3
        echo "• Đã mở tunnel ngrok"
    fi
fi

echo
echo "  Local  : http://localhost:${PORT}/"
if ss -ltn 2>/dev/null | grep -q ':4040 '; then
    echo "  Public : https://${NGROK_DOMAIN}/"
    echo "  Dashboard: http://127.0.0.1:4040"
fi
echo
echo "  Kiểm tra nhanh:"
curl -s -o /dev/null -w "    local  -> %{http_code}\n" "http://localhost:${PORT}/api/health" || true
if ss -ltn 2>/dev/null | grep -q ':4040 '; then
    curl -s -o /dev/null -w "    public -> %{http_code}\n" \
        -H "ngrok-skip-browser-warning: true" "https://${NGROK_DOMAIN}/api/health" || true
fi
echo
echo "  Dừng tất cả: ./stop.sh"
