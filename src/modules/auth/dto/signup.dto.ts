import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const SIGNUP_ROLES = ['instructor', 'manager', 'admin'];

// 가입 신청 — super_admin은 신청 불가(대표가 승인하는 구조). 비밀번호 8자 이상.
export class SignupDto {
  @IsString() @MinLength(3) @MaxLength(50)
  webId!: string;

  @IsString() @MinLength(1) @MaxLength(50)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString() @MinLength(8) @MaxLength(100)
  password!: string;

  @IsOptional() @IsIn(SIGNUP_ROLES)
  role?: string;
}
