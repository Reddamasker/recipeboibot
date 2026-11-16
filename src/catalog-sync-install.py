#!/usr/bin/env python3
"""Install the bounded host maintenance worker after all three deployments."""
import pathlib
import subprocess
import sys

service = '''[Unit]
Description=Review and synchronize generated recipe catalog
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/recipeboibot/src/catalog-sync.py
TimeoutStartSec=720
Nice=10
UMask=0077
'''
timer = '''[Unit]
Description=Review new generated recipes once per minute
[Timer]
OnBootSec=120
OnUnitInactiveSec=60
Unit=recipeboibot-catalog.service
[Install]
WantedBy=timers.target
'''
if sys.argv[1:] not in (['--check'], ['--apply']):
    raise SystemExit('Use --check or --apply')
for container in ('recipeboibot-test','recipeboibot','recipeboibot-max'):
    subprocess.run(['docker','exec',container,'test','-f','/app/src/catalog-maintenance.js'],check=True)
for name, text in [('recipeboibot-catalog.service',service),('recipeboibot-catalog.timer',timer)]:
    target=pathlib.Path('/etc/systemd/system')/name
    if target.exists() and target.read_text()!=text:
        raise SystemExit('Different existing catalog unit: '+name)
    if sys.argv[1]=='--apply':
        target.write_text(text)
if sys.argv[1]=='--apply':
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','enable','--now','recipeboibot-catalog.timer'],check=True)
print('Catalog worker '+sys.argv[1]+' completed')
