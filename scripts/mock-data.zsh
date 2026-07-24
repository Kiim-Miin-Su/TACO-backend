#!/usr/bin/env zsh
# [TBO-61 2026-07-24] mock-data 점검·소프트 딜리트 owner 진입점 — 워크스페이스 ./scripts/mock-data.zsh가 exec.
#  실행 예시(그대로 복사 — 대괄호는 zsh glob이라 쓰지 말 것):
#    ./scripts/mock-data.zsh check
#    ./scripts/mock-data.zsh check --table students
#    ./scripts/mock-data.zsh delete --suspected            # 계획만(쓰기 0)
#    ./scripts/mock-data.zsh delete --suspected --yes      # 적용(사전 Neon 스냅샷!)
#    ./scripts/mock-data.zsh delete --table students --ids 1,2 --yes
#  DB URL은 backend/.env.local(DOTENV_CONFIG_PATH로 재정의 가능)에서 읽는다.
#  삭제는 전부 soft delete — 복구는 deleted_at = NULL.

emulate -L zsh
setopt err_exit no_unset

if (( $# == 0 )); then
  sed -n '2,11p' "$0"
  exit 1
fi

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR/.."
DOTENV_CONFIG_PATH="${DOTENV_CONFIG_PATH:-.env.local}" npm run db:mock-data --silent -- "$@"
