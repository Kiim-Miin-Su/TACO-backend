import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { normalizeStaffEnglishName, STAFF_ENGLISH_NAME_MAX_LENGTH, STAFF_ENGLISH_NAME_MESSAGE, STAFF_ENGLISH_NAME_PATTERN, type CreateProfileChangeRequestInput } from '@kms545487/contracts';

export class CreateProfileChangeRequestDto implements CreateProfileChangeRequestInput {
  // [TBO-29B-4] 모든 마이 페이지 변경은 현재 비밀번호 재확인 필수(§2). 저장·로그 금지.
  @ApiProperty({ description: '현재 비밀번호(재확인)', maxLength: 72 })
  @IsString() @MinLength(1) @MaxLength(72)
  currentPassword!: string;

  @ApiPropertyOptional({ example: '박지훈', minLength: 1, maxLength: 50 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString() @MinLength(1) @MaxLength(50)
  name?: string;

  @ApiPropertyOptional({ example: 'Jihoon Park', maxLength: STAFF_ENGLISH_NAME_MAX_LENGTH, pattern: STAFF_ENGLISH_NAME_PATTERN.source })
  @Transform(({ value }) => typeof value === 'string' ? normalizeStaffEnglishName(value) : value)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString() @MaxLength(STAFF_ENGLISH_NAME_MAX_LENGTH)
  @Matches(STAFF_ENGLISH_NAME_PATTERN, { message: STAFF_ENGLISH_NAME_MESSAGE })
  englishName?: string;

  // [E0] 아이디(webId) 변경 — 승인제(대표 결정). 승인 시 auth_version+1로 기존 세션 전부 무효.
  @ApiPropertyOptional({ example: 'jihoon_park', minLength: 3, maxLength: 50, description: '변경할 아이디(대표 승인 후 적용·재로그인 필요)' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString() @MinLength(3) @MaxLength(50)
  webId?: string;

  // [TBO-29B-4] 이메일 변경 — 인증된 challenge(verificationChallengeId) 소비 필수.
  @ApiPropertyOptional({ example: 'new@tnacademy.test', maxLength: 320, description: '변경할 이메일(사전 인증 필수)' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsEmail() @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ description: '연락처(email/phone) 변경 시 소비할 verified challenge id' })
  @IsOptional() @IsInt()
  verificationChallengeId?: number;

  @ApiPropertyOptional({ example: '+82-10-1234-5678', nullable: true, maxLength: 20 })
  @IsOptional() @IsString() @MaxLength(20)
  phone?: string | null;

  @ApiPropertyOptional({ example: 'KR', nullable: true, description: '국가/권역 코드(예: KR, US-W)' })
  @IsOptional() @IsString() @Matches(/^[A-Za-z][A-Za-z0-9-]{1,7}$/)
  countryCode?: string | null;

  @ApiPropertyOptional({ example: 'Asia/Seoul', nullable: true, maxLength: 64 })
  @IsOptional() @IsString() @MaxLength(64)
  timeZone?: string | null;

  @ApiProperty({ example: '업무 연락처가 변경되었습니다.', minLength: 5, maxLength: 500 })
  @IsString() @MinLength(5) @MaxLength(500)
  reason!: string;
}
