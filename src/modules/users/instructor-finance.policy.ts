import { ForbiddenException } from '@nestjs/common';
import type { RoleCapability } from '@kms545487/contracts';

type InstructorPayInput = {
  defaultHourlyRate?: unknown;
};

/** 강사 원부 CRUD와 금액 권한을 분리한다. 운영 역할은 프로필을 관리하지만 시급은 대표만 변경한다. */
export function assertInstructorPayInputAllowed(
  input: InstructorPayInput,
  effectiveCapabilities: readonly RoleCapability[],
): void {
  if (input.defaultHourlyRate !== undefined && !effectiveCapabilities.includes('finance.access')) {
    throw new ForbiddenException('강사 기본 시급 변경은 재무 권한이 필요합니다.');
  }
}
