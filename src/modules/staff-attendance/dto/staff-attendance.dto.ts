import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type {
  DeleteStaffAttendanceInput,
  InstructorAttendanceLedgerQuery,
  StaffAttendanceQuery,
  StaffAttendanceStatus,
  UpsertStaffAttendanceInput,
} from '@kms545487/contracts';
import { TEXT } from '../../../common/validation-limits';
import { STAFF_ATTENDANCE_STATUSES } from '../staff-attendance.entity';

export class UpsertStaffAttendanceDto implements UpsertStaffAttendanceInput {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  staffId!: number;

  @IsDateString({ strict: true })
  workDate!: string;

  @IsIn(STAFF_ATTENDANCE_STATUSES)
  status!: StaffAttendanceStatus;

  @IsOptional()
  @IsDateString({ strict: true })
  checkInAt?: string | null;

  @IsOptional()
  @IsDateString({ strict: true })
  checkOutAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.memo)
  memo?: string | null;
}

export class DeleteStaffAttendanceDto implements DeleteStaffAttendanceInput {
  @IsString()
  @MinLength(2)
  @MaxLength(TEXT.memo)
  reason!: string;
}

export class ListStaffAttendanceQueryDto implements StaffAttendanceQuery {
  @IsDateString({ strict: true })
  from!: string;

  @IsDateString({ strict: true })
  to!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  staffId?: number;

  @IsOptional()
  @IsIn(STAFF_ATTENDANCE_STATUSES)
  status?: StaffAttendanceStatus;
}

export class InstructorAttendanceLedgerQueryDto implements InstructorAttendanceLedgerQuery {
  @IsDateString({ strict: true })
  from!: string;

  @IsDateString({ strict: true })
  to!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  instructorId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  subjectId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

