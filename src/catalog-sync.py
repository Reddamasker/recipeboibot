#!/usr/bin/env python3
"""Host-only, privileged catalog replication. No tokens or user databases copied."""
import fcntl
import json
import subprocess
import sys

SOURCES = ('recipeboibot', 'recipeboibot-max')
TARGETS = ('recipeboibot-test', 'recipeboibot', 'recipeboibot-max')

def call(container, action, data=None, limit=None):
    args = ['docker', 'exec', '-i', container, 'node', 'src/catalog-maintenance.js', action]
    if limit is not None:
        args.append(str(limit))
    result = subprocess.run(args, input=None if data is None else json.dumps(data, ensure_ascii=False),
                            text=True, encoding='utf-8', capture_output=True, timeout=600)
    if result.returncode:
        raise RuntimeError(container + ': catalog maintenance failed (' + action + ')')
    if action == 'review':
        return None
    return json.loads(result.stdout)

def run(backfill=False, limit=4):
    rows = []
    batches = {}
    for container in SOURCES:
        batches[container] = call(container, 'backfill' if backfill else 'scan')
        rows.extend(batches[container])
    call('recipeboibot', 'ingest', rows)
    # Acknowledge only after the central durable insert. Lost replies are safe
    # because candidate identities are hashes of platform + allowlisted content.
    call('recipeboibot-max', 'ack', [row['id'] for row in batches['recipeboibot-max']])
    call('recipeboibot', 'review', limit=limit)
    snapshot = call('recipeboibot', 'snapshot')
    if snapshot.get('version') != 1:
        raise RuntimeError('Unsupported catalog bridge schema')
    for container in TARGETS:
        call(container, 'apply', snapshot)
    print(json.dumps({'ok': True, 'addedCatalogCards': len(snapshot['recipes']), 'report': snapshot['report']}))

if __name__ == '__main__':
    with open('/run/recipeboibot-catalog.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit(0)
        run('--backfill' in sys.argv, 4)
