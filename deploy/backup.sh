#!/bin/sh
set -eu
umask 077
backup_dir="${1:-/opt/recipeboibot/backups}"
[ "$backup_dir" = /opt/recipeboibot/backups ] || { echo 'Unexpected backup directory' >&2; exit 2; }
case "${2:-}" in
  --during-deploy) scopes=production ;;
  '')
    exec 9>/tmp/recipeboibot-docker-deploy.lock
    flock -w 60 9 || { echo 'Backup deferred: deployment is still running' >&2; exit 1; }
    scopes='production test max'
    ;;
  *) exit 2;;
esac
failed=0
for scope in $scopes; do
  case "$scope" in production) name=recipeboibot;; test) name=recipeboibot-test;; max) name=recipeboibot-max;; esac
  marker="/opt/$name/backups/backup-error"
  printf 'Backup has not completed\n' > "$marker"
  if python3 deploy/storage.py create "$scope"; then
    if [ "${2:-}" != --during-deploy ] && ! bash deploy/retention.sh "$scope" --database-only; then
      failed=1
      continue
    fi
    rm -- "$marker"
    echo "Encrypted backup created and restore verified: $scope"
  else
    failed=1
  fi
done
exit "$failed"
