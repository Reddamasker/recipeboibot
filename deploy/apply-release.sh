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
sudo -n sh deploy/backup.sh /opt/recipeboibot/backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="backups/source-before-git-$stamp.tgz"
previous="recipeboibot-recipeboibot:before-git-$stamp"
sudo -n tar -czf "$backup" src public deploy Dockerfile package.json
sudo -n docker tag recipeboibot-recipeboibot "$previous"
rollback() {
  echo 'Deployment failed; restoring previous source and image' >&2
  sudo -n tar -xzf "$backup" -C /opt/recipeboibot
  sudo -n docker tag "$previous" recipeboibot-recipeboibot:latest
  sudo -n docker compose up -d --no-deps --no-build recipeboibot
  exit 1
}
prune_files() {
  directory=$1
  pattern=$2
  keep=$3
  sudo -n find "$directory" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' |
    sort -nr |
    awk -v keep="$keep" 'NR > keep { sub(/^[^ ]+ /, ""); print }' |
    while IFS= read -r file; do sudo -n rm -f -- "$file"; done
}
prune_image_tags() {
  repository=$1
  prefix=$2
  keep=$3
  sudo -n docker image ls --format '{{.Repository}} {{.Tag}}' |
    awk -v repository="$repository" -v prefix="$prefix" '$1 == repository && index($2, prefix) == 1 { print $1 ":" $2 }' |
    sort -r |
    tail -n "+$((keep + 1))" |
    while IFS= read -r image; do sudo -n docker image rm "$image"; done
}
cleanup_retention() {
  release_dir=${archive%/*}
  sudo -n find "$release_dir" -maxdepth 1 -type f \
    \( -name 'recipeboibot-release-*.tgz' -o -name 'recipeboibot-release-*.sh' \) -delete
  prune_files backups 'source-before-git-*.tgz' 5
  prune_files backups 'recipes-*.sqlite.enc' 30
  prune_image_tags recipeboibot-recipeboibot 'before-git-' 3
  sudo -n docker builder prune --all --force --keep-storage 1GB
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
    curl -fsS "$health_url/readyz" | grep -F '"ok":true' >/dev/null || rollback
    sudo -n sh deploy/enable-monitor.sh || rollback
    printf '%s\n' "$revision" | sudo -n tee /opt/recipeboibot/DEPLOYED_REVISION >/dev/null
    cleanup_retention || echo 'Warning: retention cleanup did not finish' >&2
    printf '\nPublished %s\n' "$revision"
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done
rollback
