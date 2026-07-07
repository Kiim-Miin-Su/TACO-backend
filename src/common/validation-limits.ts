// [보안 2026-07-07] DTO 자유 텍스트·금액 상한 **단일 소스** — 전 모듈 공유.
//  배경: 여러 write DTO의 @IsString 필드가 상한 없이 무제한 문자열을 허용(저장 남용·페이로드 비대 위험).
//   스케줄/학생 DTO는 이미 @MaxLength로 캡을 걸어왔으나 events·expenses·parents·payouts 등은 누락 →
//   여기 상수로 통일해 @MaxLength(TEXT.x)로 일괄 부여(무결성 감사 2026-07-07).
//  (counsel은 앞서 COUNSEL_TEXT로 자체 캡 — 동일 취지, 후속 정렬 대상.)
export const TEXT = {
  name: 100, // 이름·제목·상호·라벨
  short: 30, // 전화·관계 등 짧은 코드
  webId: 50,
  date: 10, // 'YYYY-MM-DD'
  memo: 500, // 메모·사유·설명 등 자유 텍스트
  long: 2000, // 상세 본문
  url: 500,
} as const;

export const MAX_AMOUNT = 100_000_000; // 금액 상한(1억) — 오입력·오버플로 방지(스케줄/결제 @Max와 통일)
export const MAX_COUNT = 1000; // 수량(세션 수 등) 상한
