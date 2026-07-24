#!/usr/bin/env zsh
# [TBO-61 2026-07-24] mock-data 점검·소프트 딜리트 owner 진입점 — 워크스페이스 ./scripts/mock-data.zsh가 exec.
#  사용: ./scripts/mock-data.zsh check [--table t]
#       ./scripts/mock-data.zsh delete --suspected [--table t] [--yes]
#       ./scripts/mock-data.zsh delete --table students --ids 1,2 [--yes]
#  DB URL은 backend/.env.local(DOTENV_CONFIG_PATH로 재정의 가능)에서 읽는다. 적용(--yes) 전
#  Neon 브랜치 스냅샷은 상시 규약(RUNBOOK §3) — 삭제는 전부 soft delete, 복구는 deleted_at=NULL.

emulate -L zsh
setopt err_exit no_unset

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR/.."
DOTENV_CONFIG_PATH="${DOTENV_CONFIG_PATH:-.env.local}" npm run db:mock-data --silent -- "$@"
