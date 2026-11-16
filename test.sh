#!/usr/bin/env bash
# Chạy bộ kiểm thử: phần lọc HTML (không cần server) + API (cần server đang chạy).
set -euo pipefail
cd "$(dirname "$0")"

node test/render-test.js
echo
exec node test/api-test.js "$@"
