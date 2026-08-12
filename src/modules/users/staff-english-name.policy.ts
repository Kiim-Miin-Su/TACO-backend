import { BadRequestException } from '@nestjs/common';
import {
  normalizeStaffEnglishName,
  staffEnglishNameError,
} from '@kms545487/contracts';

/** 직원 영문 이름의 백엔드 최종 방어. 모든 계정 쓰기 경로가 이 함수를 사용한다. */
export function requireStaffEnglishName(value: string | null | undefined): string {
  const input = value ?? '';
  const error = staffEnglishNameError(input);
  if (error) throw new BadRequestException(error);
  return normalizeStaffEnglishName(input);
}
