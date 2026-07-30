import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { StaffAccountStatus, StaffProfile, StaffRole } from '@kms545487/contracts';

// [TBO-79 E5] 계약을 implements — 종전엔 연결이 없어 role/status가 계약의 union이 아니라 string이었고,
//  emailVerified·smsVerificationAvailable의 optional 여부가 계약과 반대였다(FE가 불필요한 null 체크).
export class ProfileResponseDto implements StaffProfile {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'instructor01' })
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
  role!: StaffRole;

  @ApiProperty({ enum: ['pending', 'active', 'rejected'] })
  status!: StaffAccountStatus;

  // [TBO-31 C1 D5] 마이페이지 이메일 인증 상태 배지 — 미인증이면 계정 보안 이동 안내(FE C3).
  @ApiProperty({ example: true, description: '이메일 인증 완료 여부(가입 OTP 또는 잔존 링크 인증)' })
  emailVerified!: boolean;

  @ApiProperty({ example: 1, minimum: 1 })
  profileVersion!: number;

  // [2026-07-16 SENS 활성화 준비] SMS 인증 가용 여부(provider env 완비) — FE 프로필 변경 모달이
  //  이 값으로 phone 인증 스테퍼를 동적으로 켠다(env 투입/제거만으로 BE·FE 동시 전환, 코드 수정 0).
  @ApiProperty({ example: false, description: 'SMS 인증 가용(provider env 완비) — phone 변경 스테퍼 동적 활성' })
  smsVerificationAvailable!: boolean;
}
