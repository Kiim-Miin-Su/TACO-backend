import { ApiProperty } from '@nestjs/swagger';

export class LoginAccountResponseDto {
  @ApiProperty({ example: 3 })
  id!: number;

  @ApiProperty({ example: '김민수' })
  name!: string;

  @ApiProperty({ enum: ['super_admin', 'admin', 'manager', 'instructor'] })
  role!: string;

  @ApiProperty({ description: 'true면 계정 보안 변경 외 업무 API가 차단된다.' })
  mustChangePassword!: boolean;
}

export class LoginResponseDto {
  @ApiProperty({ description: 'Bearer access token' })
  accessToken!: string;

  @ApiProperty({ type: LoginAccountResponseDto })
  account!: LoginAccountResponseDto;
}
