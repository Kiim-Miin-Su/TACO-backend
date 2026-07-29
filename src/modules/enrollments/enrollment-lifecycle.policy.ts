import { BadRequestException } from '@nestjs/common';
import type { Enrollment, UpdateEnrollmentInput } from '@kms545487/contracts';

type EnrollmentPatch = Omit<UpdateEnrollmentInput, 'reason'>;

export function enrollmentLifecyclePatch(
  current: Enrollment,
  input: UpdateEnrollmentInput,
  completedSessions: number,
): EnrollmentPatch {
  const reason = input.reason.trim();
  if (reason.length < 2) throw new BadRequestException('수강 변경 사유를 2자 이상 입력해 주세요.');

  const patch: EnrollmentPatch = {};
  if (input.status !== undefined) patch.status = input.status;
  if (input.startDate !== undefined) patch.startDate = input.startDate;
  if (input.endDate !== undefined) patch.endDate = input.endDate;
  if (input.totalSessions !== undefined) patch.totalSessions = input.totalSessions;
  if (input.memo !== undefined) patch.memo = input.memo?.trim() || null;

  if (!Object.keys(patch).length) throw new BadRequestException('변경할 수강 정보를 입력해 주세요.');

  const startDate = patch.startDate === undefined ? current.startDate : patch.startDate;
  const endDate = patch.endDate === undefined ? current.endDate : patch.endDate;
  if (startDate && endDate && endDate < startDate) {
    throw new BadRequestException('수강 종료일은 시작일보다 빠를 수 없습니다.');
  }

  const totalSessions = patch.totalSessions === undefined ? current.totalSessions : patch.totalSessions;
  if (totalSessions != null && totalSessions < completedSessions) {
    throw new BadRequestException(`총 회차는 이미 완료된 ${completedSessions}회보다 작을 수 없습니다.`);
  }

  if (Object.entries(patch).every(([key, value]) => current[key as keyof Enrollment] === value)) {
    throw new BadRequestException('현재 수강 정보와 동일합니다.');
  }
  return patch;
}
