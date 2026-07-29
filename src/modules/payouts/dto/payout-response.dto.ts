import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  BulkGeneratePayoutResult,
  PayoutLine,
  PayoutMeasure,
  PayoutWorksheet,
  PayoutWorksheetParticipant,
  PayoutWorksheetPricing,
  PayoutWorksheetRow,
  PayoutWorksheetTotals,
} from '@kms545487/contracts';

export class PayoutLineResponseDto implements PayoutLine {
  @ApiProperty() sessionId!: number;
  @ApiProperty() courseId!: number;
  @ApiProperty() courseName!: string;
  @ApiProperty({ format: 'date' }) sessionDate!: string;
  @ApiProperty() durationMinutes!: number;
  @ApiProperty() hourlyRate!: number;
  @ApiProperty() amount!: number;
}

export class PayoutMeasureResponseDto implements PayoutMeasure {
  @ApiProperty() instructorId!: number;
  @ApiProperty({ format: 'date' }) periodStart!: string;
  @ApiProperty({ format: 'date' }) periodEnd!: string;
  @ApiProperty() sessionCount!: number;
  @ApiProperty() totalMinutes!: number;
  @ApiProperty() computedAmount!: number;
  @ApiProperty({ type: [PayoutLineResponseDto] }) lines!: PayoutLineResponseDto[];
}

export class PayoutWorksheetPricingResponseDto implements PayoutWorksheetPricing {
  @ApiProperty({ enum: ['auto', 'manual', 'excluded'] })
  kind!: PayoutWorksheetPricing['kind'];

  @ApiProperty({
    isArray: true,
    enum: ['late', 'attendance_missing', 'report_incomplete', 'roster_missing', 'rate_missing'],
  })
  manualReasons!: PayoutWorksheetPricing['manualReasons'];

  @ApiPropertyOptional({ enum: ['not_held', 'instructor_absent', 'payout_linked'] })
  excludedReason?: PayoutWorksheetPricing['excludedReason'];

  @ApiProperty({ nullable: true }) autoAmount!: number | null;
  @ApiProperty({ nullable: true }) overrideAmount!: number | null;
  @ApiProperty({ nullable: true }) effectiveAmount!: number | null;
}

export class PayoutWorksheetParticipantResponseDto implements PayoutWorksheetParticipant {
  @ApiProperty() studentId!: number;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) attendance!: string | null;
  @ApiProperty({ nullable: true }) reportId!: number | null;
  @ApiProperty({ nullable: true }) reportApproval!: string | null;
}

export class PayoutWorksheetRowResponseDto implements PayoutWorksheetRow {
  @ApiProperty() sessionId!: number;
  @ApiProperty({ format: 'date' }) sessionDate!: string;
  @ApiProperty({ nullable: true }) startTime!: string | null;
  @ApiProperty() durationMinutes!: number;
  @ApiProperty() courseId!: number;
  @ApiProperty() courseName!: string;
  @ApiProperty({ nullable: true }) subjectId!: number | null;
  @ApiProperty() subjectName!: string;
  @ApiProperty({ nullable: true }) hourlyRate!: number | null;
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true }) instructorAttendance!: string | null;
  @ApiProperty({ nullable: true }) payoutId!: number | null;
  @ApiProperty({ type: [PayoutWorksheetParticipantResponseDto] })
  participants!: PayoutWorksheetParticipantResponseDto[];
  @ApiProperty({ type: PayoutWorksheetPricingResponseDto })
  pricing!: PayoutWorksheetPricingResponseDto;
}

export class PayoutWorksheetTotalsResponseDto implements PayoutWorksheetTotals {
  @ApiProperty() sessionCount!: number;
  @ApiProperty() includedCount!: number;
  @ApiProperty() totalMinutes!: number;
  @ApiProperty() autoAmount!: number;
  @ApiProperty() manualAmount!: number;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() unpricedCount!: number;
  @ApiProperty() excludedCount!: number;
}

export class PayoutWorksheetResponseDto implements PayoutWorksheet {
  @ApiProperty() instructorId!: number;
  @ApiProperty({ format: 'date' }) periodStart!: string;
  @ApiProperty({ format: 'date' }) periodEnd!: string;
  @ApiProperty({ type: [PayoutWorksheetRowResponseDto] }) rows!: PayoutWorksheetRowResponseDto[];
  @ApiProperty({ type: PayoutWorksheetTotalsResponseDto }) totals!: PayoutWorksheetTotalsResponseDto;
}

class GeneratedPayoutResponseDto {
  @ApiProperty() instructorId!: number;
  @ApiProperty() payoutId!: number;
  @ApiProperty() amount!: number;
  @ApiProperty() sessionCount!: number;
}

class SkippedPayoutResponseDto {
  @ApiProperty() instructorId!: number;
  @ApiProperty() reason!: string;
}

class FailedPayoutResponseDto {
  @ApiProperty() instructorId!: number;
  @ApiProperty() error!: string;
}

export class BulkGeneratePayoutResponseDto implements BulkGeneratePayoutResult {
  @ApiProperty({ type: [GeneratedPayoutResponseDto] })
  generated!: GeneratedPayoutResponseDto[];
  @ApiProperty({ type: [SkippedPayoutResponseDto] })
  skipped!: SkippedPayoutResponseDto[];
  @ApiProperty({ type: [FailedPayoutResponseDto] })
  failed!: FailedPayoutResponseDto[];
}
