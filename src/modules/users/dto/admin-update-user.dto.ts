import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// [유저 관리 2026-07-20 대표 지시] 대표 직접 수정(상세 페이지) — name/phone/email/role만.
//  webId는 기존 profile-change(대표 즉시 적용·중복 체크) 경로 유지, 학력(대학·전공)은 강사
//  프로필 권위(E0.5 ④b 승계 규약)라 제외. 대상이 super_admin이면 서비스가 400(단일 불변식).
export class AdminUpdateUserDto {
  @ApiPropertyOptional({ description: '이름', minLength: 1, maxLength: 50 })
  @IsOptional() @IsString() @MinLength(1) @MaxLength(50)
  name?: string;

  @ApiPropertyOptional({ description: '전화번호(010-1234-5678)' })
  @IsOptional() @Matches(/^01[016789]-?\d{3,4}-?\d{4}$/, { message: '전화번호 형식이 올바르지 않습니다.' })
  phone?: string;

  @ApiPropertyOptional({ description: '이메일 — 변경 시 기존 세션 전부 무효(auth_version+1)' })
  @IsOptional() @IsEmail() @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ description: '역할 — 변경 시 기존 세션 전부 무효', enum: ['instructor', 'manager', 'admin'] })
  @IsOptional() @IsIn(['instructor', 'manager', 'admin'])
  role?: 'instructor' | 'manager' | 'admin';

  /** [TBO-87 겸직] 강사→manager/admin 승격 시 true면 강사원부(강사 활동)를 유지해 겸직으로 전환.
   *  담당 수업이 있어도 승격 가능(종전엔 원부 비활성 가드가 409로 차단). */
  @IsOptional()
  @IsBoolean()
  keepTeaching?: boolean;
}
