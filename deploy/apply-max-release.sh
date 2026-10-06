#!/bin/bash
# Every write is scoped to MAX. No Telegram environment/database is replaced.
set -euo pipefail
umask 077
mode=${1:?Missing mode}
payment_flag=${5:-}
[[ -z "$payment_flag" || ( "$mode" = --apply && "$payment_flag" = --enable-payments ) ]] || { echo 'Payment activation requires --apply --enable-payments' >&2; exit 2; }
[[ $# -le 5 ]] || exit 2
root=/opt/recipeboibot-max
host=recipeboibot-max.89-223-123-75.sslip.io
container=recipeboibot-max
image=recipeboibot-max-app

check_tools() {
  for command in docker curl python3 openssl flock nginx certbot; do command -v "$command" >/dev/null; done
  docker network inspect recipeboibot-v6 >/dev/null
  nginx -t
}

assert_runtime() {
  docker exec "$container" node --input-type=module -e '
    import {config,assertConfig} from "./src/config.js";
    assertConfig();
    if(process.env.BOT_PLATFORM!=="max" || config.telegramPolling || process.env.TELEGRAM_POLLING!=="false" || process.env.MAX_BOT_USERNAME!=="id500912857935_bot" || process.env.MAX_API_ORIGIN!=="https://platform-api2.max.ru" || !/^[A-Za-z0-9_-]{32,256}$/.test(process.env.MAX_WEBHOOK_SECRET||"")) process.exit(1);
    if(process.env.TELEGRAM_BOT_TOKEN || process.env.YANDEX_DIRECT_TOKEN || config.testContour || config.robokassaTest) process.exit(1);
    if(config.robokassaConfigured ? !config.billingRequired : config.billingRequired || config.robokassaRecurring) process.exit(1);
  '
}

assert_payment_namespace() {
  # Read MAX invoices without importing billing or migrating its sequence.
  docker exec "$container" node --input-type=module -e '
    import {DatabaseSync} from "node:sqlite";
    const db=new DatabaseSync("/app/data/recipes.sqlite",{readOnly:true});
    try {
      const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type=\u0027table\u0027 AND name=\u0027payment_orders\u0027").get();
      if(exists && db.prepare("SELECT 1 FROM payment_orders WHERE typeof(inv_id)!=\u0027integer\u0027 OR inv_id<1000000000000 OR inv_id>9007199254740991 LIMIT 1").get())process.exitCode=1;
      const sequenced=db.prepare("SELECT 1 FROM sqlite_master WHERE type=\u0027table\u0027 AND name=\u0027sqlite_sequence\u0027").get();
      const seq=sequenced?db.prepare("SELECT seq FROM sqlite_sequence WHERE name=\u0027payment_orders\u0027").get()?.seq:0;
      if(seq!=null && (!Number.isSafeInteger(seq)||seq<0||seq>=Number.MAX_SAFE_INTEGER))process.exitCode=1;
    } finally {db.close();}
  ' >/dev/null 2>&1 || { echo 'MAX payment invoice namespace validation failed' >&2; return 1; }
}

assert_endpoints() {
  for base in http://127.0.0.1:3089 "https://$host"; do
    curl -fsS --max-time 20 "$base/healthz" >/dev/null
    curl -fsS --max-time 20 "$base/readyz" | python3 -c 'import json,sys; assert json.load(sys.stdin)["ok"] is True'
    status=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' "$base/api/max/webhook")
    [[ "$status" = 401 || "$status" = 403 ]] || { echo 'MAX webhook must reject unsigned requests' >&2; return 1; }
  done
}

runtime_hash() {
  docker exec "$container" node --input-type=module -e '
    import {createHash} from "node:crypto";import {readFileSync,readdirSync} from "node:fs";
    const h=createHash("sha256");function visit(dir){for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name)))){const p=dir+"/"+e.name;if(e.isDirectory())visit(p);else if(e.isFile())h.update(p).update("\0").update(readFileSync(p));else process.exit(1);}}
    visit("src");visit("public");console.log(h.digest("hex"));
  '
}

check_setup() {
  check_tools
  test ! -e "$root"
  test ! -e /etc/nginx/sites-enabled/recipeboibot-max
  test ! -e /etc/nginx/sites-available/recipeboibot-max
  ! docker inspect "$container" >/dev/null 2>&1
  ! docker volume inspect recipeboibot-max_recipeboibot-max-data >/dev/null 2>&1
  python3 - <<'PY'
import socket
with socket.socket() as probe: probe.bind(('127.0.0.1',3089))
PY
  test -f /opt/recipeboibot/.env.local
  test -d /var/www/letsencrypt
  echo 'MAX bootstrap prerequisites verified; no server changes made'
}

