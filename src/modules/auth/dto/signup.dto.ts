import { IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { RRN_FORMAT_MESSAGE, RRN_REGEX } from '../../../common/rrn-crypto.util';

const SIGNUP_ROLES = ['instructor', 'manager', 'admin'];

// 가입 신청 — super_admin은 신청 불가(대표가 승인하는 구조). 비밀번호 8자 이상.
// [A1 2026-07-06] 인증 흐름 전용(가입 폼) — contracts 미승격(A1 제외).
// [E0.5 ④b 2026-07-15] 대표 기대 필드 확장(전화·대학·전공) — 승인 판단 근거.
// [TBO-31 C1] birthYear 입력 폐지 → rrn(주민등록번호)·emailChallengeId(가입 전 이메일 OTP) 필수.
//  birthYear는 서버가 RRN 앞자리에서 파생 저장한다(승인센터·프로필 승계 등 기존 소비처 무파괴).
export class SignupDto {
  @IsString() @MinLength(3) @MaxLength(50)
  webId!: string;

  @IsString() @MinLength(1) @MaxLength(50)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString() @MinLength(8) @MaxLength(100)
  password!: string;

  // [TBO-31 C1 D2] 주민등록번호 — 형식만 검증(MMDD 타당성은 서비스가 재검증, 체크섬 검증 없음:
  //  2020-10 이후 발급분은 임의번호). 평문은 응답·로그·audit 어디에도 남기지 않는다(암호문 저장).
  @IsString() @Matches(RRN_REGEX, { message: RRN_FORMAT_MESSAGE })
  rrn!: string;

  // [TBO-31 C1 D1] 가입 전 이메일 OTP — verified challenge를 가입 tx에서 일회 소비.
  @IsInt()
  emailChallengeId!: number;

  @IsOptional() @IsIn(SIGNUP_ROLES)
  role?: string;

  // 전화 형식은 프로필 변경 규약과 동일(SMS 인증 유예 §13.87 — xxx-xxxx-xxxx만 우선 허용)
  @IsOptional() @Matches(/^\d{2,3}-\d{3,4}-\d{4}$/, { message: '전화번호는 010-1234-5678 형식으로 입력해 주세요.' })
  phone?: string;

  @IsOptional() @IsString() @MaxLength(100)
  university?: string;

  @IsOptional() @IsString() @MaxLength(100)
  major?: string;
}
