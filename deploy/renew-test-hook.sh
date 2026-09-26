#!/bin/sh
set -eu
[ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/recipeboibot-test ] || exit 0
nginx -t && systemctl reload nginx
