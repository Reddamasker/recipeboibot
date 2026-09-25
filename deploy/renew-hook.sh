#!/bin/sh
set -eu
case "${RENEWED_LINEAGE:-}" in
    /etc/letsencrypt/live/recipeboibot|/etc/letsencrypt/live/recipeboibot-vpn)
        nginx -t && systemctl reload nginx
        ;;
esac
