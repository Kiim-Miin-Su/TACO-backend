import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MaxLength,
  Matches,
} from 'class-validator';
import type { CreateStudentInput } from '@kms545487/contracts';
import { ResidenceType, StudentStatus } from '../student.entity';
import type { StudentGender } from '@kms545487/contracts';

// DTO는 type이 아니라 class로 둡니다.
// 이유: class-validator 데코레이터와 ValidationPipe가 런타임 메타데이터를
// 필요로 하므로, 런타임에 사라지는 type/interface로는 검증이 동작하지 않습니다.
// implements로 공유 계약(CreateStudentInput)과 형상 일치를 강제합니다.
export class CreateStudentDto implements CreateStudentInput {
  @IsString()
  @MaxLength(20)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  englishName?: string;

  @IsOptional()
  @IsIn(['male', 'female', 'other', 'undisclosed'])
  gender?: StudentGender;

  @IsDateString({ strict: true }, { message: 'birthDate는 유효한 YYYY-MM-DD 날짜여야 합니다.' })
  birthDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsInt()
  @Min(0)
  @Max(13)
  grade!: number;

  @IsString()
  @MaxLength(100)
  schoolName!: string;

  @IsOptional()
  @IsIn(['domestic', 'overseas'])
  residenceType?: ResidenceType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  addressDetail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  kakaoId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  counselTopic?: string;

  @IsOptional()
  @IsIn(['enrolled', 'on_leave', 'withdrawn', 'registration_lost', 'new_inquiry'])
  status?: StudentStatus;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'country는 ISO 3166-1 alpha-2 대문자 2자여야 합니다(예: KR·US·VN)' }) // [감사 H1] 임의 문자열 차단
  country?: string; // ISO alpha-2 — 시차·국가 필터

  @IsOptional()
  @IsString()
  @MaxLength(500)
  memo?: string;
}
