#!/usr/bin/env zsh
# TACO multi-repository release runner.
#
# Canonical tracked source for the workspace-level ./scripts/release.zsh wrapper.
#
# Default release:
#   1. require clean main branches for contracts/backend/frontend/docs
#      (docs is checked but never pushed — it has no remote by design)
#   2. compare local contracts against the npm package
#   3. run gates: contracts build → **stage local contracts into consumers** → backend
#      lint/typecheck/build/e2e(+route coverage) → schema/doc gates → frontend
#      lint/typecheck/vitest/build → optional DB gates
#   4. publish contracts only when its version is newer
#   5. reinstall the **published** contracts tarball, re-typecheck, pathspec-commit the locks
#   6. verify the migration ledger when a DB is reachable, then push contracts/backend/frontend
#
# [TBO-79 K1 2026-07-30] 이 스크립트가 HEAD의 게이트와 어긋나 있었다. 고친 것:
#   · `npm run lint`(BE·FE)가 **없었다** — 실제로 HEAD에서 backend lint가 깨진 채 release가
#     초록이었다(78C4-1 잔여 unused import). CODEX §6이 필수로 규정한 게이트다.
#   · route coverage(`e2e-route-coverage`)가 **없었다** — 라우트를 추가하고 e2e를 안 써도 통과.
#     이제 e2e에 `E2E_ROUTE_LOG`를 물려 실행하고 그 로그로 미커버 0을 판정한다.
#   · DB 검증기(migration 원장·schema shape·integrity·persistence docs)가 release 경로에
#     **전무했다** → O2 마이그레이션 미적용 상태로도 초록이 떴다. "release 초록 ≠ 프로덕션
#     무결성"의 기계적 원인이었다. 이제 DB가 닿으면 push 전에 원장을 확인하고 fail-closed다.
#   · `contracts:stage`가 node_modules의 버전을 덮어써서 이후 `npm install`이 무동작이 됐다
#     → publish 뒤 검증이 **실제 배포 tarball로 돌지 않았다**. 이제 스테이징 표식을 남기고
#     `refresh_contract_lock`이 그 디렉터리를 지운 뒤 재설치한다.
#   · `delete_stale_locks`가 `-mmin +5`(나이)로 판정해 방금 생긴 고아 락을 남겼다 →
#     preflight는 통과하고 commit에서 죽었다. 이제 **점유 프로세스**로 판정한다.
#
# [2026-08-19] "자동 배포가 안 된다" 실측 원인 3건을 고쳤다:
#   · preflight가 **untracked 파일** 때문에 죽었다 — docs에 놓아둔 외부 자료 PDF/PPTX 2개가
#     `docs working tree is not clean`을 만들어 push 0건으로 중단됐다. release의 커밋은 전부
#     pathspec이고 push는 커밋만 옮기므로 untracked는 산출물에 섞일 수 없다 → tracked 변경만
#     차단하고 untracked는 목록과 함께 경고 후 진행한다(STRICT_CLEAN=1로 종전 동작).
#   · push가 non-fast-forward로 거부될 상황을 **게이트 30분 뒤에야** 알 수 있었다 →
#     preflight에서 origin을 fetch해 diverge/behind를 20초 안에 판정한다(assert_pushable).
#   · push까지 초록이어도 Vercel이 실제로 그 SHA를 배포했는지는 확인하지 않았다 →
#     VERIFY_DEPLOYMENT 기본값을 PUSH에 연동한다. 비공개 repo + GITHUB_TOKEN 부재로 배포
#     확인이 불가능한 경우는 preflight에서 미리 안내와 함께 중단한다(마지막 단계 404 방지).
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
#   SKIP_LINT=1 ./scripts/release.zsh
#     Skip backend/frontend lint (escape hatch only — lint is a required gate per CODEX §6).
#   SKIP_ROUTE_COVERAGE=1 ./scripts/release.zsh
#     Skip the uncovered-route gate (only meaningful together with SKIP_E2E=1).
#   RUN_DB_VERIFY=1 ./scripts/release.zsh
#     Run the read-only DB verifiers (migration ledger, schema shape, integrity,
#     persistence docs, payout/request invariants). Implied by RUN_DB_SMOKE=1.
#   ALLOW_UNAPPLIED_MIGRATIONS=1 ./scripts/release.zsh
#     Push even though the reachable DB is missing ledger migrations. Logs loudly.
#     Only for a deliberate code-first deploy where the owner applies migrations after.
#   STRICT_CLEAN=1 ./scripts/release.zsh
#     untracked 파일도 preflight 실패로 취급(2026-08-19 이전의 동작). 기본은 tracked 변경만
#     차단한다 — untracked 자료 파일이 저장소에 놓여 있어도 배포는 진행된다.
#   VERIFY_DEPLOYMENT=0 ./scripts/release.zsh
#     push 후 Vercel 배포 identity/health 확인을 끈다(기본은 PUSH=1이면 함께 켜짐).

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
# [TBO-79 K1] 읽기 전용 DB 검증기 — smoke를 켜면 함께 켠다(smoke가 쓰기이므로 그 전에 확인해야 한다).
RUN_DB_VERIFY="${RUN_DB_VERIFY:-$RUN_DB_SMOKE}"
# [2026-08-19] 기본값을 PUSH에 연동 — 종전 기본 0은 "release 초록 = push까지"였고 Vercel이 실제로
#  그 SHA를 배포했는지는 아무도 확인하지 않았다("자동 배포 안 됨"이 사후에야 발견되는 구조).
#  push하는 실행은 기본으로 배포 identity + health/db/CORS까지 확인한다. 끄려면 VERIFY_DEPLOYMENT=0.
VERIFY_DEPLOYMENT="${VERIFY_DEPLOYMENT:-$PUSH}"
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

