#!/usr/bin/env bash
# Dừng web app (cổng 3000) và tunnel ngrok đang chạy nền.
set -uo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"

kill_port() {
    local port="$1"
    local pids
    pids=$(ss -ltnp 2>/dev/null | grep ":${port} " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
    if [[ -z "$pids" ]]; then
        echo "• Cổng ${port}: không có tiến trình nào"
        return
    fi
    for pid in $pids; do
        kill "$pid" 2>/dev/null && echo "• Đã dừng pid ${pid} (cổng ${port})"
    done
}

kill_port "$PORT"
kill_port 4040

rm -f .run/server.pid
