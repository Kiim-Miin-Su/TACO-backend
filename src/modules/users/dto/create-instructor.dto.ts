import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

// [운영 흐름 2026-07-14] 대표가 받은 강사 정보(이름·나이·대학교·전공·전화번호·아이디·비번)를
//  직접 등록하는 입력. 계정은 즉시 active(이메일 인증 생략 — 직접 신원 확인 전제).
export class CreateInstructorDto {
  // [유저 관리 2026-07-20] 직접 등록 역할 확장 — instructor(기본)|manager|admin. super_admin 불가(단일 불변식).
  @ApiPropertyOptional({ description: '역할(기본 instructor)', enum: ['instructor', 'manager', 'admin'] })
  @IsOptional() @IsIn(['instructor', 'manager', 'admin'])
  role?: 'instructor' | 'manager' | 'admin';

  @ApiProperty({ description: '로그인 아이디', minLength: 3, maxLength: 50 })
  @IsString() @MinLength(3) @MaxLength(50)
  webId!: string;

  @ApiProperty({ description: '이름', minLength: 1, maxLength: 50 })
  @IsString() @MinLength(1) @MaxLength(50)
  name!: string;

  @ApiProperty({ description: '초기 비밀번호(8자+)', minLength: 8, maxLength: 100 })
  @IsString() @MinLength(8) @MaxLength(100)
  password!: string;

  @ApiPropertyOptional({ description: '이메일(선택)' })
  @IsOptional() @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: '전화번호', maxLength: 20 })
  @IsOptional() @IsString() @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: '대학교', maxLength: 100 })
  @IsOptional() @IsString() @MaxLength(100)
  university?: string;

  @ApiPropertyOptional({ description: '전공', maxLength: 100 })
  @IsOptional() @IsString() @MaxLength(100)
  major?: string;

  @ApiPropertyOptional({ description: '출생연도(나이 대신 연도로 보관)', minimum: 1940, maximum: 2020 })
  @IsOptional() @IsInt() @Min(1940) @Max(2020)
  birthYear?: number;

  @ApiPropertyOptional({ description: '근무 국가 코드(예 KR, GB)', maxLength: 8 })
  @IsOptional() @IsString() @MaxLength(8)
  countryCode?: string;

  @ApiPropertyOptional({ description: 'IANA timezone override(예 Asia/Seoul)', maxLength: 64 })
  @IsOptional() @IsString() @MaxLength(64)
  timeZone?: string;
}
