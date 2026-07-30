#!/usr/bin/env zsh
# TACO multi-repository release runner.
#
# Canonical tracked source for the workspace-level ./scripts/release.zsh wrapper.
#
# Default release:
#   1. require clean main branches for contracts/backend/frontend/docs
#   2. compare local contracts against the npm package
#   3. run contracts, backend, schema, and frontend gates
#   4. publish contracts only when its version is newer
#   5. refresh and pathspec-commit backend/frontend contracts locks
#   6. push contracts/backend/frontend main
#
# Useful modes:
#   PUSH=0 ./scripts/release.zsh
#     Read-only release verification. Does not publish, update locks, or push.
#   PREFLIGHT_ONLY=1 ./scripts/release.zsh
#     Clean/branch/contracts-surface checks only.
#   RUN_DB_SMOKE=1 ./scripts/release.zsh
#     Run all domain Neon smokes after normal test gates.
#   RUN_DB_CRUD=1 ./scripts/release.zsh
#     Run the real Postgres CRUD e2e suite.
#   CLEAN_DB_QA_AFTER_SMOKE=1 RUN_DB_SMOKE=1 ./scripts/release.zsh
#     Dry-run then apply the scoped QA cleanup after successful DB smokes.
#   RUN_DB_CLEANUP=1 [CLEAN_DB_QA_APPLY=1] ./scripts/release.zsh
#     Standalone QA/test-record cleanup (smoke 없이): dry-run 카운트 → APPLY 플래그 시 적용.
#     대상: QA topic/2099 날짜 노이즈(soft delete) + 만료 챌린지·rate limit(하드 삭제, PII 최소화).
#   VERIFY_DEPLOYMENT=1 ./scripts/release.zsh
#     After push, require the exact backend/frontend Git SHAs to have successful
#     Vercel deployments, then verify frontend, API, Postgres, and login CORS.
#   VERIFY_DEPLOYMENT_ONLY=1 ./scripts/release.zsh
#     Verify the current deployment without repository preflight, build, publish, or push.
#   RELEASE_SELF_TEST=1 ./scripts/release.zsh
#     Test pure release helpers without reading or mutating repositories.

emulate -L zsh
setopt err_exit pipe_fail no_unset

ROOT="${TACO_WORKSPACE_ROOT:-${0:A:h}/../..}"
CT_NAME="@kms545487/contracts"
MAIN_BRANCH="${MAIN_BRANCH:-main}"
RELEASE_REPOS=(contracts backend frontend)
CHECK_REPOS=(contracts backend frontend docs)
TMP_DIRS=()

PUSH="${PUSH:-1}"
PUBLISH="${PUBLISH:-$PUSH}"
UPDATE_LOCKS="${UPDATE_LOCKS:-$PUBLISH}"
RUN_SCHEMA_GATES="${RUN_SCHEMA_GATES:-1}"
RUN_DB_SMOKE="${RUN_DB_SMOKE:-0}"
RUN_DB_CRUD="${RUN_DB_CRUD:-0}"
VERIFY_DEPLOYMENT="${VERIFY_DEPLOYMENT:-0}"
DB_ENV_FILE="${DOTENV_CONFIG_PATH:-.env.local}"
BACKEND_URL="${BACKEND_URL:-https://taco-backend-omega.vercel.app}"
FRONTEND_URL="${FRONTEND_URL:-https://taco-frontend-tau.vercel.app}"
DEPLOY_WAIT_ATTEMPTS="${DEPLOY_WAIT_ATTEMPTS:-30}"
DEPLOY_WAIT_SECONDS="${DEPLOY_WAIT_SECONDS:-10}"
DEPLOY_INITIAL_WAIT_SECONDS="${DEPLOY_INITIAL_WAIT_SECONDS:-15}"
DEPLOY_STATUS_CONTEXT="${DEPLOY_STATUS_CONTEXT:-Vercel}"
GITHUB_API_URL="${GITHUB_API_URL:-https://api.github.com}"

export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/private/tmp/taco-release-npm-cache}"
mkdir -p "$NPM_CONFIG_CACHE"

