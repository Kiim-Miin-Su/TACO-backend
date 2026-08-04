import type {
  ClearInstructorAttendanceInput,
  InstructorAttendanceStatus,
  SetInstructorAttendanceInput,
} from '@kms545487/contracts';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { TEXT } from '../../../common/validation-limits';
import { INSTRUCTOR_ATT_STATUSES } from '../schedule.entity';

abstract class AccountingAckDto {
  @ApiPropertyOptional({ description: '회계 영향 미리보기 확인 여부(409 응답 확인 뒤 true)' })
  @IsOptional()
  @IsBoolean()
  acknowledgeAccountingImpact?: boolean;

  @ApiPropertyOptional({ description: '직전 회계 영향 미리보기의 sha256 지문' })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/, { message: 'expectedAccountingImpactHash는 64자리 sha256 hex여야 합니다' })
  expectedAccountingImpactHash?: string;
}

export class SetInstructorAttendanceDto extends AccountingAckDto implements SetInstructorAttendanceInput {
  @ApiProperty({ enum: INSTRUCTOR_ATT_STATUSES, example: 'present' })
  @IsIn(INSTRUCTOR_ATT_STATUSES)
  status!: InstructorAttendanceStatus;
}

export class ClearInstructorAttendanceDto extends AccountingAckDto implements ClearInstructorAttendanceInput {
  @ApiProperty({ example: '오입력 정정', minLength: 2, maxLength: TEXT.memo })
  @IsString()
  @MinLength(2)
  @MaxLength(TEXT.memo)
  reason!: string;
}
