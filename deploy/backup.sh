#!/bin/sh
set -eu
umask 077
backup_dir="${1:-./backups}"
mkdir -p "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [ ! -f "$backup_dir/backup.key" ]; then openssl rand -hex -out "$backup_dir/backup.key" 32; fi
docker compose exec -T recipeboibot node --input-type=module -e "import { DatabaseSync, backup } from 'node:sqlite'; const db=new DatabaseSync('/app/data/recipes.sqlite'); await backup(db,'/app/data/backup.sqlite'); db.close();"
docker compose exec -T recipeboibot node -e "process.stdout.write(require('node:fs').readFileSync('/app/data/backup.sqlite'))" | openssl enc -aes-256-cbc -salt -pbkdf2 -pass "file:$backup_dir/backup.key" -out "$backup_dir/recipes-$stamp.sqlite.enc"
echo "Encrypted backup created: $backup_dir/recipes-$stamp.sqlite.enc"
