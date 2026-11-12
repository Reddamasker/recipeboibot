#!/usr/bin/env python3
"""Bounded, restore-tested SQLite backups. Mutations run under the shared deploy lock."""
import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time

GiB = 1024 ** 3
POLICIES = {
    'production': ('recipeboibot', 'recipes-', 'recipeboibot_recipeboibot-data', 1536 * 1024 ** 2, 10000),
    'test': ('recipeboibot-test', 'recipes-before-parity-', 'recipeboibot-test_recipeboibot-test-data', 256 * 1024 ** 2, 200000),
    'max': ('recipeboibot-max', 'recipes-before-max-', 'recipeboibot-max_recipeboibot-max-data', GiB, 200000),
}

def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()

def regular(path):
    if path.is_symlink() or not path.is_file(): raise RuntimeError('Expected a regular file: ' + path.name)

def folder(path):
    if path.is_symlink() or not path.is_dir() or path.resolve() != path.absolute():
        raise RuntimeError('Unsafe backup directory')

def capacity(path, required):
    free = shutil.disk_usage(path).free
    if free < required: raise RuntimeError('Insufficient free space: %d bytes, need %d' % (free, required))
    return free

def sqlite_check(path):
    regular(path)
    con = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    try:
        if con.execute('PRAGMA integrity_check').fetchall() != [('ok',)]: raise RuntimeError('SQLite integrity check failed')
        if con.execute('PRAGMA foreign_key_check').fetchone(): raise RuntimeError('SQLite foreign keys failed')
        counts = {}
        for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            counts[name] = con.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0]
        return counts
    finally: con.close()

def crypt(source, target, key, decrypt=False, iterations=200000):
    regular(source); regular(key)
    args = ['openssl', 'enc', '-aes-256-cbc', '-pbkdf2', '-iter', str(iterations), '-pass', 'file:' + str(key), '-in', str(source), '-out', str(target)]
    args += ['-d'] if decrypt else ['-salt']
    result = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if result.returncode: raise RuntimeError('Backup encryption/decryption failed')
    os.chmod(target, 0o600)

def decode(source, raw, key, legacy_iterations):
    if source.name.endswith('.sqlite.gz.enc'):
        packed = raw.with_suffix('.gz')
        crypt(source, packed, key, True)
        with gzip.open(packed, 'rb') as src, open(raw, 'wb') as dst:
            for block in iter(lambda: src.read(1024 * 1024), b''):
                capacity(raw.parent, 256 * 1024 ** 2 + len(block))
                dst.write(block)
        packed.unlink()
    else:
        crypt(source, raw, key, True, legacy_iterations)
    return sqlite_check(raw)

def metadata_path(path): return path.with_name(path.name + '.json')

def sync_directory(path):
    if os.name != 'posix': return
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)

def write_json(path, value):
    temp = path.with_name(path.name + '.tmp')
    if path.is_symlink() or temp.is_symlink(): raise RuntimeError('Unsafe metadata path')
    # A stale interrupted metadata write is not an input backup.
    with open(temp, 'w', encoding='utf8') as f:
        os.chmod(temp, 0o600); json.dump(value, f); f.flush(); os.fsync(f.fileno())
    os.replace(temp, path)
    sync_directory(path.parent)

def manifest(path):
    try:
        meta = metadata_path(path); regular(meta)
        value = json.loads(meta.read_text())
        st = path.stat()
        if value['version'] != 1 or value['bytes'] != st.st_size or value['mtimeNs'] != st.st_mtime_ns: return None
        if not re.fullmatch('[0-9a-f]{64}', value['plainSha256']): return None
        return value
    except (OSError, ValueError, KeyError, RuntimeError): return None

def verify(path, key, iterations, expected=None):
    capacity(path.parent, max(512 * 1024 ** 2, (expected or {}).get('plainBytes', path.stat().st_size * 12) * 2))
    with tempfile.TemporaryDirectory(prefix='.restore-check-', dir=path.parent) as work:
        raw = Path(work) / 'restored.sqlite'
        counts = decode(path, raw, key, iterations)
        value = {'version': 1, 'plainSha256': digest(raw), 'plainBytes': raw.stat().st_size,
                 'counts': counts, 'sha256': digest(path), 'bytes': path.stat().st_size,
                 'mtimeNs': path.stat().st_mtime_ns, 'verifiedAt': time.time()}
        if expected and (value['plainSha256'] != expected['plainSha256'] or counts != expected['counts']):
            raise RuntimeError('Restored backup differs from its source snapshot')
    write_json(metadata_path(path), value)
    return value

