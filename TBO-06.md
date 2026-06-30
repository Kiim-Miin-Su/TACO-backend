# Backend — TBO-05 완료 / TBO-06 계획

작성일: 2026-06-30 (화) · 범위: NestStudio in-memory API. 상세 종합: `../docs/TODO.md`.

## ✅ TBO-05 완료 (시수 측정 · 페이 정산)

- **`modules/reports`** — 수업 보고서: 강사 제출(`submitted`) → 관리자 승인(`approved`)/반려(`rejected`).
  생성 시 검증: 세션 FK 존재 · 강사 일치 · `(session, student)` 중복 금지 · 과목 스냅샷.
- **`modules/payouts`** — 시수 측정 + 정산:
  - 적격 게이트(모두 충족): `status==='held'` ∧ 승인 보고서 ∧ 코스 FK 유효(시급 조인) ∧ `payoutId==null`(이중 계상 방지).
  - 페이 = Σ `round(durationMinutes/60 × course.hourlyRate)`.
  - `preview`(읽기) · `generate`(pending+세션 연결) · `confirm` · `adjust`(급여수정, 산정액 보존) · `reject`(반려+세션 회수) · `pay`(원장 출금 1줄).
- **카탈로그 단일 소스** — `courses`(10/11/12, hourlyRate)·`subjects`(1/2) 고정 id 시드 + `InMemoryDatabase.seed()`.
- **데모 mock 주입**(`PayoutsService.onModuleInit`) — 6월 중순 held+승인: 강사1 적격 3건(미정산)·강사2 지급완료 1건.
- **테스트** — `test/payouts.e2e-spec.ts`(13) + `test/payouts-integrity.e2e-spec.ts`(4) → **총 e2e 38 pass · 타입체크 0**.

## 🔜 TBO-06 (로그인 + 무결성·조인 검증)

- [ ] **인증·RBAC 가드** — JWT 검증 + RolesGuard. 보호: payouts(generate/confirm/adjust/reject/pay), reports(approve/reject), schedule `force`. `manager/admin/super_admin`만 승인·지급, `instructor`는 본인 리포트/세션만.
- [ ] **권한별 e2e** — 토큰 포함 200/403 매트릭스 회귀(기존 38 + 권한 케이스).
- [ ] **식별자 정합** — 스케줄 in-module `INSTRUCTORS(1,2)` ↔ `users` 시드(박지훈=6) 통합, `instructorId → users.id` 조인 일원화.
- [ ] **카탈로그 일원화** — 스케줄 in-module `COURSES` → 시드된 `courses` 참조로 단일화(현재 id만 정렬).
- [ ] **지급 스냅샷** — 정산서 `bank_account`·`payment_method`(ERD) 채우기.
- [ ] **영속화 준비** — in-memory → PostgreSQL(TypeORM) 이관 시 동일 게이트/조인 유지.

> 권한 매트릭스: `docs/SECURITY-review-2026-06-29.md`. 종합 계획: `../docs/TODO.md` TBO-06.
