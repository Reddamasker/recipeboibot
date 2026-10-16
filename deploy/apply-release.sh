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
exec 8>/tmp/recipeboibot-docker-deploy.lock
flock -n 8 || { echo 'Another Docker deployment is running' >&2; exit 1; }
test -f .env.local
sudo -n sh deploy/backup.sh /opt/recipeboibot/backups --during-deploy
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="backups/source-before-git-$stamp.tgz"
previous="recipeboibot-recipeboibot:before-git-$stamp"
sudo -n tar -czf "$backup" src public deploy Dockerfile package.json compose.yaml
running_image="$(sudo -n docker inspect --format '{{.Image}}' recipeboibot)"
sudo -n docker tag "$running_image" "$previous"
rollback() {
  echo 'Deployment failed; restoring previous source and image' >&2
  sudo -n tar -xzf "$backup" -C /opt/recipeboibot
  sudo -n docker tag "$previous" recipeboibot-recipeboibot:latest
  sudo -n docker compose up -d --no-deps --no-build recipeboibot
  exit 1
}

# Only the logging block of Compose is migrated; env, network and volumes stay intact.
sudo -n tar -xzf "$archive" -C /opt/recipeboibot || rollback
sudo -n docker compose build recipeboibot || rollback
sudo -n docker compose stop recipeboibot || rollback
sudo -n python3 deploy/enable-persistent-logs.py recipeboibot compose.yaml || rollback
sudo -n docker compose up -d --no-deps --no-build recipeboibot || rollback
i=0
while [ "$i" -lt 30 ]; do
  status=$(sudo -n docker inspect --format '{{.State.Health.Status}}' recipeboibot)
  if [ "$status" = healthy ]; then
    curl -fsS "$health_url/healthz" || rollback
    curl -fsS "$health_url/readyz" | grep -F '"ok":true' >/dev/null || rollback
    sudo -n sh deploy/enable-monitor.sh || rollback
    printf '%s\n' "$revision" | sudo -n tee /opt/recipeboibot/DEPLOYED_REVISION >/dev/null
    sudo -n bash deploy/retention.sh production --apply || { echo 'Runtime published, but retention failed; see backups/retention-error' >&2; exit 1; }
    printf '\nPublished %s\n' "$revision"
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done
rollback
