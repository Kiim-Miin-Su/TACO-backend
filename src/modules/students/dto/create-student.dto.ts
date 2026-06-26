import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import type { CreateStudentInput } from '@taco/contracts';
import { ResidenceType, StudentStatus } from '../student.entity';

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
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  grade?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  schoolName?: string;

  @IsOptional()
  @IsIn(['domestic', 'overseas'])
  residenceType?: ResidenceType;

  @IsOptional()
  @IsIn(['lead', 'active', 'paused', 'completed', 'canceled'])
  status?: StudentStatus;

  @IsOptional()
  @IsString()
  memo?: string;
}
