# 보안·참조 무결성 점검 — 스케줄/캘린더 통합 (2026-06-29)

> 범위: 이번 스프린트에서 추가/변경된 스케줄·가용·자원 API와 결제 등 민감 도메인의 인증·권한·입력검증·무결성.
> 방식: 코드 실측(`src/**`) + e2e(`test/*.e2e-spec.ts`) 결과 기준. 데모는 in-memory 저장소(비영속).

## 1. 요약 (위험도순)

| # | 항목 | 위험 | 상태 |
|---|------|------|------|
| H1 | **인증/권한 미적용** — 모든 라우트가 가드 없음(`UseGuards` 0건) | 🔴 High | 미해결(데모 한계) |
| H2 | **결제·승인 민감 엔드포인트 무인증** (`/payments`, `/expenses/:id/approve` 등) | 🔴 High | 미해결 |
| M1 | **`force=true` 충돌 우회 권한 미통제** — 누구나 이중예약 강제 생성/이동 | 🟠 Med | 설계상 허용, 권한 게이팅 필요 |
| M2 | **IDOR** — `studentId/instructorId/roomId`로 타인 개인 스케줄 조회 가능(소유권 검사 없음) | 🟠 Med | 미해결 |
| M3 | **시리즈 일괄수정 영향범위** — 단일 PATCH(`scope=all`)가 다수 세션 변경 | 🟠 Med | 무결성 OK, 권한·확인 필요 |
| L1 | 일부 바디 미검증(`POST /schedule/conflicts` 인라인 타입, `update.force` 검증기 없음) | 🟡 Low | 부분 |
| L2 | 숫자 쿼리 `Number()` 파싱 → 비숫자 시 `NaN`(빈 결과로 흡수) | 🟡 Low | 무해하나 가드 권장 |
| L3 | in-memory `Object.assign` 동시쓰기 레이스·비영속 | 🟡 Low | 데모 한계(→ TypeORM/트랜잭션 이관 시 해소) |

## 2. 상세

### H1/H2 — 인증·권한 (가장 시급)
- `auth` 모듈(JWT 로그인)은 존재하나 **어떤 컨트롤러에도 `@UseGuards`/Roles 가드가 없음**. 따라서 스케줄 생성/이동, 가용 CRUD, **결제·수납·지출 승인**까지 전부 무인증 호출 가능.
- OpenAPI의 `x-roles`(예: schedule = manager+)는 **문서상 의도일 뿐 강제되지 않음**.
- 권고:
  1. 전역 `JwtAuthGuard` + `RolesGuard` 도입(공개 엔드포인트만 `@Public()`).
  2. 역할 매핑: 조회(instructor+), **쓰기/배정/`force`(manager+)**, **결제·지출·승인·페이 지급(super_admin)**.
  3. 결제 도메인은 별도 감사 로그(누가/언제/금액) 적용.

### M1 — `force` 충돌 우회
- `POST /schedule`·`PATCH /schedule/:id`의 `force=true`는 강사/강의실 이중예약·불가시간을 무시하고 적용(설계상 "그래도 진행"). e2e로 동작 확인(409→force 201).
- 위험: 권한 통제가 없으면 누구나 이중예약을 양산 → 시수·페이 회계 왜곡.
- 권고: `force`는 manager+만 허용. 강제 적용 시 `conflicts`를 응답에 포함(현재 충족) + 감사 로그.

### M2 — IDOR(개인 스케줄 노출)
- `GET /schedule?studentId=`·자원 레일은 소유권 검사 없이 임의 id 조회 가능. 학생/학부모 토큰이라면 **본인 코호트로 스코프 제한** 필요.
- 권고: 토큰 클레임(role, ownerId)으로 `studentId`/`instructorId`를 강제 치환 또는 검증.

### M3 — 시리즈 일괄수정
- `scope=this_and_following|all`은 같은 `seriesId`의 다수 세션에 날짜·시각 델타를 일괄 적용. **무결성은 정상**(이동 형제는 충돌 검사에서 제외, `movingIds`), e2e로 `updated>1` 확인.
- 위험은 권한·실수: 광범위 변경이 한 번에 일어남. 권고: manager+ 한정 + UI 확인(프론트 `RecurrencePrompt` 존재).

### L1 — 입력 검증 보강
- `POST /schedule/conflicts`는 DTO 없이 인라인 타입 → `ValidationPipe` 미적용. 전용 DTO 권장.
- `UpdateScheduleDto.force`에 `@IsBoolean()` 없음(생성 DTO엔 추가함). 통일 권장.
- 양수 보강: `CreateScheduleDto`는 `@ApiProperty`/`@Matches(HH:mm)`/`@Min` 적용됨. `whitelist:true`로 미허용 필드 제거.

## 3. 참조 무결성 점검 (이번 변경 한정) — 결과: 양호

| 항목 | 확인 | 근거 |
|------|------|------|
| FK 검증(course/instructor/room) — 생성·이동 | ✅ | `create`/`update`에서 미존재 시 400. e2e: courseId 999·roomId 9999 → 400 |
| 학생 코호트 역추적(`studentId` 필터) = enrich와 동일 소스 | ✅ | `COURSE_STUDENTS` 단일 소스. e2e: studentId=2 → 코스11만 |
| 소프트삭제(status=drop) 학생은 코호트/스코프 제외 | ✅ | `activeStudentsOf` 필터(보존하되 활성 스코프 배제) |
| 충돌 규칙 = 프론트 엔진과 1:1 | ✅ | 이중예약·불가시간·capacity. e2e: double_book·unavailable |
| 시리즈 동반 이동 시 자기 형제 충돌 오탐 방지 | ✅ | `movingIds` 제외 후 검사 |
| 추천(가용 교집합)·학생중심 추천 불변식 | ✅ | Vitest 6(`suggestPairSlots`·`recommendForStudent`·`ownerWindows`) |

## 4. 테스트 게이트
- 프론트 엔진 단위/스케일: `vitest run` — 36 pass(가용·추천·N=10/100/1000 불변식 포함).
- 백엔드 e2e: `npm run test:e2e` — 15 pass(FK 400·충돌 409/force·unavailable·시리즈 scope·가용 CRUD·충돌 연동).
- CI 권고: 위 둘을 머지 게이트로. 다음 스프린트에 **인증·권한 가드 + 권한 e2e**(401/403) 추가.

## 5. 다음 조치(우선순위)
1. (H1/H2) 전역 인증 + RolesGuard + 결제/승인/`force` 권한 게이팅 + 감사 로그.
2. (M2) 토큰 기반 개인 스케줄 스코프 강제(IDOR 차단).
3. (L1) conflicts DTO화 + force 검증 통일.
4. 영속화(TypeORM) 시 트랜잭션·낙관적 잠금으로 L3 해소.
