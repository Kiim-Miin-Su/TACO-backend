# TACO API (backend)

학원(TN Academy) 백오피스 ERP의 NestJS 11 API. **독립 repo**로 운영하며, 운영 DB는
Neon PostgreSQL(TypeORM 커넥션 + 자체 collection store), 배포는 Vercel 서버리스입니다.

- **단일 진실원(SSOT)**: 모든 업무 판정(READ·command 전제)은 운영 DB 행 기준.
  메모리는 인스턴스별 read model(부팅 hydrate 미러)로만 사용합니다.
- **동시성 규약**: 돈·상태 전이는 `advisory lock → DB 재조회 → CAS(WHERE+RETURNING) →
  같은 tx 원장/audit` — 2-instance 경쟁 e2e(race/ssot)로 실증합니다.
- **스키마 권위**: versioned migration ledger(`schema_migrations`, expected 55).
  production 런타임 DDL 금지 — 신설 표는 owner가 migration을 선적용해야 하며(런북 §9),
  미적용 상태로 배포돼도 **부팅은 생존**하고 해당 표 기능만 fail-closed 됩니다(2026-07-24 원천 픽스).

## 실행

```bash
nvm use                         # Node 22.22.3
npm ci
npm run dev                     # http://localhost:3001/api (watch) · Swagger /docs
npm run build && npm start
```

- 환경변수: `.env.example` 참고. production 부팅 필수(fail-fast): `DATABASE_URL`,
  `JWT_SECRET`, `SMTP_HOST(+PORT/USER/PASS)`, `TRUST_PROXY`, `RRN_ENC_KEY(base64 32B)`.
- 선택: `NCP_SENS_*` 4종(휴대전화 OTP — 넣으면 가입 폼 인증 필수+마이페이지 SMS 재인증이
  코드 수정 없이 동시 활성), `WEB_ORIGIN`, `PROFILE_VERIFICATION_SALT`.
- ⚠ 비밀값(DB URL·JWT·SMTP·SENS 키)은 채팅·문서·로그 어디에도 기록하지 않습니다.

## 게이트 (커밋마다 그린)

```bash
npm run typecheck                    # TypeScript 0
npm run lint                         # ESLint 0
npm run test:e2e                     # 144 suites / 1,030 tests
npm run openapi                      # 160 paths / 226 operations / 133 schemas
npm run e2e:coverage                 # 라우트 커버리지 226/226
npm audit --omit=dev                 # production vulnerability 0
```

- DB 검증: `npm run db:verify-migrations`(ledger 55/55 대조) · `npm run db:integrity`(읽기 전용 무결성 센서) ·
  `npm run db:verify-schema-shape`(DBML/live shape) · `npm run db:verify-persistence-docs`(자산화 문서 drift).
- 마이그레이션: `npm run db:migrate:*` — dry-run 기본, `APPLY=1`로 실행(owner URL 전용).

## 구조

```
src/
├─ main.ts / api/index.ts   # 로컬 부트 / Vercel 서버리스 엔트리(콜드스타트 캐시)
├─ config/                  # production 부팅 가드 · OpenAPI 공개 라우트 단일 소스
├─ database/                # PostgresCollectionStore(hydrate/findActive/CAS) · UoW(lock) ·
│                           # migrations/*.migration.ts + scripts/migrate-*.ts (ledger)
└─ modules/                 # 도메인 모듈 (auth·users·students·parents·counsel·schedule·
                            # attendance·reports·payments·transactions·expenses·payouts·
                            # roadmaps·events·rooms·subjects·courses·graphql·audit·health …)
```

- 인증: JWT + HttpOnly 쿠키(refresh 회전), 가입은 이메일 OTP + (SENS 설정 시) 휴대전화 OTP를
  **가입 tx에서 일회 소비**. RRN은 AES-256-GCM 암호문만 저장(평문·로그 금지).
- 권한: 전역 default-auth(@Public만 예외) + @Roles + 서비스 owner/join 검증. 공개 라우트는
  `src/config/openapi.ts`의 allowlist가 OpenAPI·비인증 e2e sweep과 공유되는 단일 소스입니다.
- 감사: 업무 변경은 도메인 tx와 같은 tx에서 append-only `audit_log` 기록(PII 마스킹).

## 문서

전체 설계·운영 문서는 형제 repo `docs/`가 입구입니다 — [`docs/README.md`](../docs/README.md):
FABLE(운영 계약·현재 판정) · TODO(스프린트) · RUNBOOK(백업·모니터링·owner 절차) ·
erd.dbml/DATA_DICTIONARY(스키마) · TBO-* (스프린트별 상세 회고).
라이브 Swagger는 배포 `/docs`, 정적 스펙은 `openapi.json`(빌드 타임 생성·커밋)입니다.
production은 Swagger를 기본 404로 차단하며 `openapi.json`과 `docs/api/openapi.yaml`의 의미 동일성을
release gate가 검사합니다.
