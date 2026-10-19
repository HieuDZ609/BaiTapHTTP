#!/usr/bin/env bash
# Chạy bộ kiểm thử API. Cần server đang chạy (./start.sh).
set -euo pipefail
cd "$(dirname "$0")"

exec node test/api-test.js "$@"
