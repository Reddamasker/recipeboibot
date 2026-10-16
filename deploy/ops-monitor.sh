#!/bin/sh
set -eu

base_dir="${RECIPEBOIBOT_BASE_DIR:-/opt/recipeboibot}"
env_file="$base_dir/.env.local"
state_dir="${RECIPEBOIBOT_MONITOR_STATE_DIR:-/var/lib/recipeboibot-monitor}"
state_file="$state_dir/current-status"
container="${RECIPEBOIBOT_CONTAINER:-recipeboibot}"
local_url="${RECIPEBOIBOT_LOCAL_URL:-http://127.0.0.1:3087}"
public_url="${RECIPEBOIBOT_PUBLIC_URL:-https://dishfinder.ru}"
mode="${1:-}"

read_env() {
  key="$1"
  [ -f "$env_file" ] || return 0
  sed -n "s/^${key}=//p" "$env_file" | tail -n 1 | tr -d '\r' | sed 's/^"//;s/"$//'
}

alert_chat_id="$(read_env OPS_ALERT_CHAT_ID)"
telegram_token="$(read_env TELEGRAM_BOT_TOKEN)"
telegram_origin="$(read_env OPS_TELEGRAM_API_ORIGIN)"
[ -n "$telegram_origin" ] || telegram_origin="https://api.telegram.org"
telegram_origin="${telegram_origin%/}"

send_alert() {
  text="$1"
  if [ -z "$alert_chat_id" ] || [ -z "$telegram_token" ]; then
    printf '%s\n' "Monitoring alert was not delivered: OPS_ALERT_CHAT_ID or TELEGRAM_BOT_TOKEN is missing" >&2
    return 1
  fi
  alert_response="$(curl -fsS --max-time 20 -X POST "${telegram_origin}/bot${telegram_token}/sendMessage" \
    --data-urlencode "chat_id=${alert_chat_id}" \
    --data-urlencode "text=${text}")" || return 1
  if ! printf '%s' "$alert_response" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true[[:space:]]*[,}]'; then
    printf '%s\n' 'Monitoring alert was not confirmed by Telegram' >&2
    return 1
  fi
  printf '%s\n' 'Monitoring alert delivery confirmed by Telegram'
}

failures=""
add_failure() {
  if [ -n "$failures" ]; then failures="$failures
$1"; else failures="$1"; fi
}

if ! curl -fsS --max-time 10 "$local_url/healthz" >/dev/null; then add_failure "Локальный healthcheck недоступен"; fi
if ! curl -fsS --max-time 15 "$public_url/healthz" >/dev/null; then add_failure "Публичный healthcheck недоступен"; fi

container_state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}} {{.State.OOMKilled}} {{.State.StartedAt}}' "$container" 2>/dev/null || true)"
set -- $container_state
starting_grace=false
if [ "$#" -ne 5 ]; then
  add_failure "Контейнер не найден"
else
  if [ "$1" = "running" ] && [ "$2" = "starting" ] && [ "$3" = "0" ] && [ "$4" = "false" ]; then
    started_at="$(date -d "$5" +%s 2>/dev/null || true)"
    if [ -n "$started_at" ]; then
      startup_age=$(($(date +%s) - started_at))
      if [ "$startup_age" -ge 0 ] && [ "$startup_age" -lt 90 ]; then starting_grace=true; fi
    fi
  fi
  [ "$1" = "running" ] || add_failure "Контейнер не запущен: $1"
  if [ "$2" != "healthy" ] && [ "$starting_grace" != "true" ]; then add_failure "Контейнер unhealthy: $2"; fi
  [ "$3" = "0" ] || add_failure "Контейнер перезапускался: $3"
  [ "$4" = "false" ] || add_failure "Контейнер завершался по OOM"
fi

disk_used="$(df -P "$base_dir" | awk 'NR==2 { gsub(/%/,"",$5); print $5 }')"
if [ -z "$disk_used" ]; then add_failure "Не удалось прочитать заполнение диска"
elif [ "$disk_used" -ge 90 ]; then add_failure "Критически заполнен диск: ${disk_used}%"
elif [ "$disk_used" -ge 80 ]; then add_failure "Диск заполнен на ${disk_used}%"
fi

