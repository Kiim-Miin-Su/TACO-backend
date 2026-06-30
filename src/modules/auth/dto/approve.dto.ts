import { IsIn, IsOptional, IsString } from 'class-validator';

// 대표 승인/반려 — 승인 시 역할을 변경(승격/지정)할 수 있음.
export class ApproveDto {
  @IsOptional() @IsIn(['instructor', 'manager', 'admin', 'super_admin'])
  role?: string;

  @IsOptional() @IsString()
  reason?: string;
}
