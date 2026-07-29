import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  SessionAccountingImpact,
  SessionAccountingImpactConflict,
  SessionAccountingProjection,
} from '@kms545487/contracts';

export class SessionAccountingProjectionResponseDto implements SessionAccountingProjection {
  @ApiProperty() teachingMinutes!: number;
  @ApiProperty() payoutEligibleMinutes!: number;
  @ApiProperty() computedAmount!: number;
}

export class SessionAccountingImpactResponseDto implements SessionAccountingImpact {
  @ApiProperty() changed!: boolean;
  @ApiPropertyOptional({ nullable: true }) payoutId?: number | null;
  @ApiProperty({ type: SessionAccountingProjectionResponseDto })
  before!: SessionAccountingProjectionResponseDto;
  @ApiProperty({ type: SessionAccountingProjectionResponseDto })
  after!: SessionAccountingProjectionResponseDto;
  @ApiProperty({ type: SessionAccountingProjectionResponseDto })
  delta!: SessionAccountingProjectionResponseDto;
}

export class SessionAccountingImpactConflictResponseDto implements SessionAccountingImpactConflict {
  @ApiProperty({ enum: ['ACCOUNTING_IMPACT_ACK_REQUIRED', 'PAYOUT_REVERSAL_REQUIRED'] })
  code!: SessionAccountingImpactConflict['code'];
  @ApiProperty() message!: string;
  @ApiProperty({ type: SessionAccountingImpactResponseDto })
  impact!: SessionAccountingImpactResponseDto;
  @ApiPropertyOptional() impactHash?: string;
  @ApiPropertyOptional({ type: [Number] }) sessionIds?: number[];
}
