#!/bin/bash
set -euo pipefail
release=${1:?Missing archive SHA-256}
[[ "$release" =~ ^[0-9a-f]{64}$ ]] || exit 2
archive="/root/recipeboibot-test-release-$release.tgz"
printf '%s  %s\n' "$release" "$archive" | sha256sum -c -
cd /opt/recipeboibot-test
exec 9>/tmp/recipeboibot-test-deploy.lock
flock -n 9 || { echo 'Another test deployment is running' >&2; exit 1; }
exec 8>/tmp/recipeboibot-docker-deploy.lock
flock -n 8 || { echo 'Another Docker deployment is running' >&2; exit 1; }
test -f .env.local
test -f backups/backup.key
docker exec recipeboibot-test node --input-type=module -e "import {config} from './src/config.js'; if(!config.testContour || config.testBotUsername!=='recipeboi_test_bot') process.exit(1)"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="backups/source-before-parity-$stamp.tgz"
previous="recipeboibot-test-app:before-parity-$stamp"
umask 077
backup_paths=(src public Dockerfile package.json compose.test.yaml)
[[ -d deploy ]] && backup_paths+=(deploy)
[[ -d scripts ]] && backup_paths+=(scripts)
[[ -d test ]] && backup_paths+=(test)
tar -czf "$backup" "${backup_paths[@]}"
running_image="$(docker inspect --format '{{.Image}}' recipeboibot-test)"
docker tag "$running_image" "$previous"
replace_source_directories() {
  # Fixed source paths only: never remove env, compose, backups or data volumes.
  rm -rf -- /opt/recipeboibot-test/src /opt/recipeboibot-test/public /opt/recipeboibot-test/deploy /opt/recipeboibot-test/scripts /opt/recipeboibot-test/test
}
rollback() {
  trap - ERR HUP INT TERM
  echo 'Test release failed; restoring source and image' >&2
  replace_source_directories
  tar -xzf "$backup"
  docker tag "$previous" recipeboibot-test-app:latest
  docker compose -f compose.test.yaml up -d --no-build app
  if [[ $(docker inspect --format '{{.State.Health.Status}}' recipeboibot-test) = healthy ]]; then
    bash deploy/retention.sh test --apply || echo 'Rollback restored runtime; retention needs retry' >&2
  else
    echo 'Retention deferred until restored runtime is healthy' >&2
  fi
  exit 1
}

trap rollback ERR HUP INT TERM
replace_source_directories
tar -xzf "$archive"
docker compose -f compose.test.yaml build app
# Tests run without real environment, database volumes or external network.
docker run --rm --network none -e BOT_PLATFORM=telegram -e TELEGRAM_POLLING=false -v "$PWD/test:/app/test:ro" -v "$PWD/deploy:/app/deploy:ro" -v "$PWD/scripts:/app/scripts:ro" recipeboibot-test-app node --test --test-concurrency=1 > "backups/tests-$stamp.log" 2>&1
tail -n 10 "backups/tests-$stamp.log"
docker compose -f compose.test.yaml stop app
BACKUP_STAMP="$stamp" python3 - <<'PY'
import os,pathlib,sqlite3,subprocess
root=pathlib.Path('/opt/recipeboibot-test')
volume=pathlib.Path('/var/lib/docker/volumes/recipeboibot-test_recipeboibot-test-data/_data')
source=sqlite3.connect(f'file:{volume}/recipes.sqlite?mode=ro',uri=True)
temporary=root/'backups'/('recipes-before-parity-'+os.environ['BACKUP_STAMP']+'.sqlite')
assert not temporary.exists()
destination=sqlite3.connect(temporary)
source.backup(destination)
assert destination.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
destination.close();source.close()
encrypted=temporary.with_suffix('.sqlite.enc')
subprocess.run(['openssl','enc','-aes-256-cbc','-salt','-pbkdf2','-iter','200000','-pass',f'file:{root}/backups/backup.key','-in',str(temporary),'-out',str(encrypted)],check=True)
temporary.unlink()
print('Encrypted database backup:',encrypted)
PY
python3 deploy/enable-persistent-logs.py recipeboibot-test compose.test.yaml
docker compose -f compose.test.yaml up -d --no-build app
for attempt in $(seq 1 30); do
  health=$(docker inspect --format '{{.State.Health.Status}}' recipeboibot-test)
  if [ "$health" = healthy ]; then
    curl -fsS --max-time 15 https://recipeboibot-test.89-223-123-75.sslip.io/healthz
    curl -fsS --max-time 15 http://127.0.0.1:3088/readyz | grep -F '"ok":true' >/dev/null
    printf '%s\n' "$release" > DEPLOYED_ARCHIVE_SHA256
    trap - ERR HUP INT TERM
    bash deploy/retention.sh test --apply || { echo 'Runtime published, but retention failed; see backups/retention-error' >&2; exit 1; }
    printf '\nTest release published: %s\n' "$release"
    exit 0
  fi
  sleep 2
done
false
