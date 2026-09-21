#!/bin/sh
set -eu
cd /opt/recipeboibot
test -f .env.local
chmod 600 .env.local
docker compose build
TELEGRAM_POLLING=false docker compose up -d
docker compose ps
