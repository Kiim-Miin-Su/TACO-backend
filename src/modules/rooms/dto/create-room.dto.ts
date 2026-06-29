import { IsBoolean, IsHexColor, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { CreateRoomInput } from '@kms545487/contracts';

export class CreateRoomDto implements CreateRoomInput {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsInt()
  buildingId?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  capacity?: number;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
