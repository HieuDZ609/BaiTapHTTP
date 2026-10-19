#!/usr/bin/env bash
# Khởi động web app. Mặc định cổng 3000, đổi bằng biến PORT.
set -euo pipefail
cd "$(dirname "$0")"

exec node server.js "$@"