# The same policy audits every contour, including MAX. A deployment holds this
# lock until its cleanup finishes, so an in-progress release is not a false alarm.
retention_status=0
if [ ! -f "$base_dir/deploy/retention.sh" ]; then
  add_failure "Отсутствует общий механизм ротации резервов и Docker"
else
  flock -n -E 75 /tmp/recipeboibot-docker-deploy.lock bash "$base_dir/deploy/retention.sh" --check-all >/dev/null 2>&1 || retention_status=$?
  case "$retention_status" in
    0|75) ;;
    *) add_failure "Нарушена ротация резервов или Docker в Telegram/MAX";;
  esac
fi

latest_backup="$(find "$base_dir/backups" -maxdepth 1 -type f -name 'recipes-*.sqlite.enc' -printf '%T@\n' 2>/dev/null | sort -nr | head -n 1 | cut -d. -f1)"
now="$(date +%s)"
if [ -z "$latest_backup" ]; then add_failure "Нет зашифрованной резервной копии БД"
elif [ $((now - latest_backup)) -gt 108000 ]; then add_failure "Локальная резервная копия старше 30 часов"
fi

offsite_marker="$base_dir/backups/offsite-last-success"
if [ ! -f "$offsite_marker" ]; then add_failure "Ещё не подтверждена внешняя резервная копия"
else
  offsite_age=$((now - $(stat -c %Y "$offsite_marker")))
  [ "$offsite_age" -le 129600 ] || add_failure "Внешняя резервная копия старше 36 часов"
fi

# BILLING_REQUIRED only enforces configuration at startup; it does not enable sales.
# Parse the live JSON with the existing container's Node runtime, without loading the app.
if readiness="$(curl -fsS --max-time 10 "$local_url/readyz")"; then
  if ! printf '%s' "$readiness" | docker exec -i "$container" node -e '
    const fs = require("node:fs");
    try {
      const status = JSON.parse(fs.readFileSync(0, "utf8"));
      process.exit(status.ok === true && status.service === "recipeboibot" && status.billing?.configured === true ? 0 : 1);
    } catch { process.exit(1); }
  '; then
    add_failure "Готовность платёжного контура не подтверждена"
  fi
else
  add_failure "Проверка готовности платёжного контура недоступна"
fi

# Probe the same validation and merge used by the dashboard. HTTP 200 and healthy
# containers do not guarantee a compatible MAX aggregate. Bound the entire probe.
if ! timeout 20 docker exec "$container" node --input-type=module -e '
  try {
    const {config} = await import("./src/config.js");
    if (config.botPlatform === "telegram" && !config.testContour && config.yandexDirectMaxCampaignId) {
      const {mergeMaxFunnelReport} = await import("./src/max-funnel.js");
      const {funnelReport} = await import("./src/funnel.js");
      const report = await mergeMaxFunnelReport(funnelReport("all"));
      if (report.remoteFunnel?.status !== "ready") process.exit(1);
    }
  } catch { process.exit(1); }
'; then
  add_failure "Данные MAX недоступны в дашборде: ошибка обмена или несовместимая версия"
fi

mkdir -p "$state_dir"
previous=""
[ ! -f "$state_file" ] || previous="$(cat "$state_file")"

if [ "$mode" = "--test-alert" ]; then
  send_alert "Твои рецепты: тест оповещений мониторинга успешно доставлен."
fi

if [ "$failures" != "$previous" ]; then
  if [ -n "$failures" ]; then
    resolved=""
    while IFS= read -r issue; do
      [ -n "$issue" ] || continue
      if ! printf '%s\n' "$failures" | grep -Fxq -- "$issue"; then
        resolved="${resolved}${issue}
"
      fi
    done <<EOF
$previous
EOF
    recovery=""
    if [ -n "$resolved" ]; then recovery="
Устранено:
${resolved}"; fi
    send_alert "Твои рецепты: требуется внимание.
$failures${recovery}"
  elif [ -n "$previous" ]; then
    send_alert "Твои рецепты: все контролируемые показатели снова в норме."
  fi
  printf '%s' "$failures" > "$state_file"
fi

exit 0
