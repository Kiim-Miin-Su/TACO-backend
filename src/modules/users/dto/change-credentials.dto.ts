import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChangeCredentialsDto {
  @ApiProperty({ writeOnly: true, maxLength: 72 })
  @IsString()
  @MaxLength(72)
  currentPassword!: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  newWebId?: string;

  @ApiPropertyOptional({ writeOnly: true, minLength: 8, maxLength: 72 })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword?: string;
}
