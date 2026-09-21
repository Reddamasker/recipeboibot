#!/bin/sh
set -eu
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/recipeboibot ]; then
    nginx -t && systemctl reload nginx
fi
