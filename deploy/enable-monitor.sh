#!/bin/sh
set -eu
chmod 700 /opt/recipeboibot/deploy/ops-monitor.sh
install -m 644 deploy/recipeboibot-monitor.service /etc/systemd/system/recipeboibot-monitor.service
install -m 644 deploy/recipeboibot-monitor.timer /etc/systemd/system/recipeboibot-monitor.timer
install -m 644 deploy/recipeboibot-retention.service /etc/systemd/system/recipeboibot-retention.service
install -m 644 deploy/recipeboibot-retention.timer /etc/systemd/system/recipeboibot-retention.timer
systemctl daemon-reload
systemctl enable --now recipeboibot-monitor.timer
systemctl enable --now recipeboibot-retention.timer
systemctl start recipeboibot-monitor.service || true
systemctl is-active recipeboibot-monitor.timer
systemctl is-active recipeboibot-retention.timer

