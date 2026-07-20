import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsInt, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';

// [TBO-31 C1 D1] 가입 전 이메일 OTP — 공개 엔드포인트 DTO. canonical 정규화·쿨다운·시도 한도는
//  SignupEmailChallengesService가 권위 수행(여기 검증은 UX 방어).
export class CreateSignupEmailChallengeDto {
  @ApiProperty({ example: 'applicant@example.com', maxLength: 320, description: '가입에 사용할 이메일(소유 인증 대상)' })
  @IsEmail() @MaxLength(320)
  email!: string;
}

export class ConfirmSignupEmailChallengeDto {
  @ApiProperty({ example: 'applicant@example.com', maxLength: 320, description: '발송을 요청한 이메일(일치 필수)' })
  @IsEmail() @MaxLength(320)
  email!: string;

  @ApiProperty({ description: '수신한 인증 코드(6자리 숫자)', minLength: 4, maxLength: 10 })
  @IsString() @MinLength(4) @MaxLength(10) @Matches(/^\d+$/)
  code!: string;
}

// [TBO-31 C5 D9] 비로그인 복구 OTP DTO — 발송/확인은 위 두 DTO를 재사용(recovery 라우트가 purpose만
//  다르게 서비스에 전달). 아래는 인증 완료 후 완료 단계 전용.
export class CompleteRecoverIdDto {
  @ApiProperty({ description: '인증 완료된 recovery challenge id' })
  @IsInt() @Min(1)
  challengeId!: number;

  @ApiProperty({ example: 'staff@tnacademy.test', maxLength: 320, description: '인증한 이메일(일치 필수)' })
  @IsEmail() @MaxLength(320)
  email!: string;
}

export class ResetPasswordOtpDto {
  @ApiProperty({ description: '인증 완료된 recovery challenge id' })
  @IsInt() @Min(1)
  challengeId!: number;

  @ApiProperty({ example: 'staff01', maxLength: 50, description: '아이디 — 이메일과 함께 일치해야 변경' })
  @IsString() @MinLength(1) @MaxLength(50)
  webId!: string;

  @ApiProperty({ example: 'staff@tnacademy.test', maxLength: 320, description: '인증한 이메일(일치 필수)' })
  @IsEmail() @MaxLength(320)
  email!: string;

  @ApiProperty({ writeOnly: true, minLength: 8, maxLength: 72, description: '새 비밀번호(8~72바이트)' })
  @IsString() @MinLength(8) @MaxLength(72)
  newPassword!: string;
}