log() { print -P "%F{cyan}▶%f $*"; }
ok() { print -P "%F{green}✓%f $*"; }
warn() { print -P "%F{yellow}!%f $*"; }
die() { print -P "%F{red}✗%f $*" >&2; exit 1; }

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

cleanup() {
  local d
  for d in "${TMP_DIRS[@]}"; do
    [[ -n "$d" && -d "$d" ]] && rm -rf "$d"
  done
}
trap cleanup EXIT

normalize_url() {
  print -r -- "${1%/}"
}

github_repo_slug() {
  local remote="$1"
  node - "$remote" <<'NODE'
const remote = process.argv[2];
const patterns = [
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
  /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
  /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
];
const match = patterns.map((pattern) => remote.match(pattern)).find(Boolean);
if (!match) process.exit(1);
process.stdout.write(`${match[1]}/${match[2]}`);
NODE
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

run_in() {
  local repo="$1"
  shift
  log "$repo: $*"
  ( cd "$ROOT/$repo" && "$@" )
}

run_backend_with_db_env() {
  log "backend: DOTENV_CONFIG_PATH=$DB_ENV_FILE $*"
  ( cd "$ROOT/backend" && DOTENV_CONFIG_PATH="$DB_ENV_FILE" "$@" )
}

require_repo() {
  local repo="$1"
  [[ -d "$ROOT/$repo/.git" ]] || die "$repo is not a git repository"
}

repo_branch() {
  git -C "$ROOT/$1" branch --show-current
}

repo_status() {
  git -C "$ROOT/$1" update-index -q --refresh 2>/dev/null || true
  git -C "$ROOT/$1" status --porcelain
}

assert_clean() {
  local repo="$1"
  local repo_state
  repo_state="$(repo_status "$repo")"
  [[ -z "$repo_state" ]] || die "$repo working tree is not clean. Commit or isolate it first.\n$repo_state"
}

assert_main_branch() {
  local repo="$1"
  local branch
  branch="$(repo_branch "$repo")"
  [[ "$branch" == "$MAIN_BRANCH" ]] || die "$repo branch=$branch, expected=$MAIN_BRANCH"
}

delete_stale_locks() {
  local repo="$1"
  [[ -d "$ROOT/$repo/.git" ]] || return 0
  if is_true "${CLEAN_GIT_LOCKS:-1}"; then
    # Fresh locks probably belong to a live git process; only old locks are removed.
    find "$ROOT/$repo/.git" -maxdepth 4 -name "*.lock" -mmin +5 -delete 2>/dev/null || true
  fi
}

json_value() {
  local file="$1"
  local expr="$2"
  node -p "const p=require('${file}'); ${expr}"
}

version_cmp() {
  node - "$1" "$2" <<'NODE'
const [local, remote] = process.argv.slice(2);
if (!remote || remote === 'none') {
  console.log(1);
  process.exit(0);
}
const parse = (value) => String(value).split('.').map((part) => Number(part.replace(/[^0-9].*$/, '')) || 0);
const left = parse(local);
const right = parse(remote);
for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
  const difference = (left[index] || 0) - (right[index] || 0);
  if (difference) {
    console.log(difference > 0 ? 1 : -1);
    process.exit(0);
  }
}
console.log(0);
NODE
}

json_assert() {
  local file="$1"
  local expression="$2"
  node - "$file" "$expression" <<'NODE'
const fs = require('node:fs');
const [file, expression] = process.argv.slice(2);
const body = JSON.parse(fs.readFileSync(file, 'utf8'));
const matches = Function('body', `return Boolean(${expression})`)(body);
if (!matches) {
  console.error(JSON.stringify(body));
  process.exit(1);
}
NODE
}

vercel_status_target() {
  local file="$1"
  local expected_sha="$2"
  local expected_context="$3"
  node - "$file" "$expected_sha" "$expected_context" <<'NODE'
const fs = require('node:fs');
const [file, expectedSha, expectedContext] = process.argv.slice(2);
const body = JSON.parse(fs.readFileSync(file, 'utf8'));
if (body.sha !== expectedSha) process.exit(2);
const status = body.statuses?.find((candidate) => candidate.context === expectedContext);
if (status?.state === 'failure' || status?.state === 'error') process.exit(3);
if (status?.state !== 'success' || !status.target_url) process.exit(1);
process.stdout.write(status.target_url);
NODE
}

