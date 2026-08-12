import { IsEmail, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { normalizeStaffEnglishName, STAFF_ENGLISH_NAME_MAX_LENGTH, STAFF_ENGLISH_NAME_MESSAGE, STAFF_ENGLISH_NAME_PATTERN } from '@kms545487/contracts';

export class ChangeCredentialsDto {
  @ApiProperty({ writeOnly: true, maxLength: 72 })
  @IsString()
  @MaxLength(72)
  currentPassword!: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  newWebId?: string;

  @ApiPropertyOptional({ writeOnly: true, minLength: 8, maxLength: 72 })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword?: string;

  // [E0 2026-07-15] 평시 비밀번호 변경 = 본인 현재 이메일 OTP 소비 필수(같은 tx).
  //  첫 로그인 강제 변경(must_change_password)은 예외(부트스트랩 컨텍스트).
  @ApiPropertyOptional({ description: '비밀번호 변경 시 소비할 본인 이메일 verified challenge id(평시 필수)' })
  @IsOptional()
  @IsInt()
  verificationChallengeId?: number;

  // [E0.5 ⑥ 2026-07-15 대표 지시] 첫 로그인 강제 변경(must_change_password) 화면에서 가입 폼처럼
  //  프로필(이름·이메일·휴대폰)을 한 번에 받는다. **강제 변경 흐름에서만 허용** — 일반 변경은
  //  마이 페이지 승인/인증 경로(29B-4)를 지나야 하므로 서비스가 400으로 차단한다.
  @ApiPropertyOptional({ minLength: 1, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name?: string;

  @ApiPropertyOptional({ maxLength: STAFF_ENGLISH_NAME_MAX_LENGTH, example: 'Minsoo Kim', pattern: STAFF_ENGLISH_NAME_PATTERN.source })
  @Transform(({ value }) => typeof value === 'string' ? normalizeStaffEnglishName(value) : value)
  @IsOptional()
  @IsString()
  @MaxLength(STAFF_ENGLISH_NAME_MAX_LENGTH)
  @Matches(STAFF_ENGLISH_NAME_PATTERN, { message: STAFF_ENGLISH_NAME_MESSAGE })
  englishName?: string;

  @ApiPropertyOptional({ maxLength: 320 })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ example: '010-1234-5678' })
  @IsOptional()
  @Matches(/^\d{2,3}-\d{3,4}-\d{4}$/, { message: '전화번호는 010-1234-5678 형식으로 입력해 주세요.' })
  phone?: string;

  // [대표 추가요청 2026-07-16] 첫 로그인 통합 설정 — users 테이블의 **수정 가능 컬럼 전부** 수집.
  //  (직책=role은 자기 결정 금지 — 화면에 읽기 전용 표시만.) 강제 변경 흐름에서만 허용(서비스 400).
  @ApiPropertyOptional({ example: 'KR', description: '국가 코드(catalog/countries)' })
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9-]{1,7}$/, { message: '국가 코드는 KR, US-W처럼 2~8자입니다.' })
  countryCode?: string;

  @ApiPropertyOptional({ example: 'Asia/Seoul', description: 'IANA 시간대(catalog/countries)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timeZone?: string;

  @ApiPropertyOptional({ maxLength: 100, description: '출신 대학' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  university?: string;

  @ApiPropertyOptional({ maxLength: 100, description: '전공' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  major?: string;

  @ApiPropertyOptional({ example: 1990, description: '출생연도' })
  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2100)
  birthYear?: number;
}
