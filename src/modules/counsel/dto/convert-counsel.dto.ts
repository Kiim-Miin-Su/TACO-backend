import { IsDateString, IsInt, IsOptional, IsString, Min, Max, MaxLength } from 'class-validator';
import type { ConvertCounselInput } from '@kms545487/contracts';
import { TEXT, MAX_COUNT } from '../../../common/validation-limits'; // [보안] 상한 단일 소스

// [TBO-80 80E = TBO-30E] POST /counsel/:id/convert — 상담→수강 전환 입력.
//  studentId·counselCardId는 body로 받지 않는다(서버가 폼에서 결정 — client actor/target 주입 채널 차단,
//  ApproveReportDto.approvedBy 제거와 같은 축). 검증 상한은 CreateEnrollmentDto와 동일 소스.
export class ConvertCounselDto implements ConvertCounselInput {
  @IsInt()
  @Min(1)
  courseId!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  roadmapId?: number;

  @IsOptional()
  @IsDateString({ strict: true }, { message: 'startDate는 유효한 YYYY-MM-DD 날짜여야 합니다.' })
  startDate?: string;

  @IsOptional()
  @IsDateString({ strict: true }, { message: 'endDate는 유효한 YYYY-MM-DD 날짜여야 합니다.' })
  endDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_COUNT)
  totalSessions?: number;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.memo)
  memo?: string;
}
