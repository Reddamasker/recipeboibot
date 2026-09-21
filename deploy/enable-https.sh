#!/bin/sh
set -eu
cd /opt/recipeboibot
test -f /etc/letsencrypt/live/recipeboibot/fullchain.pem
test ! -e /etc/nginx/sites-enabled/recipeboibot
install -m 644 deploy/recipeboibot.conf /etc/nginx/sites-available/recipeboibot
ln -s /etc/nginx/sites-available/recipeboibot /etc/nginx/sites-enabled/recipeboibot
if ! nginx -t; then
    unlink /etc/nginx/sites-enabled/recipeboibot
    exit 1
fi
systemctl reload nginx
