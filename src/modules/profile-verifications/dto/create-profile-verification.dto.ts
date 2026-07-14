import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

// [TBO-29B-4] challenge 생성 — 현재 비밀번호 재확인 + 채널 + 대상.
//  이메일 형식/전화 E.164 정규화·중복 검사는 서비스가 권위 수행(정규식은 UX 방어일 뿐 — §3).
export class CreateProfileVerificationDto {
  @ApiProperty({ description: '현재 비밀번호(재확인) — 저장·로그 금지', maxLength: 72 })
  @IsString() @MinLength(1) @MaxLength(72)
  currentPassword!: string;

  @ApiProperty({ enum: ['email', 'sms'], description: '인증 채널' })
  @IsIn(['email', 'sms'])
  channel!: 'email' | 'sms';

  @ApiProperty({ description: '변경할 연락처(이메일 주소 또는 휴대전화 — E.164/국내형)', maxLength: 320 })
  @IsString() @MinLength(3) @MaxLength(320)
  target!: string;
}
