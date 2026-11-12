#!/bin/bash
set -euo pipefail
umask 077
scope=${1:?}; mode=${2:?}
case "$scope" in
 production) name=recipeboibot;; test) name=recipeboibot-test;; max) name=recipeboibot-max;; *) exit 2;;
esac
root="/opt/$name"
[[ "$mode" = --check || "$mode" = --apply ]] || exit 2
[[ -d "$root/deploy" && ! -L "$root" && ! -L "$root/deploy" && ! -L "$root/backups" ]]
test -f "$root/backups/backup.key"
[[ $(docker inspect --format '{{.State.Health.Status}}' "$name") = healthy ]]
python3 -c 'import sqlite3,gzip,hashlib; assert sqlite3.sqlite_version_info >= (3,22,0)'
openssl version >/dev/null
if [[ "$mode" = --check ]]; then
 printf 'Storage target ready: %s\n' "$name"
 df -h "$root"
 exit 0
fi
revision=${3:?}; hash=${4:?}
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$hash" =~ ^[a-f0-9]{64}$ ]]
archive="/root/recipeboibot-storage-$hash.tgz"
printf '%s  %s\n' "$hash" "$archive" | sha256sum -c -
exec 8>/tmp/recipeboibot-docker-deploy.lock
flock -n 8 || { echo 'Another release or backup is running' >&2; exit 1; }
cd "$root"
before=$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$name")
stamp=$(date -u +%Y%m%dT%H%M%SZ)
files=(deploy/storage.py deploy/backup.sh deploy/retention.sh deploy/ops-monitor.sh deploy/apply-release.sh deploy/apply-test-release.sh deploy/apply-max-release.sh)
existing=()
for file in "${files[@]}"; do [[ ! -f "$file" ]] || existing+=("$file"); done
tar -czf "backups/storage-tools-before-$stamp.tgz" "${existing[@]}"
printf 'Storage rollout incomplete\n' > backups/retention-error
# Only the fixed, committed infrastructure files enter the live tree.
python3 - "$archive" <<'PY'
import sys,tarfile
allowed={'deploy/storage.py','deploy/backup.sh','deploy/retention.sh','deploy/ops-monitor.sh','deploy/apply-release.sh','deploy/apply-test-release.sh','deploy/apply-max-release.sh'}
with tarfile.open(sys.argv[1]) as archive:
 files=[m for m in archive.getmembers() if not m.isdir()]
 assert {m.name for m in files}==allowed and all(m.isfile() for m in files)
 for member in files:
  data=archive.extractfile(member).read()
  import pathlib,os
  p=pathlib.Path(member.name);tmp=p.with_name(p.name+'.storage-new')
  assert not p.is_symlink() and not tmp.is_symlink()
  with open(tmp,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.chmod(tmp,0o700);os.replace(tmp,p)
PY
python3 deploy/storage.py create "$scope"
python3 deploy/storage.py apply "$scope"
bash deploy/retention.sh "$scope" --apply
python3 deploy/storage.py check "$scope"
[[ $(docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$name") = "$before" ]]
[[ $(docker inspect --format '{{.State.Health.Status}}' "$name") = healthy ]]
printf '%s\n' "$revision" > STORAGE_DEPLOYED_REVISION
rm -- "$archive"
df -h "$root"
printf 'Storage release verified without runtime restart: %s %s\n' "$name" "$revision"
