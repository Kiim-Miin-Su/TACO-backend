import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateStudentDto } from '../../students/dto/create-student.dto';

// [TBO-29D D2] 원자 등록 command 입력 — 학생(필수) + 보호자(선택) + 수강(선택)을 한 요청·한 tx로.
//  학생/보호자에 webId 없음(로그인 계정 아님 — 29A 계약). 보호자 기본값: 대표(primary)·납부자(payer).
export class RegistrationGuardianDto {
  @ApiProperty({ example: '김학부모', description: '보호자 이름' })
  @IsString()
  @MaxLength(20)
  name!: string;

  @ApiPropertyOptional({ example: '010-1234-5678', description: '연락처 — 같은 번호는 기존 보호자에 연결(upsert-or-link)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ example: '모', description: '학생과의 관계(모/부/조모 등 자유 문자열)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  relation?: string;

  @ApiPropertyOptional({ description: '납부자 여부(기본 true)' })
  @IsOptional()
  @IsBoolean()
  isPayer?: boolean;

  @ApiPropertyOptional({ description: '대표 보호자 여부(기본 true — 기존 대표는 자동 강등)' })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class RegisterStudentDto {
  @ApiProperty({ type: CreateStudentDto, description: '학생 정보(기존 POST /students와 동일 필드)' })
  @ValidateNested()
  @Type(() => CreateStudentDto)
  student!: CreateStudentDto;

  @ApiPropertyOptional({ type: RegistrationGuardianDto, description: '보호자 — 있으면 parent+관계를 같은 tx로 생성/연결' })
  @IsOptional()
  @ValidateNested()
  @Type(() => RegistrationGuardianDto)
  guardian?: RegistrationGuardianDto;

  @ApiPropertyOptional({ example: 10, description: '수강 코스 — 있으면 enrollment를 같은 tx로 생성' })
  @IsOptional()
  @IsInt()
  @Min(1)
  courseId?: number;
}
