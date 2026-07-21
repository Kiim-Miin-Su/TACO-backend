import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { UpdateStudentInput } from '@kms545487/contracts';

// [피드백 2026-07-03] 캘린더 우측 패널에서 학생 정보 즉시 수정 —
//  해외 학생의 출국/입국(country·residenceType 변경)과 갑작스런 그만둠(status) 대응.
//  업무 상태 변경과 삭제는 분리한다. 현재 DELETE 호환 경로의 완전한 deleted_at 전환은 TBO-35C에서 닫는다.
// [v0.1.14 A1] implements UpdateStudentInput — country 누락 drift를 contracts에 보정 후 연결.
export class UpdateStudentDto implements UpdateStudentInput {
  @IsOptional() @IsString() @MaxLength(20)
  name?: string;

  @IsOptional() @IsString() @MaxLength(50)
  englishName?: string;

  @IsOptional() @IsIn(['male', 'female', 'other', 'undisclosed'])
  gender?: 'male' | 'female' | 'other' | 'undisclosed';

  @IsOptional()
  @IsDateString({ strict: true }, { message: 'birthDate는 유효한 YYYY-MM-DD 날짜여야 합니다.' })
  birthDate?: string;

  @IsOptional() @IsInt() @Min(0) @Max(13)
  grade?: number;

  @IsOptional() @IsString() @MaxLength(20)
  phone?: string;

  @IsOptional() @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'country는 ISO 3166-1 alpha-2 대문자 2자여야 합니다(예: KR·US·VN)' })
  country?: string;

  @IsOptional() @IsIn(['domestic', 'overseas'])
  residenceType?: 'domestic' | 'overseas';

  @IsOptional() @IsString() @MaxLength(100)
  address?: string;

  @IsOptional() @IsString() @MaxLength(100)
  addressDetail?: string;

  @IsOptional() @IsString() @MaxLength(100)
  kakaoId?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  counselTopic?: string;

  @IsOptional() @IsIn(['enrolled', 'on_leave', 'withdrawn', 'registration_lost', 'new_inquiry'])
  status?: 'enrolled' | 'on_leave' | 'withdrawn' | 'registration_lost' | 'new_inquiry';

  @IsOptional() @IsString() @MaxLength(500)
  memo?: string;
}
