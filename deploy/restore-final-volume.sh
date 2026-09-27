#!/bin/sh
set -eu

archive=${1:?Usage: restore-final-volume.sh ARCHIVE}
tag=${2:-initial}
case "$tag" in *[!A-Za-z0-9-]*|'') echo 'Invalid restore tag' >&2; exit 2;; esac
volume=/var/lib/docker/volumes/recipeboibot_recipeboibot-data
restore="$volume/_data-restore-$tag"
previous="$volume/_data-before-$tag"
test -f "$archive"
test -d "$volume/_data"
test ! -e "$restore"
test ! -e "$previous"

mkdir "$restore"
tar -xzf "$archive" -C "$restore"
test -f "$restore/recipes.sqlite"
if command -v sqlite3 >/dev/null 2>&1; then
  result=$(sqlite3 "$restore/recipes.sqlite" 'PRAGMA integrity_check;')
else
  result=$(python3 - "$restore/recipes.sqlite" <<'PY'
import sqlite3
import sys
with sqlite3.connect(sys.argv[1]) as db:
    print(db.execute('PRAGMA integrity_check;').fetchone()[0])
PY
)
fi
test "$result" = ok
chown -R 1000:1000 "$restore"
mv "$volume/_data" "$previous"
mv "$restore" "$volume/_data"
printf 'Restored production SQLite volume; integrity_check: %s\n' "$result"
