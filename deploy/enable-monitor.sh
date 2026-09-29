#!/bin/sh
set -eu
chmod 700 /opt/recipeboibot/deploy/ops-monitor.sh
install -m 644 deploy/recipeboibot-monitor.service /etc/systemd/system/recipeboibot-monitor.service
install -m 644 deploy/recipeboibot-monitor.timer /etc/systemd/system/recipeboibot-monitor.timer
systemctl daemon-reload
systemctl enable --now recipeboibot-monitor.timer
systemctl start recipeboibot-monitor.service || true
systemctl is-active recipeboibot-monitor.timer

