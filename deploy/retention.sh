#!/bin/bash
# Shared policy for every recipe bot deployment. Call under the Docker deploy lock.
set -euo pipefail

retention_config() {
  case "$1" in
    production)
      retention_root=/opt/recipeboibot
      retention_repository=recipeboibot-recipeboibot
      retention_project=recipeboibot
      retention_image_prefix=before-git-
      retention_source_pattern='source-before-git-*.tgz'
      retention_database_pattern='recipes-*.sqlite.enc'
      retention_upload_prefix=recipeboibot-release-
      ;;
    test)
      retention_root=/opt/recipeboibot-test
      retention_repository=recipeboibot-test-app
      retention_project=recipeboibot-test
      retention_image_prefix=before-parity-
      retention_source_pattern='source-before-parity-*.tgz'
      retention_database_pattern='recipes-before-parity-*.sqlite.enc'
      retention_upload_prefix=recipeboibot-test-release-
      ;;
    max)
      retention_root=/opt/recipeboibot-max
      retention_repository=recipeboibot-max-app
      retention_project=recipeboibot-max
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
  local directory=$1 pattern=$2 minimum_age=${3:-0}
  [[ -d "$directory" && ! -L "$directory" ]] || return 1
  local age_filter=()
  (( minimum_age == 0 )) || age_filter=(-mmin "+$minimum_age")
  find "$directory" -maxdepth 1 -type f -name "$pattern" "${age_filter[@]}" -printf '%T@ %f\n' |
    sort -nr | cut -d ' ' -f 2-
}

retention_trim_files() {
  local directory=$1 pattern=$2 keep=$3 mode=$4 minimum_age=${5:-0} listing name count=0
  listing=$(retention_files "$directory" "$pattern" "$minimum_age") || return 1
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
  local mode=$1 listing tag id duplicate count=0
  local -A seen=()
  listing=$(docker image ls --format '{{.Repository}} {{.Tag}}') || return 1
  listing=$(printf '%s\n' "$listing" |
    awk -v repository="$retention_repository" -v prefix="$retention_image_prefix" \
      '$1 == repository && index($2, prefix) == 1 { print $1 ":" $2 }' | sort -r) || return 1
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    id=$(docker image inspect --format '{{.Id}}' "$tag") || return 1
    [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
    duplicate=false
    if [[ -n "${seen[$id]:-}" ]]; then duplicate=true
    else seen[$id]=1; count=$((count + 1)); fi
    if [[ "$duplicate" = true ]] || (( count > 3 )); then
      if [[ "$mode" = --check ]]; then
        printf 'Retention image limit or duplicate tag: %s (keep 3 distinct images)\n' "$retention_repository" >&2
        return 1
      fi
      # No force, global image prune or volume operation. Docker protects in-use images.
      docker image rm "$tag" || return 1
    fi
  done <<< "$listing"
}

retention_dangling_images() {
  local mode=$1 listing id metadata containers
  # Compose labels also identify legacy images whose last rollback tag was removed.
  # Never prune globally: unrelated projects, tagged/digest-pinned images and all
  # container references (including stopped containers) remain protected.
  listing=$(docker image ls --no-trunc --filter dangling=true \
    --filter "label=com.docker.compose.project=$retention_project" --format '{{.ID}}') || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
    metadata=$(docker image inspect --format '{{len .RepoTags}} {{len .RepoDigests}} {{index .Config.Labels "com.docker.compose.project"}}' "$id") || return 1
    [[ "$metadata" = "0 0 $retention_project" ]] || continue
    containers=$(docker ps --all --quiet --filter "ancestor=$id") || return 1
    [[ -z "$containers" ]] || continue
    if [[ "$mode" = --check ]]; then
      printf 'Unused untagged project image remains: %s %s\n' "$retention_project" "$id" >&2
      return 1
    fi
    # Revalidate immediately before deletion; Docker adds its own reference checks.
    metadata=$(docker image inspect --format '{{len .RepoTags}} {{len .RepoDigests}} {{index .Config.Labels "com.docker.compose.project"}}' "$id") || return 1
    [[ "$metadata" = "0 0 $retention_project" ]] || continue
    docker image rm "$id" || return 1
  done <<< "$listing"
}

retention_policy() {
  local mode=$1 directory upload_age=60
  retention_trim_files "$retention_root/backups" "$retention_source_pattern" 5 "$mode" || return 1
  retention_trim_files "$retention_root/backups" "$retention_database_pattern" 30 "$mode" || return 1
  retention_trim_files "$retention_root/backups" 'tests-*.log' 10 "$mode" || return 1
  retention_trim_images "$mode" || return 1
  retention_dangling_images "$mode" || return 1
  # A file becomes eligible at 60 minutes, then waits for the hourly timer
  # (plus its five-minute jitter). Audit only overdue work, not that normal wait.
  [[ "$mode" != --check ]] || upload_age=130
  for directory in "${retention_upload_directories[@]}"; do
    [[ -d "$directory" ]] || continue
    # Uploads happen before the deploy lock is acquired. Do not race a pending SCP.
    retention_trim_files "$directory" "$retention_upload_prefix*.tgz" 0 "$mode" "$upload_age" || return 1
    retention_trim_files "$directory" "$retention_upload_prefix*.sh" 0 "$mode" "$upload_age" || return 1
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
    printf 'Retention verified: %s (up to 3 distinct rollback images, 5 source archives, 30 DB backups, 10 test logs)\n' "$retention_root"
  fi
}

retention_main() {
  local contour mode failed=0
  if [[ "$#" = 1 && ( "$1" = --check-all || "$1" = --apply-all ) ]]; then
    mode=--check
    [[ "$1" != --apply-all ]] || mode=--apply
    for contour in production test max; do
      retention_config "$contour" || return 1
      [[ -d "$retention_root" ]] || continue
      retention_execute "$mode" || failed=1
    done
    return "$failed"
  fi
  [[ "$#" = 2 ]] || { echo 'Usage: retention.sh production|test|max --check|--apply|--database-only; or --check-all|--apply-all' >&2; return 2; }
  contour=$1 mode=$2
  [[ "$mode" = --check || "$mode" = --apply || "$mode" = --database-only ]] || return 2
  retention_config "$contour" || return 2
  retention_execute "$mode"
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then retention_main "$@"; fi
