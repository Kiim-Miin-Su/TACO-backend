// [TBO-29C C5] 비로그인 복구 DTO — 아이디 찾기·비밀번호 재설정. 응답은 항상 동일(계정 열거 방지).
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RecoverIdDto {
  @ApiProperty({ example: 'staff@tnacademy.test', description: '가입 이메일 — 일치하면 아이디를 메일로 안내' })
  @IsEmail()
  @MaxLength(255)
  email!: string;
}

export class RecoverPasswordDto {
  @ApiProperty({ example: 'staff01', description: '아이디' })
  @IsString() @MinLength(1) @MaxLength(50)
  webId!: string;

  @ApiProperty({ example: 'staff@tnacademy.test', description: '가입 이메일 — 아이디와 함께 일치해야 발송' })
  @IsEmail()
  @MaxLength(255)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: '메일로 받은 재설정 토큰' })
  @IsString() @MinLength(16) @MaxLength(128)
  token!: string;

  @ApiProperty({ writeOnly: true, minLength: 8, maxLength: 72 })
  @IsString() @MinLength(8) @MaxLength(72)
  newPassword!: string;
}
