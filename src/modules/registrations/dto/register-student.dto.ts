import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { CreateStudentAggregateInput } from '@kms545487/contracts';
import { CreateStudentDto } from '../../students/dto/create-student.dto';
import { StudentInterestDto } from '../../students/dto/student-interest.dto';
import { CreateStudentFamilyRelationDto } from '../../students/dto/student-family-relation.dto';

// [TBO-29D D2] 원자 등록 command 입력 — 학생(필수) + 보호자(선택) + 수강(선택)을 한 요청·한 tx로.
//  학생/보호자에 webId 없음(로그인 계정 아님 — 29A 계약). 보호자 기본값: 대표(primary)·납부자(payer).
export class RegistrationGuardianDto {
  @ApiProperty({ example: '김학부모', description: '보호자 이름' })
  @IsString()
  @Matches(/\S/, { message: 'name must contain a non-whitespace character' })
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

export class RegisterStudentDto implements CreateStudentAggregateInput {
  @ApiProperty({ type: CreateStudentDto, description: '학생 정보(기존 POST /students와 동일 필드)' })
  @ValidateNested()
  @Type(() => CreateStudentDto)
  student!: CreateStudentDto;

  @ApiPropertyOptional({ type: [StudentInterestDto], minItems: 0, maxItems: 20, description: '관심 희망 수업(선택, 0~20개)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => StudentInterestDto)
  interests?: StudentInterestDto[];

  @ApiPropertyOptional({ type: [RegistrationGuardianDto], maxItems: 10, description: '보호자 0~10명' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => RegistrationGuardianDto)
  guardians?: RegistrationGuardianDto[];

  @ApiPropertyOptional({ type: RegistrationGuardianDto, deprecated: true, description: 'v0.2.5 호환 단건 보호자. guardians와 동시 사용 금지' })
  @IsOptional()
  @ValidateNested()
  @Type(() => RegistrationGuardianDto)
  guardian?: RegistrationGuardianDto;

  @ApiPropertyOptional({ example: 10, description: '수강 코스 — 있으면 enrollment를 같은 tx로 생성' })
  @IsOptional()
  @IsInt()
  @Min(1)
  courseId?: number;

  // [TBO-86I-4] 등록 시점 "기존에 다니는 가족" 연결 — 상세 화면 가족 추가와 같은 DTO·검증·audit
  //  규칙을 재사용하고, 학생·보호자·수강과 **같은 등록 tx**에서 생성한다(중간 실패 시 전부 rollback).
  @ApiPropertyOptional({ type: [CreateStudentFamilyRelationDto], maxItems: 10, description: '기존 재원생과의 가족 관계 0~10건 — 같은 tx 원자 생성' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CreateStudentFamilyRelationDto)
  familyRelations?: CreateStudentFamilyRelationDto[];
}