select_supported_node() {
  local major candidate
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if (( major >= 22 && major < 25 )); then
    ok "Node $(node -v) is within the supported release range (22-24)"
    return
  fi

  # Keep the one-command release path usable on developer machines whose global Node moved
  # ahead of the Vercel-supported majors. Prefer an installed NVM 24, then 22.
  for candidate in "$HOME"/.nvm/versions/node/v24*/bin/node(N) "$HOME"/.nvm/versions/node/v22*/bin/node(N); do
    export PATH="${candidate:h}:$PATH"
    rehash
    major="$(node -p 'Number(process.versions.node.split(".")[0])')"
    if (( major >= 22 && major < 25 )); then
      ok "release runtime switched to $(node -v) (${candidate:h})"
      return
    fi
  done

  die "Node $(node -v)는 지원 범위(>=22 <25) 밖입니다. Node 24 또는 22를 설치한 뒤 다시 실행하세요."
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

# [2026-08-19] tracked 변경만 차단한다. untracked 파일이 preflight를 죽여 배포 전체를 막았다
#  (실측: docs의 외부 자료 PDF/PPTX 2개 → die → push 0건). release가 만드는 커밋은 전부
#  pathspec(-- package.json package-lock.json)이고 push는 커밋만 옮기므로, untracked 파일은
#  어떤 release 산출물에도 섞일 수 없다. 목록을 경고로 남겨 은폐는 하지 않는다. STRICT_CLEAN=1
#  이면 종전처럼 untracked도 차단한다.
typeset -gA RELEASE_UNTRACKED_WARNED
assert_clean() {
  local repo="$1"
  local tracked untracked line
  git -C "$ROOT/$repo" update-index -q --refresh 2>/dev/null || true
  tracked="$(git -C "$ROOT/$repo" status --porcelain --untracked-files=no)"
  [[ -z "$tracked" ]] || die "$repo working tree has tracked changes. Commit or isolate them first.\n$tracked"
  untracked="$(git -C "$ROOT/$repo" ls-files --others --exclude-standard)"
  [[ -n "$untracked" ]] || return 0
  if is_true "${STRICT_CLEAN:-0}"; then
    die "$repo has untracked files (STRICT_CLEAN=1).\n$untracked"
  fi
  if [[ -z "${RELEASE_UNTRACKED_WARNED[$repo]:-}" ]]; then
    RELEASE_UNTRACKED_WARNED[$repo]=1
    warn "$repo: untracked 파일은 커밋/푸시에 포함되지 않으므로 무시하고 진행합니다 —"
    print -r -- "$untracked" | while IFS= read -r line; do warn "  ?? $line"; done
    warn "  격리하려면 workspace의 _incoming/ 등으로 옮기세요(종전 엄격 동작: STRICT_CLEAN=1)"
  fi
}

assert_main_branch() {
  local repo="$1"
  local branch
  branch="$(repo_branch "$repo")"
  [[ "$branch" == "$MAIN_BRANCH" ]] || die "$repo branch=$branch, expected=$MAIN_BRANCH"
}

# [2026-08-19] push 가능성 preflight — 게이트 30분을 돌린 뒤 push가 non-fast-forward로 거부되면
#  락 사고와 정확히 같은 낭비다(막힐 거라면 20초 안에 막혀야 한다). origin을 fetch해 diverge를
#  미리 판정한다. fetch 실패(오프라인·자격증명)는 위반이 아니라 정보 부재 — 원장 판정과 같은
#  원칙으로 경고 후 진행한다.
assert_pushable() {
  local repo="$1"
  local branch ahead behind
  branch="$(repo_branch "$repo")"
  if ! git -C "$ROOT/$repo" fetch origin "$branch" --quiet 2>/dev/null; then
    warn "$repo: origin fetch 실패 — push 가능 여부를 미리 확인하지 못했습니다(오프라인/자격증명?)"
    return 0
  fi
  behind="$(git -C "$ROOT/$repo" rev-list --count "HEAD..origin/$branch" 2>/dev/null || print 0)"
  ahead="$(git -C "$ROOT/$repo" rev-list --count "origin/$branch..HEAD" 2>/dev/null || print 0)"
  if (( behind > 0 )); then
    die "$repo: origin/$branch 에 로컬에 없는 커밋 ${behind}개 — push가 거부됩니다.\n  git -C $repo pull --rebase origin $branch 로 정리한 뒤 다시 실행하세요."
  fi
  if (( ahead > 0 )); then
    ok "$repo: push 예정 커밋 ${ahead}개 (origin/$branch 기준 fast-forward)"
  else
    ok "$repo: origin/$branch 와 동일 — push할 커밋 없음"
  fi
}

# [2026-08-19] 배포 확인 접근성 preflight — VERIFY_DEPLOYMENT는 GitHub commit status API로 Vercel
#  배포 identity를 판정하는데, 비공개 repo + GITHUB_TOKEN 부재면 **마지막 단계**(HTTP 404)에서야
#  죽었다. repo 메타를 먼저 조회해 20초 안에 해결 방법과 함께 중단한다.
preflight_deployment_status_access() {
  is_true "$VERIFY_DEPLOYMENT" || return 0
  is_true "$PUSH" || return 0
  require_command curl
  local repo remote slug code
  local -a auth_headers
  auth_headers=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && auth_headers=(-H "Authorization: Bearer $GITHUB_TOKEN")
  for repo in backend frontend; do
    remote="$(git -C "$ROOT/$repo" remote get-url origin 2>/dev/null)" || continue
    slug="$(github_repo_slug "$remote")" || continue
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
      -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
      "${auth_headers[@]}" --connect-timeout 10 --max-time 20 \
      "$(normalize_url "$GITHUB_API_URL")/repos/$slug" || true)"
    case "$code" in
      200) ok "$repo: GitHub 상태 API 접근 확인($slug)" ;;
      404)
        die "$repo: $slug 조회 불가(HTTP 404) — 비공개 repo는 GITHUB_TOKEN 없이 Vercel 배포 상태를 확인할 수 없습니다.\n  export GITHUB_TOKEN=<repo 읽기 권한 토큰> 후 재실행하거나,\n  VERIFY_DEPLOYMENT=0 ./scripts/release.zsh 로 확인 없이 push만 할 수 있습니다(비권장)." ;;
      401|403)
        die "$repo: GitHub API 인증/한도 문제(HTTP $code) — GITHUB_TOKEN 값을 확인하세요." ;;
      000)
        warn "$repo: GitHub API에 연결하지 못했습니다 — 배포 확인 단계가 나중에 실패할 수 있습니다" ;;
      *)
        warn "$repo: GitHub API 사전 확인 예상 밖 응답(HTTP $code) — 배포 확인 단계에서 재시도합니다" ;;
    esac
  done
}