case "$mode" in
  --setup-check) check_setup; exit 0;;
  --check)
    check_tools
    cd "$root"
    test -f .env.local
    test -f compose.max.yaml
    test -f backups/backup.key
    test -f DEPLOYED_REVISION
    export RELEASE_REVISION=$(cat DEPLOYED_REVISION)
    docker compose -f compose.max.yaml ps
    assert_runtime
    assert_endpoints
    docker exec -e EXPECTED_REVISION="$RELEASE_REVISION" "$container" node -e 'if(process.env.RELEASE_REVISION!==process.env.EXPECTED_REVISION)process.exit(1)'
    [[ $(runtime_hash) = $(cat DEPLOYED_SOURCE_SHA256) ]]
    echo 'MAX runtime, HTTPS and isolated configuration verified'
    exit 0;;
  --setup|--apply) ;;
  *) echo 'Unknown MAX deployment mode' >&2; exit 2;;
esac

revision=${2:?Missing revision}
release=${3:?Missing archive checksum}
expected_tree=${4:?Missing source checksum}
[[ "$revision" =~ ^[0-9a-f]{40}$ && "$release" =~ ^[0-9a-f]{64}$ && "$expected_tree" =~ ^[0-9a-f]{64}$ ]] || exit 2
archive="/root/recipeboibot-max-release-$release.tgz"
secret_file="/root/recipeboibot-max-release-$release.env"
payment_candidate="$root/.env.max-payment-candidate"
payment_docker_env="$root/.env.max-payment-validation"
trap 'rm -f -- "$secret_file" "$payment_candidate" "$payment_docker_env"' EXIT
printf '%s  %s\n' "$release" "$archive" | sha256sum -c -
exec 9>/tmp/recipeboibot-max-deploy.lock
flock -n 9 || { echo 'Another MAX deployment is running' >&2; exit 1; }
exec 8>/tmp/recipeboibot-docker-deploy.lock
flock -n 8 || { echo 'Another Docker deployment is running' >&2; exit 1; }
check_tools
stamp=$(date -u +%Y%m%dT%H%M%SZ)
previous="$image:before-max-$stamp"
nginx_created=false
source_backup="backups/source-before-max-$stamp.tgz"
existing=false
payment_config_changed=false
env_backup="$root/backups/env-before-max-payments-$stamp.local"
compose_backup="$root/backups/compose-before-max-payments-$stamp.yaml"

if [[ "$mode" = --setup ]]; then
  check_setup
  test -f "$secret_file"
  install -d -m 700 "$root" "$root/backups"
  MAX_SECRET_FILE="$secret_file" python3 - <<'PY'
