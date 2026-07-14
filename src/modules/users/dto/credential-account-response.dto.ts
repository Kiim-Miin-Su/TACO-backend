import { ApiProperty } from '@nestjs/swagger';

export class CredentialAccountResponseDto {
  @ApiProperty({ example: 3 })
  id!: number;

  @ApiProperty({ example: 'ceo_owner' })
  webId!: string;

  @ApiProperty({ example: '김민수' })
  name!: string;

  @ApiProperty({ enum: ['super_admin', 'admin', 'manager', 'instructor'] })
  role!: string;

  @ApiProperty()
  mustChangePassword!: boolean;
}