# [TBO-79 K1 2026-07-30] 락 판정을 **나이 → 점유 프로세스**로 바꾼다.
#  종전 규칙은 `-mmin +5`, 즉 "5분 이내 락은 살아 있는 git 프로세스의 것"이라는 가정이었다.
#  그런데 에이전트가 FUSE 마운트에서 git을 돌려 남긴 고아 락은 정확히 그 창 안에 있다
#  (마운트가 unlink를 거부해서 git 자신이 지우지 못한다). 결과: preflight는 통과하고
#  한참 뒤 `commit_lock_update_if_needed`에서 `Unable to create ... index.lock`으로 죽는다.
#  2026-07-30 대표 릴리스가 정확히 그 경로로 중단됐다.
#  이제 `lsof`로 **실제 점유자**를 본다 — 점유자가 있으면 나이와 무관하게 남기고, 없으면
#  나이와 무관하게 지운다. 이게 원래 의도("살아 있는 git을 깨지 말라")를 정확히 구현한다.
#  `lsof`가 없는 환경에서는 정보가 없으므로 보수적으로 종전 나이 heuristic으로 후퇴한다.
delete_stale_locks() {
  local repo="$1"
  local lock holder
  [[ -d "$ROOT/$repo/.git" ]] || return 0
  is_true "${CLEAN_GIT_LOCKS:-1}" || return 0

  local -a locks
  locks=(${(f)"$(find "$ROOT/$repo/.git" -maxdepth 4 -name '*.lock' 2>/dev/null)"})
  for lock in "${locks[@]}"; do
    [[ -n "$lock" && -e "$lock" ]] || continue
    if (( $+commands[lsof] )); then
      # macOS/Codex의 Virtualization file provider가 stale lock을 read-only(`ar`)로 열어 둘 수 있다.
      # 단순 `lsof -t`는 이 reader도 Git owner로 오인해 0-byte index.lock을 영구 보존했고,
      # 실제 `git add`가 막혔다. lock 소유권은 write/update access(`aw`/`au`)만 인정한다.
      # `lsof` access 필드: r=read, w=write, u=read/write.
      if lsof -F a -- "$lock" 2>/dev/null | grep -Eq '^a[wu]$'; then
        holder="$(lsof -t -- "$lock" 2>/dev/null | tr '\n' ' ' || true)"
        warn "$repo: ${lock:t} 은 쓰기 프로세스(pid ${holder% })가 점유 — 건드리지 않는다"
        continue
      fi
      if lsof -t -- "$lock" >/dev/null 2>&1; then
        warn "$repo: ${lock:t} 의 read-only file-provider handle은 Git 점유가 아니므로 stale 정리합니다"
      fi
      if rm -f -- "$lock" 2>/dev/null; then
        ok "$repo: 고아 git 락 제거 ${lock:t}"
      else
        warn "$repo: ${lock:t} 제거 실패(권한/마운트) — 수동 정리가 필요합니다"
      fi
    else
      find "$lock" -mmin +5 -delete 2>/dev/null || true
    fi
  done

  # 같은 부류의 잔여물 — FUSE에서 객체를 쓰면 `.git/objects/**/tmp_obj_*`가 남는다(unlink 거부).
  #  게이트를 막지는 않지만 `git fsck`가 garbage로 보고하고 계속 누적된다. 나이로 충분하다
  #  (쓰는 중인 임시 객체는 방금 만들어진 것뿐이다).
  find "$ROOT/$repo/.git/objects" -name 'tmp_obj_*' -mmin +5 -delete 2>/dev/null || true
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
  # [TBO-80 80B·80C] 정책 선언·코호트 SSOT 정적 게이트 — TBO-79 C6·A4의 기계화.
  #  종전엔 209 라우트 전수 선언·"사본 금지" 규약이 수동 확인이었다(FC-1 재발 방어 장치 없음).
  run_in backend npm run verify:route-policies
  run_in backend npm run verify:cohort-ssot
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
  if ! is_true "$RUN_DB_SMOKE" && ! is_true "$RUN_DB_CRUD" && ! is_true "$RUN_DB_VERIFY" \
     && ! is_true "${RUN_DB_CLEANUP:-0}"; then
    return 0
  fi

  require_db_config
  run_backend_with_db_env npm run db:check

  # [TBO-79 K1] 읽기 전용 검증기 — 종전엔 release 경로에 **하나도 없었다**. 그래서 마이그레이션
  #  미적용·shape 드리프트·무결성 위반이 있어도 release는 초록이었다. 쓰기(smoke/crud)보다 **먼저**
  #  돌려서, 깨진 스키마 위에 데이터를 쓰지 않는다.
  if is_true "$RUN_DB_VERIFY"; then
    run_backend_with_db_env npm run db:verify-migrations
    run_backend_with_db_env npm run db:verify-schema-shape
    run_backend_with_db_env npm run db:verify-persistence-docs
    run_backend_with_db_env npm run db:integrity
    run_backend_with_db_env npm run db:verify:enrollment-payout-integrity
    run_backend_with_db_env npm run db:verify:schedule-request-integrity
    run_backend_with_db_env npm run db:verify:schedule-request-batch
    ok "DB 읽기 전용 검증기 통과(원장·shape·영속화 문서·무결성)"
  fi

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

# [TBO-79 K1·K2] 마이그레이션 원장 확인. 종전엔 release 경로에 이 확인이 **전혀 없었고**, 그래서
#  "release 초록"이 "프로덕션 스키마가 코드와 맞다"를 전혀 보장하지 않았다.
#
#  판정을 3갈래로 나눈다 — 이게 핵심이다. `db:verify-migrations`는 **연결 실패와 원장 불일치를
#  똑같이 exit 1로** 낸다. 그래서 종료코드만 보고 die하면 "Neon에 못 닿는 머신에서는 배포 불가"가
#  된다(실측: 컨테이너는 Neon 네트워크가 막혀 connection timeout이 난다). 불일치는 증거지만
#  연결 실패는 **증거가 아니라 정보 부재**다. 부재를 위반으로 취급하면 게이트가 반대 방향으로
#  거짓말을 한다.
#   ① 원장 일치        → 통과
#   ② 원장 불일치      → die (ALLOW_UNAPPLIED_MIGRATIONS=1로만 우회)
#   ③ 연결 실패        → warn (무엇을 검증하지 못했는지 명시하고 진행)
#
#  [K2] **preflight에서 돌린다.** push 직전에만 확인하면 게이트를 30분 넘게 돌린 뒤 마지막에
#  막히고, 재실행에 또 30분이 든다 — 락 실패와 정확히 같은 낭비다. 막힐 거라면 20초 안에 막혀야
#  한다. 결과는 MIGRATION_LEDGER_VERDICT에 남겨 push 시점에 한 줄로 요약한다.
MIGRATION_LEDGER_VERDICT="unverified"

classify_migration_ledger() {
  node -e "
    let s='';
    process.stdin.on('data', (d) => { s += d; }).on('end', () => {
      const at = s.indexOf('{');
      if (at < 0) return console.log('unreachable\tJSON 출력 없음');
      let j;
      try { j = JSON.parse(s.slice(at)); } catch { return console.log('unreachable\tJSON 파싱 실패'); }
      if (j.ok === true) return console.log('ok\t적용 ' + (j.expectedCount ?? '?') + '/' + (j.expectedCount ?? '?'));
      if (j.error) return console.log('unreachable\t' + j.error);
      const missing = (j.missing ?? []).length, unexpected = (j.unexpected ?? []).length;
      if (missing || unexpected) {
        return console.log('drift\tmissing ' + missing + '건' + (missing ? ' → ' + j.missing.join(', ') : '')
          + (unexpected ? ' / unexpected ' + unexpected + '건 → ' + j.unexpected.join(', ') : ''));
      }
      console.log('unreachable\t판정 불가(ok=false 인데 missing·error 모두 비어 있음)');
    });
  "
}

verify_migration_ledger() {
  local out verdict kind detail
  log "backend: verify migration ledger (preflight — 막힐 거라면 게이트 전에 막힌다)"
  out="$(cd "$ROOT/backend" && DOTENV_CONFIG_PATH="$DB_ENV_FILE" npm run --silent db:verify-migrations 2>&1 || true)"
  verdict="$(printf '%s' "$out" | classify_migration_ledger)"
  kind="${verdict%%$'\t'*}"
  detail="${verdict#*$'\t'}"
  case "$kind" in
    ok)
      MIGRATION_LEDGER_VERDICT="ok"
      ok "migration 원장 일치($detail) — 배포 대상 코드와 프로덕션 스키마가 맞다" ;;
    drift)
      if is_true "${ALLOW_UNAPPLIED_MIGRATIONS:-0}"; then
        MIGRATION_LEDGER_VERDICT="bypassed"
        warn "⚠ 원장 불일치인데 ALLOW_UNAPPLIED_MIGRATIONS=1로 진행합니다: $detail"
        warn "  배포 후 반드시 dry-run → APPLY → readback을 수행하세요(사전 Neon 스냅샷 필수)."
      else
        die "미적용 마이그레이션으로 중단합니다: $detail\n  적용하거나(권장), 코드-선 배포를 의도한다면 다음처럼 다시 실행하세요:\n    ALLOW_UNAPPLIED_MIGRATIONS=1 ./scripts/release.zsh"
      fi ;;
    *)
      MIGRATION_LEDGER_VERDICT="unverified"
      warn "migration 원장을 확인하지 못했습니다($detail) —"
      warn "  이 실행의 초록은 **프로덕션 스키마 정합을 포함하지 않습니다**." ;;
  esac
}

