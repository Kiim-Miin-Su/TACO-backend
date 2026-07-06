import { IsIn, IsOptional, IsString } from 'class-validator';

// 대표 승인/반려 — 승인 시 역할을 변경(승격/지정)할 수 있음.
// [A1 2026-07-06] 대표 승인 액션 전용 — contracts 미승격(A1 제외).
export class ApproveDto {
  @IsOptional() @IsIn(['instructor', 'manager', 'admin', 'super_admin'])
  role?: string;

  @IsOptional() @IsString()
  reason?: string;
}
