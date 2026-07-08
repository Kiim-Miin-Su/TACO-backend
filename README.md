# TACO API (backend)

NestJS 기반 TACO ERP API. **독립 repo**로 운영합니다. 우선 in-memory DB로 시작하고, 추후 PostgreSQL(TypeORM)로 교체합니다.

## 실행

```bash
npm install
npm run dev        # http://localhost:3001/api (watch)
npm run build && npm start
```

- 환경변수: `PORT`(기본 3001), `WEB_ORIGIN`(CORS, 로컬 기본 `http://localhost:3000`, 운영 기본 `https://taco-frontend-tau.vercel.app`), `JWT_SECRET`, `JWT_EXPIRES_IN` — `.env.example` 참고
- **API 문서(Swagger): http://localhost:3001/docs** (스펙 JSON: `/docs-json`)

## Docker (로컬 테스트 → AWS 배포)

로컬은 Docker로 백엔드를 띄우고, 프론트는 `NEXT_PUBLIC_API_URL` 로 그 주소를 가리킵니다.
추후 AWS 배포 시 **같은 이미지**를 ECR push 후 ECS/EC2에서 실행하고, 프론트 env만 공개 IP/도메인으로 바꿉니다.

```bash
cp .env.example .env            # 필요 시 값 수정
docker compose up --build       # → http://localhost:3001/api · 문서 /docs
docker compose logs -f api      # 로그
docker compose down             # 중지
```

프론트 연결(BASE_URL):

```bash
# frontend/.env.local
NEXT_PUBLIC_API_URL=http://localhost:3001     # 로컬 Docker
# NEXT_PUBLIC_API_URL=http://<EC2-공개IP>:3001 # AWS 배포 후 이 값만 교체
# NEXT_PUBLIC_API_URL=https://api.your-domain
```

> AWS 단계: ① `docker build` → ECR push ② ECS Fargate(또는 EC2+compose) 실행
> ③ 보안그룹에서 3001(또는 ALB 443) 오픈 ④ `WEB_ORIGIN`을 프론트 배포 주소로 설정.

## 구조 (feature 모듈 기반)

```
src/
├─ main.ts            # 부트스트랩 (CORS, /api prefix, ValidationPipe, Swagger /docs)
├─ app.module.ts      # 모듈 조립
├─ common/types/      # 공용 타입 (BaseRow)
├─ config/            # 환경설정 (app.config.ts)
├─ database/          # InMemoryDatabase (추후 Repository로 교체)
└─ modules/
   ├─ auth/           # JWT 서명/검증
   ├─ health/         # 헬스체크
   ├─ users/          # 계정(web id 존재 확인)
   ├─ students/       # 학생
   ├─ enrollments/    # 수강 등록
   ├─ payments/       # 결제(청구→수납)
   ├─ subjects/       # 과목
   ├─ courses/        # 코스(시급 포함)
   └─ expenses/       # 지출(요청→승인/반려)
```

## 타입 컨벤션 / 공유 계약

- 도메인 모델은 `type`(예: `Student = StudentContract & BaseRow`), DTO는 **class**(class-validator 런타임 메타데이터 필요).
- 엔티티/DTO는 `@kms545487/contracts`를 `import type`/`implements` 하여 프론트와 형상 일치 (런타임 의존 없음 — `dist`에 미포함).

## 엔드포인트

> **전체 설계 스펙(현재+예정, payload 포함)**: [`docs/api/openapi.yaml`](./docs/api/openapi.yaml) · 인덱스/규약: [`docs/api/README.md`](./docs/api/README.md)
> 구현된 부분의 라이브 Swagger는 실행 후 `/docs`.

### 구현 요약

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/health` | 헬스체크 |
| POST | `/api/auth/token` · GET `/api/auth/me` | 토큰 발급/검증 |
| GET | `/api/users/exists?webId=` | web id 존재 확인 |
| GET/POST | `/api/students` (+ `/:id`) | 학생 |
| GET/POST | `/api/enrollments` (`?studentId=`) | 수강 등록 |
| GET/POST | `/api/payments` · POST `/:id/pay` | 결제·수납 |
| GET/POST | `/api/subjects` (+ `/:id`) | 과목 |
| GET/POST | `/api/courses` (+ `/:id`) | 코스 |
| GET/POST | `/api/expenses` · POST `/:id/approve`·`/reject` | 지출(승인) |

## 남은 도메인 (스펙 정의 완료 · 구현 예정)

class-sessions·attendance·session-reports(피드백), counsel(forms+rounds), instructor-payouts,
academy-events, roadmaps(M:N), parents/instructors, transactions/dashboard/approvals.
payload·응답·권한은 [`docs/api/openapi.yaml`](./docs/api/openapi.yaml) 에 이미 정의됨(구현 26 · 예정 42 오퍼레이션).
sub-resource가 있는 sessions·counsel을 먼저 구현 권장.

## 변경 이력 — 스케줄 API 확장 (2026-06-29)

- `GET /schedule/resources` — 자원 피커(강사·강의실·학생·코스 옵션, FK 정렬).
- `POST /schedule` — 세션 생성(추천→배정·수동). FK 검증 + 충돌 검사(409 / `force`).
- `GET /schedule?studentId=` — 학생 활성 수강 코스의 세션만(코호트 역추적, status≠drop).
- `ScheduleRow.studentIds/studentNames` enrich(코호트). `availability` PUT/DELETE 클라이언트 연동.
- e2e(jest+supertest): `test/schedule.e2e-spec.ts`·`test/availability.e2e-spec.ts` — 참조 무결성·충돌·시리즈 스코프. `npm run test:e2e`.
- 보안 점검 이력: `docs/archive/SECURITY-review-2026-06-29.md`.
- 현재 프로젝트 문서 입구: 루트 `docs/README.md`와 `docs/CODEX.md`.
