import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

// [피드백 2026-07-03] 캘린더 우측 패널에서 학생 정보 즉시 수정 —
//  해외 학생의 출국/입국(country·residenceType 변경)과 갑작스런 그만둠(status) 대응.
//  status 'canceled'는 DELETE(퇴원 처리 — 수강 동반 정리)와 달리 단순 상태 표기용으로도 허용하되,
//  수강 정리가 필요한 퇴원은 기존 remove 흐름을 사용(프론트가 안내).
export class UpdateStudentDto {
  @IsOptional() @IsString() @MaxLength(20)
  name?: string;

  @IsOptional() @IsString() @MaxLength(50)
  englishName?: string;

  @IsOptional() @IsInt() @Min(1) @Max(12)
  grade?: number;

  @IsOptional() @IsString() @MaxLength(20)
  phone?: string;

  @IsOptional() @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'country는 ISO 3166-1 alpha-2 대문자 2자여야 합니다(예: KR·US·VN)' })
  country?: string;

  @IsOptional() @IsIn(['domestic', 'overseas'])
  residenceType?: 'domestic' | 'overseas';

  @IsOptional() @IsIn(['lead', 'active', 'paused', 'completed', 'canceled'])
  status?: 'lead' | 'active' | 'paused' | 'completed' | 'canceled';

  @IsOptional() @IsString() @MaxLength(500)
  memo?: string;
}
