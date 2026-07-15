import { IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const SIGNUP_ROLES = ['instructor', 'manager', 'admin'];

// 가입 신청 — super_admin은 신청 불가(대표가 승인하는 구조). 비밀번호 8자 이상.
// [A1 2026-07-06] 인증 흐름 전용(가입 폼) — contracts 미승격(A1 제외).
// [E0.5 ④b 2026-07-15] 대표 기대 필드 확장(전화·대학·전공·출생연도) — 승인 판단 근거.
//  DTO는 optional(기존 e2e·구 클라이언트 호환) + FE 폼이 필수 입력을 강제한다.
export class SignupDto {
  @IsString() @MinLength(3) @MaxLength(50)
  webId!: string;

  @IsString() @MinLength(1) @MaxLength(50)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString() @MinLength(8) @MaxLength(100)
  password!: string;

  @IsOptional() @IsIn(SIGNUP_ROLES)
  role?: string;

  // 전화 형식은 프로필 변경 규약과 동일(SMS 인증 유예 §13.87 — xxx-xxxx-xxxx만 우선 허용)
  @IsOptional() @Matches(/^\d{2,3}-\d{3,4}-\d{4}$/, { message: '전화번호는 010-1234-5678 형식으로 입력해 주세요.' })
  phone?: string;

  @IsOptional() @IsString() @MaxLength(100)
  university?: string;

  @IsOptional() @IsString() @MaxLength(100)
  major?: string;

  @IsOptional() @IsInt() @Min(1940) @Max(2020)
  birthYear?: number;
}
