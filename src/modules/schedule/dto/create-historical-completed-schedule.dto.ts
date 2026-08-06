import { ApiProperty, OmitType } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';
import type { CreateHistoricalCompletedSessionInput } from '@kms545487/contracts';
import { CreateScheduleDto } from './create-schedule.dto';

/**
 * 과거 운영 데이터 이관 전용 입력.
 * 상태는 받지 않고, 서비스가 출결 사실을 함께 기록한 뒤 held를 자동 파생한다.
 */
export class CreateHistoricalCompletedScheduleDto
  extends OmitType(CreateScheduleDto, ['status', 'seriesId', 'force', 'instructorId', 'studentIds', 'makeupForSessionId'] as const)
  implements CreateHistoricalCompletedSessionInput {
  @ApiProperty({ example: 1, description: '실제 수업을 진행한 강사 FK' })
  @IsInt() @Min(1)
  instructorId!: number;

  @ApiProperty({ type: [Number], example: [1], description: '실제 수업에 참여한 학생 FK. 1명 이상 필수.' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true })
  studentIds!: number[];

  @ApiProperty({ example: '기존 7월 수업 기록 이관', description: '감사 이력에 남길 이관 사유(5~500자)' })
  @IsString() @MinLength(5) @MaxLength(500)
  importReason!: string;
}