def encode(raw, target, key):
    if target.exists(): raise RuntimeError('Backup already exists')
    expected = {'plainSha256': digest(raw), 'plainBytes': raw.stat().st_size, 'counts': sqlite_check(raw)}
    with tempfile.TemporaryDirectory(prefix='.backup-write-', dir=target.parent) as work:
        packed = Path(work) / 'snapshot.gz'; encrypted = Path(work) / target.name
        with open(raw, 'rb') as src, gzip.open(packed, 'wb', compresslevel=6) as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
        crypt(packed, encrypted, key)
        verify(encrypted, key, 200000, expected)
        with open(encrypted, 'rb+') as f: os.fsync(f.fileno())
        os.replace(encrypted, target)
        meta = json.loads(metadata_path(encrypted).read_text())
        meta['mtimeNs'] = target.stat().st_mtime_ns
        write_json(metadata_path(target), meta)
    return meta

def candidates(root, prefix):
    folder(root)
    pattern = re.compile(re.escape(prefix) + r'(\d{8}T\d{6}Z)\.sqlite(?:\.gz)?\.enc$')
    result = []
    for path in root.iterdir():
        match = pattern.fullmatch(path.name)
        if not match: continue
        regular(path)
        stamp = dt.datetime.strptime(match[1], '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
        result.append((stamp, path))
    return sorted(result, key=lambda row: (row[0], row[1].name), reverse=True)

def migrate(root, prefix, iterations):
    key = root / 'backup.key'; regular(key)
    for stamp, old in candidates(root, prefix):
        if old.name.endswith('.gz.enc'): continue
        capacity(root, max(512 * 1024 ** 2, old.stat().st_size * 3))
        new = old.with_name(old.name.replace('.sqlite.enc', '.sqlite.gz.enc'))
        with tempfile.TemporaryDirectory(prefix='.backup-migrate-', dir=root) as work:
            raw = Path(work) / 'source.sqlite'
            counts = decode(old, raw, key, iterations)
            expected = {'plainSha256': digest(raw), 'plainBytes': raw.stat().st_size, 'counts': counts}
            if new.exists(): verify(new, key, iterations, expected)
            else: encode(raw, new, key)
            # Only remove the exact old file after round-trip restoration and byte equality.
            old.unlink()
            sync_directory(root)
        print(json.dumps({'converted': old.name, 'bytes': new.stat().st_size}), flush=True)

def selection(rows, budget, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    protected = {p for _, p in rows[:3]}
    keep = set(protected); days = set(); weeks = set()
    for stamp, path in rows:
        age = (now - stamp).total_seconds() / 86400
        day = stamp.date(); week = stamp.isocalendar()[:2]
        if age < 14 and day not in days: keep.add(path); days.add(day)
        if age < 56 and week not in weeks: keep.add(path); weeks.add(week)
    for _, path in reversed(rows):
        if sum(p.stat().st_size for p in keep) <= budget: break
        if path in keep and path not in protected: keep.remove(path)
    if sum(p.stat().st_size for p in keep) > budget:
        raise RuntimeError('Newest three recovery points exceed backup budget; preserve them and stop')
    return keep

def cleanup_interrupted_work(root):
    # Called only by the lock-owning apply path. Never follow links or touch
    # hand-created recovery files; all managed scratch directories are private.
    prefixes = ('.restore-check-', '.backup-write-', '.backup-migrate-', '.backup-create-', '.manual-restore-')
    for path in root.iterdir():
        if not path.name.startswith(prefixes) or time.time() - path.lstat().st_mtime < 86400: continue
        folder(path)
        if hasattr(os, 'getuid') and path.stat().st_uid != os.getuid():
            raise RuntimeError('Unexpected scratch directory owner')
        entries = list(path.rglob('*'))
        if any(p.is_symlink() or not (p.is_file() or p.is_dir()) for p in entries):
            raise RuntimeError('Unsafe interrupted backup directory')
        shutil.rmtree(path)
    sync_directory(root)

def rotate(root, prefix, budget, iterations, apply=False):
    if apply:
        cleanup_interrupted_work(root)
        migrate(root, prefix, iterations)
    rows = candidates(root, prefix)
    if not rows: raise RuntimeError('No database recovery points')
    if (dt.datetime.now(dt.timezone.utc) - rows[0][0]).total_seconds() > 108000:
        raise RuntimeError('Latest recovery point is older than 30 hours')
    if any(not p.name.endswith('.gz.enc') for _, p in rows): raise RuntimeError('Uncompressed legacy backups remain')
    for _, path in rows:
        meta = manifest(path)
        if not meta:
            if not apply: raise RuntimeError('Backup has no valid restore verification: ' + path.name)
            verify(path, root / 'backup.key', iterations)
        elif apply and digest(path) != meta['sha256']: raise RuntimeError('Backup checksum mismatch: ' + path.name)
    latest = rows[0][1]; meta = manifest(latest)
    if time.time() - meta['verifiedAt'] > 86400:
        if not apply: raise RuntimeError('Latest restore verification is older than 24 hours')
        verify(latest, root / 'backup.key', iterations, meta)
    keep = selection(rows, budget)
    excess = [path for _, path in rows if path not in keep]
    if excess and not apply: raise RuntimeError('Database retention exceeded')
    for path in excess:
        path.unlink(); metadata_path(path).unlink()
    if excess: sync_directory(root)
    # A manifest is written only after successful decrypt, inflate and SQLite checks.
    return {'backups': len(keep), 'bytes': sum(p.stat().st_size for p in keep), 'budget': budget,
            'latest': latest.name, 'verifiedAt': manifest(latest)['verifiedAt']}

def create(contour):
    name, prefix, volume, budget, iterations = POLICIES[contour]
    root = Path('/opt') / name / 'backups'; folder(root); regular(root / 'backup.key')
    previous = [row for row in candidates(root, prefix) if row[1].name.endswith('.gz.enc')]
    if len(previous) >= 3 and sum(p.stat().st_size for _, p in previous[:3]) > budget:
        raise RuntimeError('Backup budget already exhausted; preserve recovery points and stop')
    source = Path('/var/lib/docker/volumes') / volume / '_data/recipes.sqlite'; regular(source)
    capacity(root, max(GiB, source.stat().st_size * 4))
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target = root / (prefix + stamp + '.sqlite.gz.enc')
    with tempfile.TemporaryDirectory(prefix='.backup-create-', dir=root) as work:
        raw = Path(work) / 'snapshot.sqlite'
        src = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)
        dst = sqlite3.connect(raw)
        try: src.backup(dst)
        finally: dst.close(); src.close()
        encode(raw, target, root / 'backup.key')
    print(json.dumps({'created': target.name, 'bytes': target.stat().st_size}), flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['create', 'check', 'apply', 'preflight', 'space', 'restore'])
    parser.add_argument('contour', choices=list(POLICIES))
    parser.add_argument('paths', nargs='*')
    args = parser.parse_args()
    name, prefix, volume, budget, iterations = POLICIES[args.contour]
    root = Path('/opt') / name / 'backups'; folder(root)
    if args.action == 'restore':
        if len(args.paths) != 2: raise RuntimeError('restore requires archive basename and new destination')
        archive, destination = args.paths
        if archive != Path(archive).name: raise RuntimeError('Expected archive basename')
        source = root / archive
        if source not in [p for _, p in candidates(root, prefix)]: raise RuntimeError('Unknown recovery point')
        expected = manifest(source)
        if not expected: raise RuntimeError('Missing manifest')
        capacity(root, max(512 * 1024 ** 2, expected['plainBytes'] * 2))
        capacity(Path(destination).absolute().parent, expected['plainBytes'] + 256 * 1024 ** 2)
        with tempfile.TemporaryDirectory(prefix='.manual-restore-', dir=root) as work:
            raw = Path(work) / 'restore.sqlite'; counts = decode(source, raw, root / 'backup.key', iterations)
            if digest(raw) != expected['plainSha256'] or counts != expected['counts']: raise RuntimeError('Restore differs')
            with open(destination, 'xb') as out, open(raw, 'rb') as inp:
                os.chmod(destination, 0o600); shutil.copyfileobj(inp, out); out.flush(); os.fsync(out.fileno())
        print('Verified restore created; live databases were not replaced')
    elif args.action in ('preflight', 'space'):
        # Leave room for build layers, upload, source rollback and temporary restore files.
        capacity(root, 6 * GiB if args.action == 'preflight' else 4 * GiB)
        if args.action == 'preflight': rotate(root, prefix, budget, iterations)
        print(json.dumps({'space': 'ok', 'freeBytes': shutil.disk_usage(root).free}))
    elif args.action == 'create': create(args.contour)
    else: print(json.dumps(rotate(root, prefix, budget, iterations, args.action == 'apply')))

if __name__ == '__main__':
    os.umask(0o077)
    try: main()
    except Exception as error:
        print('Storage check failed: ' + str(error), file=__import__('sys').stderr)
        raise SystemExit(1)
