#!/usr/bin/env python3
"""Run inside a locked deploy after stopping the old container. No log bodies on stdout."""
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys


def logging_compose(source):
    pattern = r'(?m)^    logging:\n(?:      .*\n|        .*\n)+'
    replacement = '    logging:\n      driver: journald\n      options:\n        tag: "{{.Name}}"\n'
    result, count = re.subn(pattern, replacement, source)
    if count != 1:
        raise RuntimeError('Expected exactly one service logging block')
    return result


def main():
    targets = {'recipeboibot': 'compose.yaml', 'recipeboibot-test': 'compose.test.yaml', 'recipeboibot-max': 'compose.max.yaml'}
    container, compose_name = sys.argv[1:]
    root = pathlib.Path('/opt') / container
    if targets.get(container) != compose_name or pathlib.Path.cwd().resolve() != root or os.geteuid() != 0:
        raise RuntimeError('Unexpected logging migration target')
    os.umask(0o077)
    subprocess.run(['systemctl', 'is-active', '--quiet', 'systemd-journald'], check=True)
    compose = root / compose_name
    candidate = root / (compose_name + '.logging-candidate')
    source = compose.read_text()
    candidate.write_text(logging_compose(source))
    try:
        subprocess.run(['docker', 'compose', '-f', str(candidate), 'config', '--quiet'], check=True, stdout=subprocess.DEVNULL)
    finally:
        candidate.unlink(missing_ok=True)

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    info = subprocess.run(['docker', 'inspect', container], capture_output=True, text=True)
    if info.returncode == 0:
        state = json.loads(info.stdout)[0]
        if state['State']['Running']:
            raise RuntimeError('Stop old container before archiving its final log records')
        key = root / 'backups/backup.key'
        if not key.is_file():
            raise RuntimeError('Encrypted log backup key missing')
        destination = root / 'backups' / ('container-log-' + stamp + '.log.enc')
        # Docker puts container stderr on its stderr stream; encrypt both streams.
        with destination.open('xb') as output:
            logs = subprocess.Popen(['docker', 'logs', '--timestamps', container], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            encrypted = subprocess.run(['openssl', 'enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '200000', '-pass', 'file:' + str(key)], stdin=logs.stdout, stdout=output, stderr=subprocess.PIPE)
            logs.stdout.close()
            status = logs.wait()
        if status or encrypted.returncode:
            destination.unlink(missing_ok=True)
            raise RuntimeError('Encrypted log archive failed')
        print('Encrypted container log archive:', destination)

    config_dir = pathlib.Path('/etc/systemd/journald.conf.d')
    config_dir.mkdir(parents=True, exist_ok=True)
    config = config_dir / '60-recipeboibot-retention.conf'
    desired = '[Journal]\nStorage=persistent\nSystemMaxUse=1G\nSystemKeepFree=2G\nMaxRetentionSec=30day\nMaxFileSec=1day\n'
    if not config.exists() or config.read_text() != desired:
        if config.exists():
            (root / 'backups' / ('journald-before-' + stamp + '.conf')).write_bytes(config.read_bytes())
        config.write_text(desired)
        config.chmod(0o644)
        subprocess.run(['systemd-tmpfiles', '--create', '--prefix', '/var/log/journal'], check=True)
        subprocess.run(['systemctl', 'restart', 'systemd-journald'], check=True)
    subprocess.run(['journalctl', '--flush'], check=True)
    subprocess.run(['systemctl', 'is-active', '--quiet', 'systemd-journald'], check=True)
    if not pathlib.Path('/var/log/journal').is_dir():
        raise RuntimeError('Persistent journal directory missing')
    (root / 'backups' / ('compose-before-logging-' + stamp + '.yaml')).write_text(source)
    compose.write_text(logging_compose(source))
    # Encrypted migration/deploy archives have a separate bounded budget.
    files = sorted((root / 'backups').glob('container-log-*.log.enc'), key=lambda p: p.stat().st_mtime, reverse=True)
    total = 0
    cutoff = datetime.datetime.now().timestamp() - 30 * 86400
    for index, file in enumerate(files):
        total += file.stat().st_size
        if index and (file.stat().st_mtime < cutoff or total > 100 * 1024 * 1024):
            file.unlink()
    print('Persistent journald enabled; retention up to 30 days, journal budget 1 GiB')


if __name__ == '__main__':
    main()