preflight_migration_ledger() {
  is_true "$PUSH" || return 0
  if is_true "$RUN_DB_VERIFY"; then
    MIGRATION_LEDGER_VERDICT="gates"
    log "migration 원장은 DB 게이트(RUN_DB_VERIFY=1)에서 확인한다"
    return 0
  fi
  if [[ -n "${DATABASE_URL_UNPOOLED:-}" || -n "${DATABASE_URL:-}" || -n "${POSTGRES_URL_NON_POOLING:-}" || -n "${POSTGRES_URL:-}" ]] || db_env_file_exists; then
    verify_migration_ledger
  else
    MIGRATION_LEDGER_VERDICT="unverified"
    warn "DB URL·backend/$DB_ENV_FILE 이 없어 migration 원장을 확인하지 못했습니다 —"
    warn "  이 실행의 초록은 **프로덕션 스키마 정합을 포함하지 않습니다**(RUN_DB_VERIFY=1로 확인)."
  fi
}

run_gates() {
  if is_true "${SKIP_TESTS:-0}"; then
    warn "SKIP_TESTS=1 - all code/test/schema gates skipped"
    return 0
  fi

  run_in contracts npm run build
  # [TBO-79 J1] 게이트는 **배포될 contracts**로 돌아야 한다. 종전엔 여기서 빌드만 하고 실제 설치는
  #  publish 뒤 refresh_contract_lock에서 했다 → 게이트가 npm의 **구버전**을 검사했다.
  #  코드가 새 export를 쓰기 시작하면 닭-달걀이 된다(게이트 통과에 publish가 필요하고 그 반대도).
  #  2026-07-30에 실제로 터졌다: typecheck 24 errors, 전부 "has no exported member".
  #  publish를 대체하지 않는다 — 아래 refresh_contract_lock이 진짜 tarball로 다시 설치하고
  #  게이트를 재실행한다. 이건 그 앞단의 정합 확보다.
  run_in backend npm run contracts:stage
  run_in backend npm run verify:runtime-data
  run_in backend npm run typecheck
  # [TBO-79 K1] lint가 release 경로에 **없었다**. 이론적 구멍이 아니다 — 2026-07-30에 backend
  #  lint가 깨진 채(78C4-1 잔여 unused import) release가 초록이었다. CODEX §6은 lint를 필수
  #  게이트로 규정한다. typecheck는 lint를 대체하지 않는다(미사용 import·hook 규칙은 tsc가 통과시킨다).
  if is_true "${SKIP_LINT:-0}"; then
    warn "SKIP_LINT=1 - backend/frontend lint skipped (CODEX §6 필수 게이트를 건너뛴다)"
  else
    run_in backend npm run lint
  fi
  run_in backend npm run build

  # [TBO-79 K1] route coverage용 계측 로그. e2e가 append하므로 **실행 전에 지운다** — 지난 실행의
  #  로그가 남아 있으면 지금 미커버인 라우트를 커버된 것으로 보이게 해서 게이트가 조용히 무력화된다.
  local route_log="$ROOT/_logs/e2e-routes-$(date +%Y%m%d-%H%M%S).log"
  mkdir -p "$ROOT/_logs"
  rm -f "$route_log"

  if is_true "${SKIP_E2E:-0}"; then
    warn "SKIP_E2E=1 - backend e2e skipped"
  else
    # [2026-07-16] e2e 출력을 로그 파일로 보존 — 실패 시 어느 스위트/테스트인지 사후 추적 가능
    #  (2026-07-16 새벽 실패가 스크롤백 유실로 재현 불가였던 문제의 재발 방지). tee라 화면 출력 동일.
    local e2e_log="$ROOT/_logs/e2e-$(date +%Y%m%d-%H%M%S).log"
    # [TBO-59 2026-07-24] 셸에 DB URL이 export 돼 있어도 기본 e2e는 hermetic(in-memory)이다 —
    #  jest-e2e.setup.ts가 RUN_*_E2E opt-in 없으면 DB URL을 전량 제거(운영 Neon 오염 원천 차단).
    if [[ -n "${DATABASE_URL:-}" || -n "${POSTGRES_URL:-}" || -n "${POSTGRES_PRISMA_URL:-}" ]]; then
      warn "셸에 DB URL이 export 되어 있음 — 기본 e2e는 hermetic 가드로 무시합니다(jest-e2e.setup.ts)"
    fi
    log "backend: npm run test:e2e (log: $e2e_log)"
    # [2026-07-16 수정] test:e2e는 이미 --runInBand(직렬) — maxWorkers 병기 시 jest가 거부한다
    #  (실측: "Both --runInBand and --maxWorkers were specified"). 플레이크 완화는 retryTimes(1)가 담당.
    if ! ( setopt pipe_fail; cd "$ROOT/backend" && E2E_ROUTE_LOG="$route_log" npm run test:e2e -- --silent 2>&1 | tee "$e2e_log" ); then
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
      if ! ( setopt pipe_fail; cd "$ROOT/backend" && E2E_ROUTE_LOG="$route_log" npm run test:e2e -- --silent "${failed_suites[@]}" 2>&1 | tee "$rerun_log" ); then
        warn "backend e2e FAILED (재실행도 실패 = 실제 회귀) — 로그: $e2e_log / $rerun_log"
        grep -E "^FAIL|✕" "$rerun_log" | head -20 || true
        return 1
      fi
      ok "재실행 green — 1차 실패는 스톨-플레이크로 판정(두 로그 보존: $e2e_log)"
    fi
  fi

  if is_true "$RUN_SCHEMA_GATES"; then
    run_schema_gates
  fi

  # [TBO-79 K1] 미커버 라우트 0 게이트가 release 경로에 **없었다** — 라우트를 추가하고 e2e를 한 줄도
  #  안 써도 통과했다. CODEX §6은 "엔드포인트는 e2e 없이 존재할 수 없다"의 기계 게이트로 규정한다.
  #  openapi 재생성(run_schema_gates) **뒤에** 돌려야 방금 확정된 스펙과 대조된다.
  #  판정: 미기록 = 미커버 · 401만 기록 = 가드에서만 튕김(본 로직 미실행) → 미커버.
  if is_true "${SKIP_ROUTE_COVERAGE:-0}"; then
    warn "SKIP_ROUTE_COVERAGE=1 - 미커버 라우트 게이트 건너뜀"
  elif is_true "${SKIP_E2E:-0}"; then
    warn "SKIP_E2E=1 이므로 라우트 계측 로그가 없어 미커버 게이트를 건너뜀(커버리지 미검증)"
  elif [[ ! -s "$route_log" ]]; then
    die "라우트 계측 로그가 비어 있습니다($route_log) — setup-app 계측이 깨졌는지 확인하세요"
  else
    log "backend: route coverage (log: $route_log)"
    ( cd "$ROOT/backend" && node dist/scripts/e2e-route-coverage.js "$route_log" openapi.json )
    ok "미커버 라우트 0"
  fi

  if ! is_true "$RUN_SCHEMA_GATES"; then
    warn "RUN_SCHEMA_GATES=0 - Swagger and DBML gates skipped"
  fi

  run_in frontend npm run typecheck
  if ! is_true "${SKIP_LINT:-0}"; then
    run_in frontend npm run lint
  fi
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
  local pkg_dir="$ROOT/$repo/node_modules/$CT_NAME"

  # [TBO-79 K1] run_gates의 `contracts:stage`가 이 디렉터리를 로컬 빌드로 덮어쓰고 package.json의
  #  version까지 바꿔놓는다. 그 상태로 `npm install <pkg>@<ver>`를 하면 npm은 "이미 그 버전"이라
  #  판단해 **아무것도 하지 않는다** → 이 단계의 목적(진짜 tarball로 재설치해 검증)이 조용히
  #  무력화된다. 표식이 있으면 지우고 설치해서 npm이 반드시 레지스트리에서 받아오게 한다.
  if [[ -e "$pkg_dir/.taco-staged-from-local" ]]; then
    log "$repo: 스테이징된 로컬 사본 제거 후 npm에서 재설치한다(표식 발견)"
    rm -rf "$pkg_dir"
  fi
  run_in "$repo" npm install "$CT_NAME@$expected" --save-exact=false

  local installed
  installed="$(cd "$ROOT/$repo" && node -p "require('./node_modules/$CT_NAME/package.json').version")"
  [[ "$installed" == "$expected" ]] || die "$repo installed $CT_NAME@$installed, expected $expected"
  # 버전 문자열만 보면 스테이징 사본과 구별되지 않는다 — 표식이 사라졌는지도 함께 확인한다.
  [[ ! -e "$pkg_dir/.taco-staged-from-local" ]] \
    || die "$repo $CT_NAME 이 여전히 로컬 사본입니다(표식 잔존) — npm 설치가 적용되지 않았습니다"
  ok "$repo node_modules $CT_NAME@$installed (npm tarball)"
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
  die "$repo Vercel deployment did not succeed for commit $expected_sha\n  Vercel 프로젝트가 이 GitHub repo에 연결돼 있는지(Settings → Git), Production Branch가 $MAIN_BRANCH 인지,\n  Ignored Build Step이 이 커밋을 걸러내지 않았는지 확인하세요. 연동이 꺼져 있으면 push해도 배포는 시작되지 않습니다."
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
select_supported_node
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

# [2026-08-19] push·배포확인이 "가능한지"를 여기서 판정 — 막힐 거라면 게이트 전에 막힌다.
if is_true "$PUSH"; then
  for repo in "${RELEASE_REPOS[@]}"; do
    assert_pushable "$repo"
  done
fi
preflight_deployment_status_access

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

# [TBO-79 K2] push 예정이면 원장을 **여기서** 본다 — 막힐 거라면 게이트 30분 전에 막혀야 한다.
preflight_migration_ledger

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

  # [TBO-79 K1] 커밋 **직전**에 락을 다시 쓸어낸다. preflight의 스윕은 게이트 전이라, 그 사이에
  #  (다른 도구·에이전트가) 남긴 고아 락이 여기서 `Unable to create ... index.lock`으로 터진다 —
  #  게이트를 30분 넘게 돌린 뒤 마지막 단계에서 죽는 게 정확히 2026-07-30 실측 경로였다.
  for repo in backend frontend; do
    delete_stale_locks "$repo"
  done

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

# push 시점 요약 — 실제 판정은 preflight에서 이미 끝났다(아래 §preflight 참조).
if is_true "$PUSH"; then
  case "$MIGRATION_LEDGER_VERDICT" in
    ok)          ok "migration 원장 확인됨(preflight) — 배포 대상 코드와 프로덕션 스키마가 맞다" ;;
    bypassed)    warn "⚠ 원장 불일치를 ALLOW_UNAPPLIED_MIGRATIONS=1로 우회한 채 push합니다" ;;
    gates)       ok "migration 원장은 DB 게이트에서 확인했다" ;;
    unverified)  warn "migration 원장 미확인 상태로 push합니다 — 이 초록은 프로덕션 스키마 정합을 포함하지 않습니다" ;;
  esac
fi

if is_true "$PUSH"; then
  for repo in "${RELEASE_REPOS[@]}"; do
    delete_stale_locks "$repo"
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
