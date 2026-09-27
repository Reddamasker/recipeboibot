#!/bin/sh
set -eu
revision=${1:?Missing Git revision}
archive=${2:?Missing release archive}
health_url=${3:?Missing health URL}
case "$revision" in *[!0-9a-f]*|'') echo 'Invalid revision' >&2; exit 2;; esac
test "${#revision}" -eq 40
case "$archive" in
  "/home/nikita/recipeboibot-release-$revision.tgz"|"/root/recipeboibot-release-$revision.tgz") ;;
  *) echo 'Unexpected release archive' >&2; exit 2;;
esac
case "$health_url" in https://*) ;; *) echo 'Invalid health URL' >&2; exit 2;; esac
test -f "$archive"
cd /opt/recipeboibot
exec 9>/tmp/recipeboibot-deploy.lock
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
test -f .env.local
sudo -n sh deploy/backup.sh /opt/recipeboibot/backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="backups/source-before-git-$stamp.tgz"
previous="recipeboibot-recipeboibot:before-git-$stamp"
sudo -n tar -czf "$backup" src public Dockerfile package.json
sudo -n docker tag recipeboibot-recipeboibot "$previous"
rollback() {
  echo 'Deployment failed; restoring previous source and image' >&2
  sudo -n tar -xzf "$backup" -C /opt/recipeboibot
  sudo -n docker tag "$previous" recipeboibot-recipeboibot:latest
  sudo -n docker compose up -d --no-deps --no-build recipeboibot
  exit 1
}
# Compose, nginx, env и том данных не входят в обновление приложения.
sudo -n tar -xzf "$archive" -C /opt/recipeboibot || rollback
sudo -n docker compose build recipeboibot || rollback
sudo -n docker compose up -d --no-deps --no-build recipeboibot || rollback
i=0
while [ "$i" -lt 30 ]; do
  status=$(sudo -n docker inspect --format '{{.State.Health.Status}}' recipeboibot)
  if [ "$status" = healthy ]; then
    curl -fsS "$health_url/healthz" || rollback
    printf '%s\n' "$revision" | sudo -n tee /opt/recipeboibot/DEPLOYED_REVISION >/dev/null
    printf '\nPublished %s\n' "$revision"
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done
rollback