assert_release_safety() {
  local mutating=0
  if is_true "$PUSH" || is_true "$PUBLISH"; then
    mutating=1
  fi

  if (( mutating )) && ! is_true "${ALLOW_UNSAFE_RELEASE:-0}"; then
    if is_true "${SKIP_TESTS:-0}" || is_true "${SKIP_E2E:-0}" || is_true "${SKIP_FE_TEST:-0}" || ! is_true "$RUN_SCHEMA_GATES"; then
      die "publish/push with skipped gates requires ALLOW_UNSAFE_RELEASE=1"
    fi
  fi

  if is_true "$PUBLISH" && ! is_true "$PUSH" && ! is_true "${ALLOW_PUBLISH_WITHOUT_PUSH:-0}"; then
    die "PUBLISH=1 with PUSH=0 requires ALLOW_PUBLISH_WITHOUT_PUSH=1"
  fi

  if is_true "$UPDATE_LOCKS" && ! is_true "$PUBLISH"; then
    die "UPDATE_LOCKS=1 requires PUBLISH=1 so consumers can install the exact package"
  fi
}

compare_published_contract_surface() {
  local npm_ver="$1"
  local tmp pack_file
  tmp="$(mktemp -d)"
  TMP_DIRS+=("$tmp")

  run_in contracts npm run build >/dev/null
  log "contracts: npm v$npm_ver tarball d.ts surface compare"
  pack_file="$(cd "$tmp" && npm pack "$CT_NAME@$npm_ver" --silent)"
  tar -xzf "$tmp/$pack_file" -C "$tmp"
  diff -qr "$ROOT/contracts/dist" "$tmp/package/dist" >/dev/null
}

run_schema_gates() {
  local tmp
  tmp="$(mktemp -d)"
  TMP_DIRS+=("$tmp")

  run_in backend npm run openapi
  run_in backend npm run verify:doc-links
  # [TBO-79 F1·F2] 표면·도메인 게이트를 릴리스 경로에 편입한다. 종전엔 둘 다 수동 실행이었고,
  #  crud-surfaces는 substring 매칭이라 통과가 증거가 되지 못했다(거짓 완료 FC-4·FC-5).
  run_in backend npm run verify:crud-surfaces
  run_in backend npm run db:verify-contract-domains
  log "docs: generate PostgreSQL SQL from erd.dbml"
  npx -y -p @dbml/cli dbml2sql "$ROOT/docs/erd.dbml" --postgres -o "$tmp/erd.sql"
  [[ -s "$tmp/erd.sql" ]] || die "DBML generated an empty PostgreSQL file"

  # Generated OpenAPI must already be committed; release never hides documentation drift.
  assert_clean backend
  assert_clean docs
  ok "Swagger/OpenAPI and DBML gates passed"
}

