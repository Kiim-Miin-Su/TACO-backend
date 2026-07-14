import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

// [TBO-29B-4] OTP 확인 — 실패 5회 잠금·만료 10분은 DB 컬럼이 권위(§7).
export class ConfirmProfileVerificationDto {
  @ApiProperty({ description: '수신한 인증 코드(6자리 숫자)', minLength: 4, maxLength: 10 })
  @IsString() @MinLength(4) @MaxLength(10) @Matches(/^\d+$/)
  code!: string;
}
