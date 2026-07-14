import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// [TBO-29B-4 §6] 응답은 masked target·상태·만료·재전송 가능 시각만 — canonical target/코드/hash 미노출.
export class ProfileVerificationResponseDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ['email', 'sms'] }) channel!: 'email' | 'sms';
  @ApiProperty({ description: '마스킹된 대상(예: pa***@t***.test, +82*****678)' }) maskedTarget!: string;
  @ApiProperty({ enum: ['pending', 'verified', 'consumed', 'expired', 'locked'] }) status!: string;
  @ApiProperty({ description: '만료 시각(ISO)' }) expiresAt!: string;
  @ApiProperty({ description: '재전송 가능 시각(ISO)' }) resendAvailableAt!: string;
  @ApiPropertyOptional({ description: '남은 확인 시도 횟수' }) attemptsLeft?: number;
}