db_env_file_exists() {
  if [[ "$DB_ENV_FILE" == /* ]]; then
    [[ -f "$DB_ENV_FILE" ]]
  else
    [[ -f "$ROOT/backend/$DB_ENV_FILE" ]]
  fi
}

require_db_config() {
  if [[ -n "${DATABASE_URL_UNPOOLED:-}" || -n "${DATABASE_URL:-}" || -n "${POSTGRES_URL_NON_POOLING:-}" || -n "${POSTGRES_URL:-}" ]]; then
    return 0
  fi
  db_env_file_exists || die "DB gates requested, but no database URL env or backend/$DB_ENV_FILE was found"
}

run_db_gates() {
  if ! is_true "$RUN_DB_SMOKE" && ! is_true "$RUN_DB_CRUD" && ! is_true "${RUN_DB_CLEANUP:-0}"; then
    return 0
  fi

  require_db_config
  run_backend_with_db_env npm run db:check

  # [TBO-59 2026-07-24] 독립 QA/테스트 레코드 정리 — 스모크 없이도 실행 가능(대표 지시).
  #  기본 dry-run(카운트만) → CLEAN_DB_QA_APPLY=1일 때만 실제 적용(soft delete + 만료 챌린지
  #  하드 삭제). 파괴적 적용 전 Neon 브랜치 스냅샷은 상시 규약(RUNBOOK §3).
  if is_true "${RUN_DB_CLEANUP:-0}"; then
    run_backend_with_db_env npm run db:cleanup:qa
    if is_true "${CLEAN_DB_QA_APPLY:-0}"; then
      log "backend: apply scoped QA cleanup (CLEAN_DB_QA_APPLY=1)"
      ( cd "$ROOT/backend" && APPLY=1 DOTENV_CONFIG_PATH="$DB_ENV_FILE" npm run db:cleanup:qa )
    else
      warn "dry-run만 수행 — 적용은 RUN_DB_CLEANUP=1 CLEAN_DB_QA_APPLY=1 (사전 Neon 스냅샷 필수)"
    fi
  fi

  if is_true "$RUN_DB_CRUD"; then
    run_backend_with_db_env npm run test:e2e:db-crud
  fi

  if is_true "$RUN_DB_SMOKE"; then
    run_backend_with_db_env npm run db:smoke:calendar-assets
    run_backend_with_db_env npm run db:smoke:audit-log
    run_backend_with_db_env npm run db:smoke:attendance-reports
    run_backend_with_db_env npm run db:smoke:schedule-requests
    run_backend_with_db_env npm run db:smoke:schedule-approval
    run_backend_with_db_env npm run db:smoke:finance
  fi

  if is_true "${CLEAN_DB_QA_AFTER_SMOKE:-0}"; then
    run_backend_with_db_env npm run db:cleanup:qa
    log "backend: apply scoped QA cleanup"
    ( cd "$ROOT/backend" && APPLY=1 DOTENV_CONFIG_PATH="$DB_ENV_FILE" npm run db:cleanup:qa )
  fi
}

run_gates() {
  if is_true "${SKIP_TESTS:-0}"; then
    warn "SKIP_TESTS=1 - all code/test/schema gates skipped"
    return 0
  fi

  run_in contracts npm run build
  run_in backend npm run verify:runtime-data
  run_in backend npm run typecheck
  run_in backend npm run build

  if is_true "${SKIP_E2E:-0}"; then
    warn "SKIP_E2E=1 - backend e2e skipped"
  else
    # [2026-07-16] e2e 출력을 로그 파일로 보존 — 실패 시 어느 스위트/테스트인지 사후 추적 가능
    #  (2026-07-16 새벽 실패가 스크롤백 유실로 재현 불가였던 문제의 재발 방지). tee라 화면 출력 동일.
    local e2e_log="$ROOT/_logs/e2e-$(date +%Y%m%d-%H%M%S).log"
    mkdir -p "$ROOT/_logs"
    # [TBO-59 2026-07-24] 셸에 DB URL이 export 돼 있어도 기본 e2e는 hermetic(in-memory)이다 —
    #  jest-e2e.setup.ts가 RUN_*_E2E opt-in 없으면 DB URL을 전량 제거(운영 Neon 오염 원천 차단).
    if [[ -n "${DATABASE_URL:-}" || -n "${POSTGRES_URL:-}" || -n "${POSTGRES_PRISMA_URL:-}" ]]; then
      warn "셸에 DB URL이 export 되어 있음 — 기본 e2e는 hermetic 가드로 무시합니다(jest-e2e.setup.ts)"
    fi
    log "backend: npm run test:e2e (log: $e2e_log)"
    # [2026-07-16 수정] test:e2e는 이미 --runInBand(직렬) — maxWorkers 병기 시 jest가 거부한다
    #  (실측: "Both --runInBand and --maxWorkers were specified"). 플레이크 완화는 retryTimes(1)가 담당.
    if ! ( setopt pipe_fail; cd "$ROOT/backend" && npm run test:e2e -- --silent 2>&1 | tee "$e2e_log" ); then
      # [TBO-59 2026-07-24] 스톨-플레이크 완화 — 실측(2026-07-24 14:22): payouts 스위트가 앱 무응답
      #  스톨로 10개 연쇄 타임아웃, 단독 재실행은 15/15 green. retryTimes(1)는 앱 인스턴스 자체가
      #  멈추면 못 살리므로, "실패 스위트 ≤3개"에 한해 그 스위트만 새 프로세스로 1회 재실행한다.
      #  둘 다 실패해야 실제 회귀(게이트 차단 유지) — 두 로그 모두 _logs에 보존되어 은폐가 없다.
      local failed_suites
      failed_suites=(${(f)"$(grep -E '^FAIL ' "$e2e_log" | awk '{print $2}' | sed 's#^\./#test/#' | sort -u)"})
      if (( ${#failed_suites} == 0 || ${#failed_suites} > 3 )); then
        warn "backend e2e FAILED (${#failed_suites} suites) — 실패 상세: $e2e_log (FAIL/✕ 블록 확인)"
        grep -E "^FAIL|✕" "$e2e_log" | head -20 || true
        return 1
      fi
      local rerun_log="${e2e_log%.log}-rerun.log"
      warn "e2e 실패 스위트 ${#failed_suites}개 — 스톨-플레이크 판별 재실행: ${failed_suites[*]} (log: $rerun_log)"
      if ! ( setopt pipe_fail; cd "$ROOT/backend" && npm run test:e2e -- --silent "${failed_suites[@]}" 2>&1 | tee "$rerun_log" ); then
        warn "backend e2e FAILED (재실행도 실패 = 실제 회귀) — 로그: $e2e_log / $rerun_log"
        grep -E "^FAIL|✕" "$rerun_log" | head -20 || true
        return 1
      fi
      ok "재실행 green — 1차 실패는 스톨-플레이크로 판정(두 로그 보존: $e2e_log)"
    fi
  fi

  if is_true "$RUN_SCHEMA_GATES"; then
    run_schema_gates
  else
    warn "RUN_SCHEMA_GATES=0 - Swagger and DBML gates skipped"
  fi

  run_in frontend npm run typecheck
  if is_true "${SKIP_FE_TEST:-0}"; then
    warn "SKIP_FE_TEST=1 - frontend vitest skipped"
  else
    run_in frontend npm run test -- --silent
  fi
  run_in frontend npm run build
  run_db_gates
}

refresh_contract_lock() {
  local repo="$1"
  local expected="$2"
  run_in "$repo" npm install "$CT_NAME@$expected" --save-exact=false

  local installed
  installed="$(cd "$ROOT/$repo" && node -p "require('./node_modules/$CT_NAME/package.json').version")"
  [[ "$installed" == "$expected" ]] || die "$repo installed $CT_NAME@$installed, expected $expected"
  ok "$repo node_modules $CT_NAME@$installed"
}

commit_lock_update_if_needed() {
  local repo="$1"
  local version="$2"
  if ! git -C "$ROOT/$repo" diff --quiet -- package.json package-lock.json; then
    git -C "$ROOT/$repo" commit -m "chore: refresh contracts@$version dependency lock" -- package.json package-lock.json
    ok "$repo lockfile commit created"
  else
    ok "$repo lockfile already current"
  fi
}

lock_version() {
  local repo="$1"
  node -p "
    const lock=require('$ROOT/$repo/package-lock.json');
    (lock.packages?.['node_modules/$CT_NAME']?.version) ?? (lock.dependencies?.['$CT_NAME']?.version) ?? 'none'
  "
}

push_repo() {
  local repo="$1"
  local branch
  branch="$(repo_branch "$repo")"
  [[ "$branch" == "$MAIN_BRANCH" ]] || die "$repo branch changed to $branch before push"
  log "$repo: git push origin $branch"
  git -C "$ROOT/$repo" push origin "$branch"
}

wait_for_vercel_commit_deployment() {
  local repo="$1"
  local expected_sha="$2"
  local remote slug url tmp attempt target http_code status_result
  local -a auth_headers

  remote="$(git -C "$ROOT/$repo" remote get-url origin)"
  slug="$(github_repo_slug "$remote")" || die "$repo origin is not a supported GitHub remote: $remote"
  url="$(normalize_url "$GITHUB_API_URL")/repos/$slug/commits/$expected_sha/status"
  tmp="$(mktemp)"
  TMP_DIRS+=("$tmp")
  auth_headers=()
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    auth_headers=(-H "Authorization: Bearer $GITHUB_TOKEN")
  fi

  for attempt in {1..$DEPLOY_WAIT_ATTEMPTS}; do
    http_code="$(curl -L -sS -o "$tmp" -w '%{http_code}' \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      "${auth_headers[@]}" \
      --connect-timeout 10 --max-time 30 "$url" || true)"

    if [[ "$http_code" == "200" ]]; then
      if target="$(vercel_status_target "$tmp" "$expected_sha" "$DEPLOY_STATUS_CONTEXT")"; then
        ok "$repo deployment identity: ${expected_sha[1,12]} ($target)"
        return 0
      else
        status_result=$?
        if (( status_result == 3 )); then
          die "$repo Vercel deployment failed for commit $expected_sha"
        fi
      fi
    elif [[ "$http_code" == "403" || "$http_code" == "429" ]]; then
      die "$repo deployment status API rate-limited (HTTP $http_code); set GITHUB_TOKEN and retry"
    elif [[ "$http_code" == "404" && -z "${GITHUB_TOKEN:-}" ]]; then
      die "$repo deployment status unavailable (HTTP 404); private repositories require GITHUB_TOKEN"
    fi

    warn "$repo exact deployment not ready ($attempt/$DEPLOY_WAIT_ATTEMPTS, sha=${expected_sha[1,12]}, status=$http_code)"
    sleep "$DEPLOY_WAIT_SECONDS"
  done
  die "$repo Vercel deployment did not succeed for commit $expected_sha"
}

wait_for_json() {
  local label="$1"
  local url="$2"
  local expression="$3"
  local tmp attempt
  tmp="$(mktemp)"
  TMP_DIRS+=("$tmp")

  for attempt in {1..$DEPLOY_WAIT_ATTEMPTS}; do
    if curl -fsS --connect-timeout 10 --max-time 30 "$url" > "$tmp" 2>/dev/null && json_assert "$tmp" "$expression" >/dev/null 2>&1; then
      ok "$label: $url"
      return 0
    fi
    warn "$label not ready ($attempt/$DEPLOY_WAIT_ATTEMPTS)"
    sleep "$DEPLOY_WAIT_SECONDS"
  done
  die "$label did not become ready: $url"
}

wait_for_frontend() {
  local url="$1"
  local attempt http_code
  for attempt in {1..$DEPLOY_WAIT_ATTEMPTS}; do
    http_code="$(curl -L -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 30 "$url" || true)"
    if [[ "$http_code" == 2* || "$http_code" == 3* ]]; then
      ok "frontend: $url ($http_code)"
      return 0
    fi
    warn "frontend not ready ($attempt/$DEPLOY_WAIT_ATTEMPTS, status=$http_code)"
    sleep "$DEPLOY_WAIT_SECONDS"
  done
  die "frontend did not become ready: $url"
}

verify_login_cors() {
  local backend="$1"
  local frontend="$2"
  local headers attempt
  headers="$(mktemp)"
  TMP_DIRS+=("$headers")

  for attempt in {1..$DEPLOY_WAIT_ATTEMPTS}; do
    if curl -sS -o /dev/null -D "$headers" -X OPTIONS "$backend/api/auth/login" \
      -H "Origin: $frontend" \
      -H "Access-Control-Request-Method: POST" \
      --connect-timeout 10 --max-time 30; then
      if node - "$headers" "$frontend" <<'NODE'
const fs = require('node:fs');
const [file, expected] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const value = lines.find((line) => /^access-control-allow-origin:/i.test(line))?.split(':').slice(1).join(':').trim();
process.exit(value === expected || value === '*' ? 0 : 1);
NODE
      then
        ok "login CORS allows $frontend"
        return 0
      fi
    fi
    warn "login CORS not ready ($attempt/$DEPLOY_WAIT_ATTEMPTS)"
    sleep "$DEPLOY_WAIT_SECONDS"
  done
  die "login CORS did not allow origin: $frontend"
}

verify_deployment() {
  local backend frontend backend_sha frontend_sha
  backend="$(normalize_url "$BACKEND_URL")"
  frontend="$(normalize_url "$FRONTEND_URL")"
  backend_sha="${EXPECTED_BACKEND_SHA:-$(git -C "$ROOT/backend" rev-parse HEAD)}"
  frontend_sha="${EXPECTED_FRONTEND_SHA:-$(git -C "$ROOT/frontend" rev-parse HEAD)}"

  require_command curl
  wait_for_vercel_commit_deployment backend "$backend_sha"
  wait_for_vercel_commit_deployment frontend "$frontend_sha"
  if (( DEPLOY_INITIAL_WAIT_SECONDS > 0 )); then
    log "wait ${DEPLOY_INITIAL_WAIT_SECONDS}s for production alias propagation"
    sleep "$DEPLOY_INITIAL_WAIT_SECONDS"
  fi

  wait_for_json "backend health" "$backend/api/health" "body.status === 'ok' && body.service === 'taco-api'"
  wait_for_json "backend Postgres" "$backend/api/health/db" "body.status === 'ok' && body.db?.configured === true && body.db?.ready === true"
  verify_login_cors "$backend" "$frontend"
  wait_for_frontend "$frontend/login"
}

release_self_test() {
  local status_file
  [[ "$(version_cmp 1.2.3 1.2.2)" == "1" ]] || die "version_cmp newer failed"
  [[ "$(version_cmp 1.2.3 1.2.3)" == "0" ]] || die "version_cmp equal failed"
  [[ "$(version_cmp 1.2.2 1.2.3)" == "-1" ]] || die "version_cmp older failed"
  [[ "$(version_cmp 1.2.3 none)" == "1" ]] || die "version_cmp none failed"
  [[ "$(normalize_url 'https://example.com/')" == "https://example.com" ]] || die "normalize_url failed"
  is_true yes || die "is_true true case failed"
  ! is_true no || die "is_true false case failed"
  [[ "$(github_repo_slug 'https://github.com/acme/example.git')" == "acme/example" ]] || die "github_repo_slug https failed"
  [[ "$(github_repo_slug 'git@github.com:acme/example.git')" == "acme/example" ]] || die "github_repo_slug ssh failed"
  status_file="$(mktemp)"
  TMP_DIRS+=("$status_file")
  print -r -- '{"sha":"0123456789012345678901234567890123456789","statuses":[{"context":"Vercel","state":"success","target_url":"https://vercel.com/acme/example/deploy"}]}' > "$status_file"
  [[ "$(vercel_status_target "$status_file" '0123456789012345678901234567890123456789' 'Vercel')" == "https://vercel.com/acme/example/deploy" ]] || die "vercel_status_target success failed"
  ! vercel_status_target "$status_file" 'ffffffffffffffffffffffffffffffffffffffff' 'Vercel' >/dev/null 2>&1 || die "vercel_status_target sha mismatch failed"
  print -r -- '{"sha":"0123456789012345678901234567890123456789","statuses":[{"context":"Vercel","state":"failure","target_url":"https://vercel.com/acme/example/deploy"}]}' > "$status_file"
  if vercel_status_target "$status_file" '0123456789012345678901234567890123456789' 'Vercel' >/dev/null 2>&1; then
    die "vercel_status_target failure state accepted"
  else
    [[ "$?" == "3" ]] || die "vercel_status_target failure state failed"
  fi
  ok "release helper self-test passed"
}

require_command node
require_command npm
require_command git
require_command tar
require_command diff

if is_true "${RELEASE_SELF_TEST:-0}"; then
  release_self_test
  exit 0
fi

if is_true "${VERIFY_DEPLOYMENT_ONLY:-0}"; then
  verify_deployment
  ok "deployment-only verification complete"
  exit 0
fi

cd "$ROOT"
assert_release_safety

log "ROOT = $ROOT"
log "Options: PUSH=$PUSH PUBLISH=$PUBLISH UPDATE_LOCKS=$UPDATE_LOCKS SKIP_TESTS=${SKIP_TESTS:-0} SKIP_E2E=${SKIP_E2E:-0} SKIP_FE_TEST=${SKIP_FE_TEST:-0} RUN_SCHEMA_GATES=$RUN_SCHEMA_GATES RUN_DB_SMOKE=$RUN_DB_SMOKE RUN_DB_CRUD=$RUN_DB_CRUD VERIFY_DEPLOYMENT=$VERIFY_DEPLOYMENT DEPLOY_STATUS_CONTEXT=$DEPLOY_STATUS_CONTEXT PREFLIGHT_ONLY=${PREFLIGHT_ONLY:-0}"

for repo in "${CHECK_REPOS[@]}"; do
  require_repo "$repo"
  delete_stale_locks "$repo"
  assert_main_branch "$repo"
  assert_clean "$repo"
done
ok "repo preflight clean (${CHECK_REPOS[*]})"

CT_LOCAL_VER="$(json_value "$ROOT/contracts/package.json" "p.version")"
CT_NPM_VER="$(npm view "$CT_NAME" version 2>/dev/null || echo "none")"
log "contracts local v$CT_LOCAL_VER / npm v$CT_NPM_VER"

cmp="$(version_cmp "$CT_LOCAL_VER" "$CT_NPM_VER")"
if [[ "$cmp" == "-1" ]]; then
  die "contracts local version $CT_LOCAL_VER is older than npm $CT_NPM_VER"
fi

if [[ "$cmp" == "0" && "$CT_NPM_VER" != "none" ]]; then
  if compare_published_contract_surface "$CT_NPM_VER"; then
    ok "contracts d.ts surface matches published npm v$CT_NPM_VER"
  else
    die "contracts dist differs from npm v$CT_NPM_VER but package version was not bumped"
  fi
fi

if is_true "${PREFLIGHT_ONLY:-0}"; then
  ok "preflight-only complete"
  exit 0
fi

if is_true "$PUSH" && [[ "$cmp" == "1" ]] && ! is_true "$PUBLISH"; then
  die "contracts v$CT_LOCAL_VER must be published before deployable repos are pushed"
fi

run_gates

if [[ "$cmp" == "1" ]]; then
  if is_true "$PUBLISH"; then
    run_in contracts npm publish --access public
    for attempt in {1..12}; do
      [[ "$(npm view "$CT_NAME" version 2>/dev/null)" == "$CT_LOCAL_VER" ]] && break
      warn "npm registry propagation wait $attempt/12"
      sleep 5
    done
    [[ "$(npm view "$CT_NAME" version)" == "$CT_LOCAL_VER" ]] || die "npm registry did not expose $CT_NAME@$CT_LOCAL_VER"
  else
    warn "contracts v$CT_LOCAL_VER is newer than npm; dry verification did not publish it"
  fi
else
  ok "contracts publish skipped; npm already has v$CT_LOCAL_VER"
fi

if is_true "$UPDATE_LOCKS"; then
  for repo in backend frontend; do
    refresh_contract_lock "$repo" "$CT_LOCAL_VER"
  done

  run_in backend npm run typecheck
  run_in frontend npm run typecheck

  for repo in backend frontend; do
    commit_lock_update_if_needed "$repo" "$CT_LOCAL_VER"
  done

  for repo in backend frontend; do
    [[ "$(lock_version "$repo")" == "$CT_LOCAL_VER" ]] || die "$repo package-lock contracts version mismatch"
    assert_clean "$repo"
  done
  ok "lockfile guard passed ($CT_NAME@$CT_LOCAL_VER)"
else
  warn "UPDATE_LOCKS=0 - dependency lock mutation skipped"
fi

for repo in contracts docs; do
  assert_clean "$repo"
done

if is_true "$PUSH"; then
  for repo in "${RELEASE_REPOS[@]}"; do
    push_repo "$repo"
  done
else
  warn "PUSH=0 - push skipped"
fi

if is_true "$VERIFY_DEPLOYMENT"; then
  verify_deployment
fi

ok "release complete"
print "Local run:"
print "  cd backend  && npm run dev"
print "  cd frontend && npm run dev"
