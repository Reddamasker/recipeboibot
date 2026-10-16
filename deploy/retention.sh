#!/bin/bash
# Shared policy for every recipe bot deployment. Call under the Docker deploy lock.
set -euo pipefail

retention_config() {
  case "$1" in
    production)
      retention_root=/opt/recipeboibot
      retention_repository=recipeboibot-recipeboibot
      retention_image_prefix=before-git-
      retention_source_pattern='source-before-git-*.tgz'
      retention_database_pattern='recipes-*.sqlite.enc'
      retention_upload_prefix=recipeboibot-release-
      ;;
    test)
      retention_root=/opt/recipeboibot-test
      retention_repository=recipeboibot-test-app
      retention_image_prefix=before-parity-
      retention_source_pattern='source-before-parity-*.tgz'
      retention_database_pattern='recipes-before-parity-*.sqlite.enc'
      retention_upload_prefix=recipeboibot-test-release-
      ;;
    max)
      retention_root=/opt/recipeboibot-max
      retention_repository=recipeboibot-max-app
      retention_image_prefix=before-max-
      retention_source_pattern='source-before-max-*.tgz'
      retention_database_pattern='recipes-before-max-*.sqlite.enc'
      retention_upload_prefix=recipeboibot-max-release-
      ;;
    *) echo 'Unknown retention contour' >&2; return 2;;
  esac
  retention_upload_directories=(/root)
  if [[ "$1" = production ]]; then retention_upload_directories+=(/home/nikita); fi
}

retention_files() {
  local directory=$1 pattern=$2
  [[ -d "$directory" && ! -L "$directory" ]] || return 1
  find "$directory" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %f\n' |
    sort -nr | cut -d ' ' -f 2-
}

retention_trim_files() {
  local directory=$1 pattern=$2 keep=$3 mode=$4 listing name count=0
  listing=$(retention_files "$directory" "$pattern") || return 1
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    count=$((count + 1))
    if (( count > keep )); then
      if [[ "$mode" = --check ]]; then
        printf 'Retention limit exceeded: %s/%s (keep %s)\n' "$directory" "$pattern" "$keep" >&2
        return 1
      fi
      # find supplies basenames, never paths; symlinks are not selected.
      [[ "$name" != */* && "$name" != . && "$name" != .. ]] || return 1
      rm -- "$directory/$name" || return 1
    fi
  done <<< "$listing"
}

retention_trim_images() {
  local mode=$1 listing tag count=0
  listing=$(docker image ls --format '{{.Repository}} {{.Tag}}') || return 1
  listing=$(printf '%s\n' "$listing" |
    awk -v repository="$retention_repository" -v prefix="$retention_image_prefix" \
      '$1 == repository && index($2, prefix) == 1 { print $1 ":" $2 }' | sort -r) || return 1
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    count=$((count + 1))
    if (( count > 3 )); then
      if [[ "$mode" = --check ]]; then
        printf 'Retention image limit exceeded: %s (keep 3)\n' "$retention_repository" >&2
        return 1
      fi
      # No force, global image prune or volume operation. Docker protects in-use images.
      docker image rm "$tag" || return 1
    fi
  done <<< "$listing"
}

retention_policy() {
  local mode=$1 directory
  retention_trim_files "$retention_root/backups" "$retention_source_pattern" 5 "$mode" || return 1
  retention_trim_files "$retention_root/backups" "$retention_database_pattern" 30 "$mode" || return 1
  retention_trim_files "$retention_root/backups" 'tests-*.log' 10 "$mode" || return 1
  retention_trim_images "$mode" || return 1
  for directory in "${retention_upload_directories[@]}"; do
    [[ -d "$directory" ]] || continue
    retention_trim_files "$directory" "$retention_upload_prefix*.tgz" 0 "$mode" || return 1
    retention_trim_files "$directory" "$retention_upload_prefix*.sh" 0 "$mode" || return 1
  done
}

retention_execute() {
  local mode=$1
  [[ -d "$retention_root/backups" && ! -L "$retention_root" && ! -L "$retention_root/backups" ]] || return 1
  if [[ "$mode" = --database-only ]]; then
    # Daily backups must stay bounded even when no releases happen.
    retention_trim_files "$retention_root/backups" "$retention_database_pattern" 30 --apply || return 1
    retention_trim_files "$retention_root/backups" "$retention_database_pattern" 30 --check || return 1
  elif [[ "$mode" = --check ]]; then
    if [[ -e "$retention_root/backups/retention-error" ]]; then
      printf 'Previous retention run failed or did not finish: %s\n' "$retention_root" >&2
      return 1
    fi
    retention_policy --check || return 1
  else
    # A failed/interrupted cleanup remains visible to the existing monitor.
    printf 'Retention has not completed\n' > "$retention_root/backups/retention-error" || return 1
    retention_policy --apply || return 1
    docker builder prune --all --force --keep-storage 1GB || return 1
    retention_policy --check || return 1
    rm -- "$retention_root/backups/retention-error" || return 1
    printf 'Retention verified: %s (3 rollback tags, 5 source archives, 30 DB backups, 10 test logs)\n' "$retention_root"
  fi
}

retention_main() {
  local contour mode failed=0
  if [[ "$#" = 1 && "$1" = --check-all ]]; then
    for contour in production test max; do
      retention_config "$contour" || return 1
      [[ -d "$retention_root" ]] || continue
      retention_execute --check || failed=1
    done
    return "$failed"
  fi
  [[ "$#" = 2 ]] || { echo 'Usage: retention.sh production|test|max --check|--apply|--database-only; or --check-all' >&2; return 2; }
  contour=$1 mode=$2
  [[ "$mode" = --check || "$mode" = --apply || "$mode" = --database-only ]] || return 2
  retention_config "$contour" || return 2
  retention_execute "$mode"
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then retention_main "$@"; fi
