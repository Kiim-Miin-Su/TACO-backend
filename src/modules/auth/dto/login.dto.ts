import { IsOptional, IsString, MaxLength } from 'class-validator';

// 로그인 입력 — 데모: webId로 계정 조회 후 토큰 발급. password는 받되 데모에선 검증 생략.
// [A1 2026-07-06] 인증 흐름 전용(웹 폼) — 도메인 엔티티 계약이 아니라 contracts 미승격(A1 제외).
export class LoginDto {
  @IsString()
  @MaxLength(50)
  webId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  password?: string;
}
