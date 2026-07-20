import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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
