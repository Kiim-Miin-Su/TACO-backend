import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  AvailabilityImpact,
  AvailabilityImpactConflict,
  AvailabilityImpactResponse,
} from '@kms545487/contracts';

export class AvailabilityImpactDto implements AvailabilityImpact {
  @ApiProperty() sessionId!: number;
  @ApiProperty({ format: 'date' }) sessionDate!: string;
  @ApiPropertyOptional() startTime?: string;
  @ApiPropertyOptional() endTime?: string;
  @ApiPropertyOptional() instructorId?: number;
  @ApiPropertyOptional() instructorName?: string;
  @ApiPropertyOptional() courseId?: number;
  @ApiPropertyOptional() topic?: string;
  @ApiProperty({ enum: ['available_removed', 'unavailable_overlap', 'online_only_overlap'] })
  reason!: AvailabilityImpact['reason'];
}

export class AvailabilityImpactResponseDto implements AvailabilityImpactResponse {
  @ApiProperty({ type: [AvailabilityImpactDto] })
  impactedSessions!: AvailabilityImpactDto[];
}

export class AvailabilityImpactConflictResponseDto
  extends AvailabilityImpactResponseDto
  implements AvailabilityImpactConflict
{
  @ApiProperty() message!: string;
  @ApiProperty({ enum: [true] }) approvalRequired!: true;
}
