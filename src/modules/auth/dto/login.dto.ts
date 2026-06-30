import { IsOptional, IsString, MaxLength } from 'class-validator';

// 로그인 입력 — 데모: webId로 계정 조회 후 토큰 발급. password는 받되 데모에선 검증 생략.
export class LoginDto {
  @IsString()
  @MaxLength(50)
  webId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  password?: string;
}
