import { Type } from 'class-transformer';
import { IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { CreateStudentCounselIntakeInput } from '@kms545487/contracts';
import { CounselInstantField } from '../../counsel/counsel-instant';
import { COUNSEL_TEXT } from '../../counsel/dto/create-counsel.dto';
import { RegisterStudentDto } from './register-student.dto';

type NewStudentCounselInput = CreateStudentCounselIntakeInput['counsel'];

export class NewStudentCounselDto implements NewStudentCounselInput {
  @ApiPropertyOptional({ maxLength: COUNSEL_TEXT.referenceNotes, description: '상담 내용' })
  @IsOptional()
  @IsString()
  @MaxLength(COUNSEL_TEXT.referenceNotes)
  referenceNotes?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: '다음 상담 예정 instant. 생략하면 일정 미정',
  })
  @IsOptional()
  @CounselInstantField()
  nextContactAt?: string;
}

/** 신규 학생 aggregate와 첫 상담을 한 transaction으로 생성한다. studentId는 서버가 결합한다. */
export class RegisterStudentWithCounselDto implements CreateStudentCounselIntakeInput {
  @ApiProperty({ type: RegisterStudentDto })
  @ValidateNested()
  @Type(() => RegisterStudentDto)
  registration!: RegisterStudentDto;

  @ApiProperty({ type: NewStudentCounselDto })
  @ValidateNested()
  @Type(() => NewStudentCounselDto)
  counsel!: NewStudentCounselDto;
}