import json,os,pathlib,re,secrets,subprocess
root=pathlib.Path('/opt/recipeboibot-max')
def read(file):
    data={}
    for line in pathlib.Path(file).read_text().splitlines():
        m=re.match(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$',line)
        if not m: continue
        if m[1] in data: raise RuntimeError('Duplicate environment setting')
        v=m[2]
        if len(v)>1 and v[0] in "\"'" and v[-1]==v[0]: v=v[1:-1]
        data[m[1]]=v
    return data
local=read(os.environ['MAX_SECRET_FILE'])
assert set(local)<= {'MAX_BOT_TOKEN','MAX_WEBHOOK_SECRET'}, 'Unexpected MAX credential setting'
assert re.fullmatch(r'[A-Za-z0-9._:-]+',local.get('MAX_BOT_TOKEN','')), 'Missing or invalid MAX token'
local.setdefault('MAX_WEBHOOK_SECRET',secrets.token_urlsafe(48))
assert re.fullmatch(r'[A-Za-z0-9_-]{32,256}',local['MAX_WEBHOOK_SECRET']), 'Invalid MAX webhook secret'
main=read('/opt/recipeboibot/.env.local')
allowed=['OPENAI_API_KEY','OPENAI_TEXT_MODEL','OPENAI_TRANSCRIBE_MODEL','OPENAI_IMAGE_MODEL','DINNER_TEXT_MODEL','DINNER_VALIDATOR_MODEL','DINNER_IMAGES_ENABLED','DINNER_LLM_ENABLED','DINNER_GENERATION_TIMEOUT_MS','AI_MAX_INPUT_CHARS','AI_MAX_DAILY_REQUESTS','MAX_UPLOAD_BYTES','MAX_REMOTE_BYTES']
effective=json.loads(subprocess.check_output(['docker','exec','recipeboibot','node','-e','console.log(JSON.stringify(Object.fromEntries('+json.dumps(allowed)+'.map(k=>[k,process.env[k]]))))'],text=True))
values={key:effective.get(key) or main.get(key) for key in allowed if effective.get(key) or main.get(key)}
assert all(values.get(key) for key in ['OPENAI_API_KEY','OPENAI_TEXT_MODEL','OPENAI_TRANSCRIBE_MODEL']), 'Missing AI configuration'
values.update(local)
# Single quoted Compose env_file values preserve literals (including $).
assert all('\n' not in v and '\r' not in v and "'" not in v for v in values.values()), 'Unsupported environment value encoding'
destination=root/'.env.local'
with destination.open('x') as output:
    for key,value in values.items(): output.write(f"{key}='{value}'\n")
destination.chmod(0o600)
print('Separate MAX environment created; copied AI settings only')
PY
  rm -f -- "$secret_file"
  openssl rand -hex -out "$root/backups/backup.key" 32
  chmod 600 "$root/backups/backup.key"
else
  cd "$root"
  test -f .env.local
  test -f backups/backup.key
  assert_runtime
  existing=true
  tar -czf "$source_backup" src public deploy scripts test Dockerfile package.json compose.max.yaml DEPLOYED_REVISION DEPLOYED_ARCHIVE_SHA256 DEPLOYED_SOURCE_SHA256
  docker tag "$image:latest" "$previous"
fi
cd "$root"

rollback() {
  trap - ERR
  echo 'MAX release failed; preserving MAX database and restoring its previous source/image' >&2
  if [[ "$existing" = true ]]; then
    # Fixed MAX source directories only; the database is deliberately preserved.
    rm -rf -- /opt/recipeboibot-max/src /opt/recipeboibot-max/public /opt/recipeboibot-max/deploy /opt/recipeboibot-max/scripts /opt/recipeboibot-max/test
    tar -xzf "$source_backup"
    if [[ "$payment_config_changed" = true ]]; then
      install -m 600 "$env_backup" "$root/.env.local"
      install -m 600 "$compose_backup" "$root/compose.max.yaml"
    fi
    docker tag "$previous" "$image:latest"
    export RELEASE_REVISION=$(cat DEPLOYED_REVISION)
    docker compose -f compose.max.yaml up -d --no-build app
  else
    docker stop "$container" >/dev/null 2>&1 || true
    if [[ "$nginx_created" = true ]]; then
      rm -f -- /etc/nginx/sites-enabled/recipeboibot-max /etc/nginx/sites-available/recipeboibot-max
      nginx -t && systemctl reload nginx
    fi
    echo 'Incomplete MAX bootstrap retained for diagnosis; env/key/volume must be preserved' >&2
  fi
  rm -f -- "$secret_file"
  exit 1
}
trap rollback ERR
if [[ "$existing" = true ]]; then
  # Replace complete committed sources so removed files cannot survive an update.
  rm -rf -- /opt/recipeboibot-max/src /opt/recipeboibot-max/public /opt/recipeboibot-max/deploy /opt/recipeboibot-max/scripts /opt/recipeboibot-max/test
fi
tar -xzf "$archive"
if [[ "$existing" = false ]]; then install -m 600 deploy/compose.max.yaml compose.max.yaml; fi
export RELEASE_REVISION="$revision"

tree_hash=$(python3 - <<'PY'
import hashlib,pathlib
h=hashlib.sha256()
def visit(name):
    for p in sorted(pathlib.Path(name).iterdir(),key=lambda p:p.name.encode()):
        assert not p.is_symlink()
        if p.is_dir(): visit(p.as_posix())
        elif p.is_file(): h.update(p.as_posix().encode()+b'\0'+p.read_bytes())
visit('src');visit('public');print(h.hexdigest())
PY
)
[[ "$tree_hash" = "$expected_tree" ]] || { echo 'Archived shared source differs from committed local source' >&2; false; }
docker compose -f compose.max.yaml build app
# No production secrets, data volumes or network are exposed to server tests.
docker run --rm --network none -e BOT_PLATFORM=telegram -e TELEGRAM_POLLING=false -v "$PWD/test:/app/test:ro" -v "$PWD/deploy:/app/deploy:ro" -v "$PWD/scripts:/app/scripts:ro" "$image:latest" node --test --test-concurrency=1 > "backups/tests-$stamp.log" 2>&1
tail -n 10 "backups/tests-$stamp.log"

# Read-only MAX identity probe, using verified extra trust only in this container.
test -f deploy/max-ca-bundle.pem
docker compose -f compose.max.yaml run --rm --no-deps --entrypoint node app --input-type=module -e '
    try {
      const r=await fetch("https://platform-api2.max.ru/me",{headers:{Authorization:process.env.MAX_BOT_TOKEN},redirect:"error",signal:AbortSignal.timeout(20000)});
      if(!r.ok)throw new Error();const bot=await r.json();
      if(bot.username!=="id500912857935_bot"||bot.is_bot!==true)throw new Error();
      console.log("MAX API TLS and bot identity verified");
    } catch { console.error("MAX API identity or TLS verification failed");process.exit(1); }
  '

if [[ "$existing" = true ]]; then
  docker exec "$container" node --input-type=module -e 'import {DatabaseSync,backup} from "node:sqlite";const db=new DatabaseSync("/app/data/recipes.sqlite",{readOnly:true});await backup(db,"/app/data/deploy-backup.sqlite");db.close();'
  docker exec "$container" node -e 'process.stdout.write(require("node:fs").readFileSync("/app/data/deploy-backup.sqlite"))' |
    openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass file:backups/backup.key -out "backups/recipes-before-max-$stamp.sqlite.enc"
  docker exec "$container" node -e 'require("node:fs").unlinkSync("/app/data/deploy-backup.sqlite")'
fi

if [[ "$mode" = --setup ]]; then
  cat > /etc/nginx/sites-available/recipeboibot-max <<'NGINX'
server {
    listen 80;
    server_name recipeboibot-max.89-223-123-75.sslip.io;
    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; try_files $uri =404; }
    location / { return 503; }
}
NGINX
  nginx_created=true
  ln -s /etc/nginx/sites-available/recipeboibot-max /etc/nginx/sites-enabled/recipeboibot-max
  nginx -t
  systemctl reload nginx
  certbot certonly --webroot -w /var/www/letsencrypt --cert-name recipeboibot-max -d "$host" --non-interactive --agree-tos --register-unsafely-without-email
  install -m 644 deploy/nginx-max.conf /etc/nginx/sites-available/recipeboibot-max
  nginx -t
  systemctl reload nginx
