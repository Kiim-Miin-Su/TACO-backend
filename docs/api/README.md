# TACO ERP — API 스펙 (단일 소스)

전체 엔드포인트·payload를 **구현 전에 미리** 정의해 둔 설계 스펙입니다.
"무엇을 만들지 까먹지 않기 위해" 현재(구현) + 예정(TBO-02) 엔드포인트를 모두 담습니다.

- 스펙 파일: [`openapi.yaml`](./openapi.yaml) — OpenAPI 3.1
- 현황: **81개 오퍼레이션** (구현 26 · 예정 55), 스키마 78개 — `2026-06-29` 기준 (v5 스케줄 엔진 포함)

## 보는 방법

- **설계 스펙 전체**(예정 포함): [`openapi.yaml`](./openapi.yaml) 내용을 <https://editor.swagger.io> 에 붙여넣기.
- **라이브 Swagger**(현재 구현된 것만, 코드에서 자동 생성): 백엔드 실행 후 `http://localhost:3001/docs` · JSON `/docs-json`.
- 검증: `npx @redocly/cli lint openapi.yaml` (valid · 경고는 4xx 응답 권고 수준).

## 단일 소스 원칙 (중요)

payload/엔티티의 형상은 **한 곳에서만** 정의합니다.

```
@kms545487/contracts (TS 타입)  ──┬─▶  backend DTO (class implements Create*Input) ──▶ 컨트롤러
   = 진짜 단일 소스               ├─▶  frontend store/mock 함수 매개변수 (같은 Create*Input 사용)
                                 └─▶  본 openapi.yaml (스키마는 그 타입을 OpenAPI로 옮긴 것)
```

- 백엔드 DTO(class)는 런타임 검증(class-validator)이 필요해 **class**로 두되, 형상은 계약 타입을 `implements` 합니다.
- 프론트 store/mock의 입력 payload도 **같은 계약 타입**을 받아야 백엔드와 어긋나지 않습니다. (아래 "store/mock payload" 참고)
- 본 YAML은 손으로 관리하는 **설계 사본**입니다. 구현이 끝난 도메인은 라이브 Swagger가 정답이며, 둘이 다르면 라이브 우선 + 본 파일을 맞춥니다.

## 공통 규약

| 항목 | 규약 |
|---|---|
| Base path | `/api` (예: `/api/students`) |
| 인증 | `Authorization: Bearer <JWT>`. `x-roles: [public]`/`[any]` 외 모든 엔드포인트는 토큰 필요 |
| 권한 | 각 오퍼레이션 `x-roles` 에 허용 역할 명시. 부족 시 `403` |
| 페이지네이션(예정) | `?page=&size=&q=&sort=` · 응답 `{ data, meta: { page, size, total } }` |
| 날짜 | `date` = `YYYY-MM-DD` (KST 기준 결정론적 처리) |
| 에러 | NestJS 기본: `{ statusCode, message, error }` |
| 상태 표기 | 오퍼레이션 `x-status`: `implemented` \| `planned` |

## 도메인 인덱스

| 도메인 | 엔드포인트(요약) | 상태 |
|---|---|---|
| health | `GET /health` | 구현 |
| auth | `POST /auth/token` · `GET /auth/me` | 구현 |
| users | `GET /users` · `GET /users/exists` | 구현 |
| students | `GET·POST /students` · `GET /students/{id}` · `PATCH /{id}` · `POST /{id}/drop` · `GET /{id}/detail` | 구현+예정 |
| parents | `GET·POST /parents` | 예정 |
| instructors | `GET /instructors` | 예정 |
| enrollments | `GET·POST /enrollments` · `GET·PATCH /{id}` | 구현+예정 |
| subjects | `GET·POST /subjects` · `GET /{id}` | 구현 |
| courses | `GET·POST /courses` · `GET /{id}` | 구현 |
| roadmaps | `GET·POST /roadmaps` · `GET·PATCH /{id}` | 예정 |
| class-sessions | `GET·POST` · `POST /recurring` · `GET·PATCH·DELETE /{id}` | 예정 |
| attendance | `GET /attendance` · `PUT /attendance` | 예정 |
| session-reports | `GET·PUT` · `POST /{id}/submit` · `POST /{id}/send` | 예정 |
| counsel | `GET·POST /counsel` · `GET·PATCH /{id}` · `POST /{id}/rounds` | 예정 |
| payments | `GET·POST /payments` · `GET·PATCH /{id}` · `POST /{id}/pay` | 구현+예정 |
| instructor-payouts | `GET·POST` · `POST /{id}/approve` · `POST /{id}/pay` | 예정 |
| expenses | `GET·POST /expenses` · `GET·PATCH /{id}` · `POST /{id}/approve` · `POST /{id}/reject` | 구현+예정 |
| academy-events | `GET·POST` · `PATCH·DELETE /{id}` | 예정 |
| transactions | `GET /transactions` | 예정 |
| dashboard | `GET /dashboard/summary` · `GET /dashboard/revenue` (대표 전용) | 예정 |
| approvals | `GET /approvals` (대표 전용) | 예정 |
| **rooms** (v5) | `GET·POST /rooms` · `GET·PATCH /{id}` · `GET /{id}/schedule` | 예정 |
| **availability** (v5) | `GET·PUT /availability` · `DELETE /{id}` | 예정 |
| **scheduling** (v5) | `POST /schedule/conflicts` · `POST /schedule/suggest-slots` · `GET /instructors|students|rooms/{id}/schedule` · `GET /reports/teaching-hours` | 예정 |

> v5 스케줄 엔진 상세 설계: `docs/scheduling.md` (Lantiv 분석 기반).

## store/mock payload ↔ DTO

프론트 `lib/store.ts` 의 입력 payload(예: `NewPaymentInput`)는 점진적으로 계약의 `Create*Input` 로 통일합니다.
단, **여러 엔드포인트를 한 번에 호출하는 복합 폼**(예: 학생+학부모+수강을 한 번에 등록)은
단일 DTO로 합치지 않고 **DTO들의 조합**으로 모델링합니다 — UI 폼과 API 요청의 책임이 다르기 때문입니다.

```ts
// 권장: API 1:1 매핑은 계약 DTO 그대로
addPayment(input: CreatePaymentInput)

// 권장: 복합 폼은 DTO 조합(여러 엔드포인트로 분해됨)
type RegisterStudentCommand = {
  student: CreateStudentInput;
  parent?: CreateParentInput;   // → POST /parents
  courseId?: number;            // → POST /enrollments
};
```
