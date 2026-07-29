import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import type { CreateCounselInput } from '@kms545487/contracts';
import { CounselInstantField } from '../counsel-instant';

// [참조/처리] POST /counsel — 내부 상담 접수 생성. 작성자/담당자는 JWT 주체로 확정한다.
// [보안 2026-07-07] 자유 텍스트 상한 — 스케줄 DTO와 통일(무제한 문자열 = 저장 남용/페이로드 비대 방지).
export const COUNSEL_TEXT = { referenceNotes: 2000 } as const;

export class CreateCounselDto implements Omit<CreateCounselInput, 'source' | 'submitterType' | 'assignedStaffId'> {
  @IsInt() studentId!: number;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.referenceNotes) referenceNotes?: string;
  @IsOptional() @CounselInstantField() nextContactAt?: string;
}
