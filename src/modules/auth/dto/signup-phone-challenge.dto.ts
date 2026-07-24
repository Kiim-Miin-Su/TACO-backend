import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

// [TBO-57] 가입 전 휴대전화 OTP — 공개 엔드포인트 DTO. E.164 정규화·쿨다운·시도 한도는
//  SignupPhoneChallengesService가 권위 수행(여기 검증은 UX 방어 — 가입 폼 전화 형식과 동일 허용폭).
export class CreateSignupPhoneChallengeDto {
  @ApiProperty({ example: '010-1234-5678', maxLength: 20, description: '가입에 사용할 휴대전화(소유 인증 대상)' })
  @IsString() @MinLength(9) @MaxLength(20) @Matches(/^[\d+\-\s]+$/, { message: '전화번호는 숫자·하이픈만 입력해 주세요.' })
  phone!: string;
}

export class ConfirmSignupPhoneChallengeDto {
  @ApiProperty({ example: '010-1234-5678', maxLength: 20, description: '발송을 요청한 휴대전화(일치 필수)' })
  @IsString() @MinLength(9) @MaxLength(20) @Matches(/^[\d+\-\s]+$/, { message: '전화번호는 숫자·하이픈만 입력해 주세요.' })
  phone!: string;

  @ApiProperty({ description: '수신한 인증 코드(6자리 숫자)', minLength: 4, maxLength: 10 })
  @IsString() @MinLength(4) @MaxLength(10) @Matches(/^\d+$/)
  code!: string;
}
