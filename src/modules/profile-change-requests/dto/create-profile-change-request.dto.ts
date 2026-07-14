import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class CreateProfileChangeRequestDto {
  // [TBO-29B-4] 모든 마이 페이지 변경은 현재 비밀번호 재확인 필수(§2). 저장·로그 금지.
  @ApiProperty({ description: '현재 비밀번호(재확인)', maxLength: 72 })
  @IsString() @MinLength(1) @MaxLength(72)
  currentPassword!: string;

  @ApiPropertyOptional({ example: '박지훈', minLength: 1, maxLength: 50 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString() @MinLength(1) @MaxLength(50)
  name?: string;

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
