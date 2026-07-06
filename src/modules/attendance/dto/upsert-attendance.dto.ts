import { IsIn, IsInt, Min } from 'class-validator';
import { AttendanceStatus } from '../attendance.entity';

// [참조/처리] PUT /attendance 바디. (sessionId, studentId)로 upsert, status는 계약 유니온 검사.
const STATUSES: AttendanceStatus[] = ['present', 'late', 'absent', 'excused'];

// [A1 2026-07-06] (session,student,status) 3필드 upsert — 계약 승격 실익 낮음 판정(2026-07-03 백로그, A1 제외).
export class UpsertAttendanceDto {
  @IsInt()
  @Min(1)
  sessionId!: number;

  @IsInt()
  @Min(1)
  studentId!: number;

  @IsIn(STATUSES)
  status!: AttendanceStatus;
}
