import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProfileResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'park_inst' })
  webId!: string;

  @ApiProperty({ example: '박지훈' })
  name!: string;

  @ApiPropertyOptional({ example: 'park@tnacademy.test', nullable: true })
  email?: string | null;

  @ApiPropertyOptional({ example: '+82-10-1234-5678', nullable: true })
  phone?: string | null;

  @ApiPropertyOptional({ example: 'KR', nullable: true })
  countryCode?: string | null;

  @ApiPropertyOptional({ example: 'Asia/Seoul', nullable: true })
  timeZone?: string | null;

  @ApiProperty({ enum: ['instructor', 'manager', 'admin', 'super_admin'] })
  role!: string;

  @ApiProperty({ enum: ['pending', 'active', 'rejected'] })
  status!: string;

  @ApiProperty({ example: 1, minimum: 1 })
  profileVersion!: number;
}
