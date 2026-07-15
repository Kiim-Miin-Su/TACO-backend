import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  // [E0.5 ⑥ 2026-07-15 대표 지시] 첫 로그인 강제 변경(must_change_password) 화면에서 가입 폼처럼
  //  프로필(이름·이메일·휴대폰)을 한 번에 받는다. **강제 변경 흐름에서만 허용** — 일반 변경은
  //  마이 페이지 승인/인증 경로(29B-4)를 지나야 하므로 서비스가 400으로 차단한다.
  @ApiPropertyOptional({ minLength: 1, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name?: string;

  @ApiPropertyOptional({ maxLength: 320 })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ example: '010-1234-5678' })
  @IsOptional()
  @Matches(/^\d{2,3}-\d{3,4}-\d{4}$/, { message: '전화번호는 010-1234-5678 형식으로 입력해 주세요.' })
  phone?: string;
}