fi
if [[ "$payment_flag" = --enable-payments ]]; then
  [[ "$existing" = true ]] || { echo 'Payment activation requires an existing MAX contour' >&2; false; }
  assert_payment_namespace
  # Release tests, verified MAX TLS and encrypted DB backup completed above.
  # Production credentials stay within this server and never enter shell argv.
  install -m 600 .env.local "$env_backup"
  install -m 600 compose.max.yaml "$compose_backup"
  python3 - <<'PY'
import json,pathlib,re,subprocess
root=pathlib.Path('/opt/recipeboibot-max')
allowed=['ROBOKASSA_MERCHANT_LOGIN','ROBOKASSA_PASSWORD1','ROBOKASSA_PASSWORD2','ROBOKASSA_HASH_ALGORITHM','ROBOKASSA_RECURRING_ENABLED','PAYMENT_TAX','PAYMENT_SNO','PAYMENT_METHOD','PAYMENT_PRICE_VARIANTS','PAYMENT_EXPERIMENT_KEY']
probe='''import {config,assertConfig} from "./src/config.js";
assertConfig();if(!config.robokassaConfigured||config.robokassaTest||config.testContour||config.botPlatform!=="telegram")process.exit(1);
console.log(JSON.stringify({ROBOKASSA_MERCHANT_LOGIN:config.robokassaMerchantLogin,ROBOKASSA_PASSWORD1:config.robokassaPassword1,ROBOKASSA_PASSWORD2:config.robokassaPassword2,ROBOKASSA_HASH_ALGORITHM:config.robokassaHash,ROBOKASSA_RECURRING_ENABLED:String(config.robokassaRecurring),PAYMENT_TAX:config.paymentTax,PAYMENT_SNO:config.paymentSno,PAYMENT_METHOD:config.paymentMethod,PAYMENT_PRICE_VARIANTS:config.paymentPriceVariants.join(","),PAYMENT_EXPERIMENT_KEY:config.paymentExperimentKey}));'''
try:
    effective=json.loads(subprocess.check_output(['docker','exec','recipeboibot','node','--input-type=module','-e',probe],text=True,stderr=subprocess.DEVNULL))
except Exception:
    raise SystemExit('Production merchant validation failed')
