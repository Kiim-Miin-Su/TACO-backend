import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { StaffAccountStatus, StaffAccountSummary, StaffRole } from '@kms545487/contracts';

export class StaffAccountResponseDto implements StaffAccountSummary {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'manager01' })
  webId!: string;

  @ApiProperty({ example: '이지원' })
  name!: string;

  @ApiProperty({ example: 'Jiwon Lee', description: '학부모 전달용 영문 이름' })
  englishName!: string;

  @ApiPropertyOptional({ example: 'manager@tnacademy.test', nullable: true })
  email?: string | null;

  @ApiPropertyOptional({ example: '010-1234-5678', nullable: true })
  phone?: string | null;

  @ApiProperty({ enum: ['instructor', 'manager', 'admin', 'super_admin'] })
  role!: StaffRole;

  @ApiProperty({ enum: ['pending', 'active', 'rejected'] })
  status!: StaffAccountStatus;

  @ApiProperty({ example: true })
  emailVerified!: boolean;

  @ApiProperty({ example: 1, minimum: 1 })
  profileVersion!: number;

  @ApiPropertyOptional({ example: 'KR', nullable: true })
  countryCode?: string | null;

  @ApiPropertyOptional({ example: 'Asia/Seoul', nullable: true })
  timeZone?: string | null;

  @ApiPropertyOptional({ example: '서울대학교', nullable: true })
  university?: string | null;

  @ApiPropertyOptional({ example: '수학교육', nullable: true })
  major?: string | null;

  @ApiPropertyOptional({ example: 1992, nullable: true })
  birthYear?: number | null;

  @ApiPropertyOptional({ example: '199201-1******', nullable: true, description: '대표 상세·승인 조회에서만 제공' })
  rrnMasked?: string | null;

  @ApiProperty({ example: '2026-07-29T00:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-07-29T00:00:00.000Z' })
  updatedAt!: string;

  @ApiPropertyOptional({ example: null, nullable: true })
  deletedAt?: string | null;
}
