import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Matches, Min } from 'class-validator';
import type {
  ReportApprovalStatus,
  ReportListQuery,
  ReportStatus,
  ReportWorklistQuery,
} from '@kms545487/contracts';
import { parsePositiveInt } from '../../../common/positive-int.pipe';

const REPORT_STATUSES: ReportStatus[] = ['draft', 'submitted', 'sent'];
const APPROVAL_STATUSES: ReportApprovalStatus[] = ['draft', 'submitted', 'approved', 'rejected'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PositiveQueryId = () => Transform(({ value }) => value === undefined ? undefined : parsePositiveInt(value));

export class ListReportsQueryDto implements ReportListQuery {
  @IsOptional() @PositiveQueryId() @IsInt() @Min(1)
  sessionId?: number;

  @IsOptional() @Matches(ISO_DATE) @IsDateString({ strict: true })
  from?: string;

  @IsOptional() @Matches(ISO_DATE) @IsDateString({ strict: true })
  to?: string;

  @IsOptional() @PositiveQueryId() @IsInt() @Min(1)
  studentId?: number;

  @IsOptional() @PositiveQueryId() @IsInt() @Min(1)
  subjectId?: number;

  @IsOptional() @PositiveQueryId() @IsInt() @Min(1)
  instructorId?: number;

  @IsOptional() @IsIn(REPORT_STATUSES)
  status?: ReportStatus;

  @IsOptional() @IsIn(APPROVAL_STATUSES)
  approvalStatus?: ReportApprovalStatus;
}

export class ReportWorklistQueryDto implements ReportWorklistQuery {
  @IsOptional() @Matches(ISO_DATE) @IsDateString({ strict: true })
  from?: string;

  @IsOptional() @Matches(ISO_DATE) @IsDateString({ strict: true })
  to?: string;

  @IsOptional() @PositiveQueryId() @IsInt() @Min(1)
  studentId?: number;

  @IsOptional() @PositiveQueryId() @IsInt() @Min(1)
  subjectId?: number;

  @IsOptional() @PositiveQueryId() @IsInt() @Min(1)
  instructorId?: number;
}
