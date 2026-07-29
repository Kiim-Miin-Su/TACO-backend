import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ProfileChangeRequest } from '@kms545487/contracts';

export class ProfileChangeRequestResponseDto implements ProfileChangeRequest {
  @ApiProperty() id!: number;
  @ApiProperty() requesterId!: number;
  @ApiProperty({ minimum: 1 }) baseProfileVersion!: number;
  @ApiProperty({ type: 'object', additionalProperties: true }) beforeValues!: Record<string, unknown>;
  @ApiProperty({ type: 'object', additionalProperties: true }) requestedChanges!: Record<string, unknown>;
  @ApiProperty({ minLength: 5, maxLength: 500 }) reason!: string;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] }) status!: ProfileChangeRequest['status'];
  @ApiPropertyOptional({ nullable: true }) decidedBy?: number | null;
  @ApiPropertyOptional({ nullable: true }) decidedAt?: string | null;
  @ApiPropertyOptional({ nullable: true }) rejectionReason?: string | null;
  @ApiPropertyOptional({ nullable: true, minimum: 2 }) appliedProfileVersion?: number | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
