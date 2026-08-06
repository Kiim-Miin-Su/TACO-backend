import { ApiProperty } from '@nestjs/swagger';
import type {
  Attendance,
  Conflict,
  HistoricalCompletedSessionResult,
  ScheduleRow,
} from '@kms545487/contracts';

class HistoricalCompletedSessionRowDto {
  @ApiProperty({ example: 37 }) id!: number;
  @ApiProperty({ example: 10 }) courseId!: number;
  @ApiProperty({ example: 1 }) instructorId!: number;
  @ApiProperty({ type: [Number], example: [1, 2] }) studentIds!: number[];
  @ApiProperty({ example: '2026-07-16' }) sessionDate!: string;
  @ApiProperty({ example: '13:00' }) startTime!: string;
  @ApiProperty({ example: 90 }) durationMinutes!: number;
  @ApiProperty({ enum: ['held'], example: 'held' }) status!: 'held';
  @ApiProperty({ enum: ['present'], example: 'present' }) instructorAttendance!: 'present';
}

class HistoricalCompletedAttendanceDto {
  @ApiProperty({ example: 101 }) id!: number;
  @ApiProperty({ example: 37 }) sessionId!: number;
  @ApiProperty({ example: 1 }) studentId!: number;
  @ApiProperty({ enum: ['present'], example: 'present' }) status!: 'present';
}

class HistoricalCompletedConflictDto {
  @ApiProperty({ example: 'instructor_overlap' }) type!: string;
  @ApiProperty({ example: 'instructor' }) resource!: string;
  @ApiProperty({ example: 1 }) resourceId!: number;
  @ApiProperty({ required: false, example: '기존 수업과 시간이 겹칩니다.' }) detail?: string;
}

export class HistoricalCompletedScheduleResponseDto implements HistoricalCompletedSessionResult {
  @ApiProperty({ type: HistoricalCompletedSessionRowDto }) row!: ScheduleRow;
  @ApiProperty({ type: HistoricalCompletedConflictDto, isArray: true }) conflicts!: Conflict[];
  @ApiProperty({ type: HistoricalCompletedAttendanceDto, isArray: true }) attendance!: Attendance[];
}
