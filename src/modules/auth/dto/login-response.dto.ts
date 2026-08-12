import type { StaffLoginResult, StaffRole } from '@kms545487/contracts';
import { ApiProperty } from '@nestjs/swagger';

export class LoginAccountResponseDto {
  @ApiProperty({ example: 3 })
  id!: number;

  @ApiProperty({ example: '김민수' })
  name!: string;

  @ApiProperty({ example: 'Minsoo Kim' })
  englishName!: string;

  @ApiProperty({ enum: ['super_admin', 'admin', 'manager', 'instructor'] })
  role!: StaffRole;

  @ApiProperty({ description: 'true면 계정 보안 변경 외 업무 API가 차단된다.' })
  mustChangePassword!: boolean;
}

// [TBO-79 E5] 계약 결속 — accessToken은 non-production 전용이지만 wire에 존재하므로
//  StaffLoginResult가 이를 선언한다(종전엔 계약에 없어 FE가 볼 수 없었다).
export class LoginResponseDto implements StaffLoginResult {
  @ApiProperty({ description: 'Bearer access token. test/non-production 호환 응답이며 production에서는 HttpOnly cookie만 사용.', required: false })
  accessToken?: string;

  @ApiProperty({ type: LoginAccountResponseDto })
  account!: LoginAccountResponseDto;
}
