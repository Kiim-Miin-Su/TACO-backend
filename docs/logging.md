# TACO 로깅 규약 (docs/logging.md)

> [TBO-58 P2 2026-07-24] 신설 — 코드 5곳(logging.interceptor·log-line·main.ts 등)이 참조하던 규약
> 문서의 실재화. 여기 없는 로그 형태는 규약 위반이다.

## 1. 카테고리 (단일 헬퍼 `logLine(category, payload)` — src/common/log-line.ts)

| 카테고리 | 발생 지점 | 내용 |
|---|---|---|
| `http` | LoggingInterceptor(전 요청) | `[HTTP] METHOD path status ms` — 계측 1줄 |
| `error` | AllExceptionsFilter | HttpException=4xx warn/5xx error, 비-HttpException=스택은 서버만 |
| `audit` | AuditService 콘솔 미러 | 권위 저장소는 DB `audit_log` — 콘솔은 미러 |
| `app` | 그 외 | 부팅·hydrate 등 |

- **개발**: 사람이 읽는 한 줄(`[category]` 접두사, grep 친화).
- **운영**: JSON 라인(`{"t":…,"category":…,"rid":…,…}`) — Vercel 콘솔 수집 전제.

## 2. requestId 상관관계 (rid — src/common/request-context.ts)

- 요청마다 `X-Request-Id` 발급(클라이언트 값 수용: `[A-Za-z0-9._-]{4,64}`) → 응답 헤더로 반환.
- `AsyncLocalStorage`로 전 구간 전파 — **파라미터 배관 금지**(미들웨어가 유일한 발급 지점).
- 부착 지점 2곳(중복 없음): 운영 JSON은 `logLine`이 `rid` 필드로, 개발 한 줄·도메인 로그는
  `RidConsoleLogger`가 문자열 끝 `rid=…`로 자동 첨부.
- FE(lib/api.ts)가 요청마다 rid를 생성해 보낸다 → 브라우저 `[TACO:api]` 콘솔과 서버 로그를
  같은 rid로 교차 대조(사용자 신고 → 서버 원인 즉시 매칭).

## 3. 도메인 command 로그 (성공/실패 1줄 규약)

형식: `action=<verb> <entity>=<id> actor=<uid> …키=값 result=<결과>` — **allowlist 키만**.

| Logger | 도메인 | 예 |
|---|---|---|
| `money` | payments·expenses·payouts(+원장) | `action=pay payout=3 actor=3 amount=180000 ledgerTx=12 result=paid` |
| `money` | payouts generate 진행(치명 갭 ②) | `action=generate.claim payout=3 session=41 result=linked` — 부분 실패 시 어디까지 갔는지 재구성 |
| `attendance` | 출결 upsert(+자동 전이) | `action=upsert session=41 student=2 status=attended autoHeld=1 result=created` |
| `counsel` | 상담 폼·회차 CRUD | `action=createRound form=5 round=9 roundNo=2 actor=4 result=created` |
| `analytics` | GraphQL 전 쿼리 파라미터 | `query=ceoDashboard from=2026-07-01 to=2026-07-31` — 잘못된 입력 vs 집계 버그 구분 |

- REST 분석(counsel funnel/correlation)은 쿼리스트링이 `[HTTP]` 로그에 이미 보이므로 별도 없음.
- 실패도 1줄(`result=conflict(cas)` 등) — **조용한 누락 금지**.

## 4. PII·비밀 (절대 규칙)

- 어떤 카테고리에도 **이름·전화·이메일·주소·RRN·상담 내용·토큰·비밀번호** 원문 금지 — id만.
- 이중 방어: `redactLogValue`(src/common/log-redaction.ts)가 키 패턴(email/phone/…name 등)과
  값 패턴(Bearer·이메일·**휴대전화 01x-####-####**)을 어느 깊이에서든 마스킹.
- URL 쿼리는 `safeUrlForLog`가 민감 키만 `[redacted]` — from/to 같은 기간 파라미터는 보인다(의도).
- `[MAIL:dev]`(무SMTP 로컬 한정): 이메일은 마스킹(`ab***@domain`), 링크/webId는 dev 흐름상 유지.
  production은 SMTP 미설정이면 부팅 차단 + 코드 분기 이중 방어라 이 로그 자체가 없다.

## 5. FE 전역 에러 (frontend)

- `app/error.tsx`/`app/global-error.tsx`: 렌더 오류 경계 — `[fe] route-error digest=…` 콘솔 기록
  (종전 렌더 오류 무기록 — 치명 갭 ③ 해소).
- `providers.tsx`: `unhandledrejection`/`error` 전역 리스너 — 메시지만 기록(PII·스택 원문 미전송).
- `[TACO:api]` 요청/응답 로그에 rid 포함 — §2와 교차 대조.

## 6. lint 게이트 (0/2 → 2/2 복구)

- BE: `npm run lint` = eslint flat config(`eslint.config.mjs`, typescript-eslint). 
- FE: `npm run lint` = `eslint .`(eslint-config-next flat 호환 — next lint 대화형 제거).
- 최초 1회 `npm install` 필요(devDependencies 신설).
