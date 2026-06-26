# TACO API (backend)

NestJS 기반 TACO ERP API. **독립 repo**로 운영합니다. 우선 in-memory DB로 시작하고, 추후 PostgreSQL(TypeORM)로 교체합니다.

## 실행

```bash
npm install
npm run dev        # http://localhost:3001/api (watch)
npm run build && npm start
```

환경변수: `PORT`(기본 3001), `WEB_ORIGIN`(CORS, 기본 http://localhost:3000)

## 구조 (feature 모듈 기반, 확장형)

```
src/
├─ main.ts                  # 부트스트랩 (CORS, 전역 prefix /api, ValidationPipe)
├─ app.module.ts            # 모듈 조립
├─ common/types/            # 공용 타입 (BaseRow 등)
├─ config/                  # 환경설정 (app.config.ts)
├─ database/                # InMemoryDatabase (추후 Repository로 교체)
└─ modules/                 # feature 모듈 (확장 지점)
   ├─ auth/                 #   JWT 서명/검증 (controller·service·dto)
   ├─ health/              #   GET /api/health
   ├─ students/            #   학생 (controller·service·entity·dto)
   ├─ enrollments/         #   수강 등록 (결제 없이도 active)
   └─ payments/            #   결제 (옵셔널, 청구→수납)
```

## 타입 컨벤션

도메인 모델은 `type`(예: `Student = BaseRow & {…}`). 단 **DTO는 class**로 둡니다 — class-validator/ValidationPipe가 런타임 메타데이터를 요구하기 때문(코드에 사유 주석 포함).

## 엔드포인트 (요약)

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/health` | 헬스체크 |
| POST | `/api/auth/token` | 토큰 발급(데모) |
| GET | `/api/auth/me` | `Bearer` 토큰 검증 |
| GET/POST | `/api/students` | 학생 목록/등록 |
| GET | `/api/students/:id` | 학생 단건 |
| GET/POST | `/api/enrollments` | 수강 등록 목록/생성 (`?studentId=`) |
| GET/POST | `/api/payments` | 결제 목록/청구 생성 |
| POST | `/api/payments/:id/pay` | 수납 완료 처리 |

## 데이터 모델

전체 ERD는 프론트와 별개로 관리되는 `docs/erd.dbml` 참고. 본 스캐폴드는 핵심 3개 도메인(students·enrollments·payments)만 우선 구현했습니다.
