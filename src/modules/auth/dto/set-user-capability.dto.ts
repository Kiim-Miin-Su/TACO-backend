import { ApiProperty } from '@nestjs/swagger';
import type { CapabilityOverrideMode, SetUserCapabilityInput } from '@kms545487/contracts';
import { IsIn, IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

const MODES: CapabilityOverrideMode[] = ['allow', 'deny', 'default'];

export class SetUserCapabilityDto implements SetUserCapabilityInput {
  @ApiProperty({ enum: MODES, description: 'allow/deny 사용자 예외 또는 role 기본값 복원' })
  @IsIn(MODES)
  mode!: CapabilityOverrideMode;

  @ApiProperty({ minLength: 5, maxLength: 200, description: '감사 이력에 남길 변경 사유' })
  @IsString()
  @MinLength(5)
  @MaxLength(200)
  reason!: string;

  @ApiProperty({ minimum: 1, description: '권한 화면을 읽었을 때의 대상 auth/access version' })
  @IsInt()
  @Min(1)
  expectedAccessVersion!: number;
}
