#!/bin/sh
set -eu
cd /opt/recipeboibot
install -m 644 deploy/recipeboibot-backup.service /etc/systemd/system/recipeboibot-backup.service
install -m 644 deploy/recipeboibot-backup.timer /etc/systemd/system/recipeboibot-backup.timer
install -m 755 deploy/renew-hook.sh /etc/letsencrypt/renewal-hooks/deploy/recipeboibot
systemctl daemon-reload
systemctl enable --now recipeboibot-backup.timer
systemctl start recipeboibot-backup.service
systemctl is-active recipeboibot-backup.timer