assert set(effective)==set(allowed), 'Unexpected merchant configuration shape'
assert all(isinstance(v,str) and '\n' not in v and '\r' not in v and '\0' not in v and "'" not in v for v in effective.values()), 'Unsupported merchant configuration encoding'
assert all(effective.get(k) for k in ['ROBOKASSA_MERCHANT_LOGIN','ROBOKASSA_PASSWORD1','ROBOKASSA_PASSWORD2','PAYMENT_TAX']), 'Production merchant is not configured'
assert effective['ROBOKASSA_HASH_ALGORITHM'] in ['md5','ripemd160','sha1','sha256','sha384','sha512'], 'Unsupported merchant hash'
assert effective['ROBOKASSA_RECURRING_ENABLED'] in ['true','false'], 'Invalid recurring configuration'
effective.update(ROBOKASSA_TEST='false',BILLING_REQUIRED='true')
source=(root/'.env.local').read_text()
values={};retained=[]
for line in source.splitlines():
    m=re.match(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$',line)
    if not m: retained.append(line); continue
    assert m[1] not in values, 'Duplicate MAX environment setting'
    value=m[2]
    if len(value)>1 and value[0] in "\"'" and value[-1]==value[0]: value=value[1:-1]
    assert '\n' not in value and '\r' not in value and '\0' not in value, 'Invalid MAX environment encoding'
    values[m[1]]=value
    if m[1] not in effective: retained.append(line)
assert not values.get('TELEGRAM_BOT_TOKEN') and not values.get('YANDEX_DIRECT_TOKEN'), 'MAX isolation violation'
assert values.get('TEST_CONTOUR','false')!='true', 'MAX must be a live contour'
retained.extend(f"{key}='{value}'" for key,value in effective.items())
candidate=root/'.env.max-payment-candidate'
candidate.write_text('\n'.join(retained)+'\n');candidate.chmod(0o600)
values.update(effective)
validation=root/'.env.max-payment-validation'
# Docker --env-file needs raw values instead of Compose single-quoted values.
validation.write_text(''.join(f'{key}={value}\n' for key,value in values.items()));validation.chmod(0o600)
PY
  docker run --rm --network none --env-file "$payment_docker_env" \
    -e NODE_ENV=production -e BOT_PLATFORM=max -e MAX_BOT_USERNAME=id500912857935_bot \
    -e MAX_API_ORIGIN=https://platform-api2.max.ru -e TELEGRAM_POLLING=false \
    -e DATABASE_PATH=/tmp/max-payment-validation.sqlite \
    "$image:latest" node --input-type=module -e '
      import {config,assertConfig} from "./src/config.js";assertConfig();
      if(!config.robokassaConfigured||!config.billingRequired||config.robokassaTest||config.testContour||config.telegramToken||config.yandexDirectToken)process.exit(1);
    ' >/dev/null 2>&1 || { echo 'MAX payment configuration validation failed' >&2; false; }
  payment_config_changed=true
  install -m 600 "$payment_candidate" .env.local
  install -m 600 deploy/compose.max.yaml compose.max.yaml
  rm -f -- "$payment_candidate" "$payment_docker_env"
fi
docker compose -f compose.max.yaml up -d --no-build app
healthy=false
for attempt in $(seq 1 30); do
  if [[ $(docker inspect --format '{{.State.Health.Status}}' "$container") = healthy ]]; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" = true ]]
assert_runtime
assert_endpoints
docker exec -e EXPECTED_REVISION="$revision" "$container" node -e 'if(process.env.RELEASE_REVISION!==process.env.EXPECTED_REVISION)process.exit(1)'
runtime_tree=$(runtime_hash)
[[ "$runtime_tree" = "$expected_tree" ]]
docker exec "$container" node --input-type=module -e 'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync("/app/data/recipes.sqlite",{readOnly:true});if(db.prepare("PRAGMA integrity_check").get().integrity_check!=="ok"||db.prepare("PRAGMA foreign_key_check").all().length)process.exit(1);db.close();'
printf '%s\n' "$revision" > DEPLOYED_REVISION
printf '%s\n' "$release" > DEPLOYED_ARCHIVE_SHA256
printf '%s\n' "$expected_tree" > DEPLOYED_SOURCE_SHA256
trap - ERR
rm -f -- "$archive" "/root/recipeboibot-max-release-$release.sh" "$secret_file"
printf 'MAX release published: %s\nShared source SHA-256: %s\nHTTPS: https://%s\n' "$revision" "$expected_tree" "$host"
