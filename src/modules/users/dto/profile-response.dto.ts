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

  // [2026-07-16 SENS 활성화 준비] SMS 인증 가용 여부(provider env 완비) — FE 프로필 변경 모달이
  //  이 값으로 phone 인증 스테퍼를 동적으로 켠다(env 투입/제거만으로 BE·FE 동시 전환, 코드 수정 0).
  @ApiProperty({ example: false, description: 'SMS 인증 가용(provider env 완비) — phone 변경 스테퍼 동적 활성' })
  smsVerificationAvailable!: boolean;
}
