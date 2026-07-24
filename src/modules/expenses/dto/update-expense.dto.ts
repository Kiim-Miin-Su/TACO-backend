// [TBO-58 P2 2026-07-24] 지출 수정 DTO — 대표 지시 "requested 지출의 금액·항목 수정"(오기입 정정).
//  create와 동일 검증을 전 필드 optional로(PartialType — class-validator 메타 보존).
//  status는 받지 않는다(승인/반려/철회는 전용 명령 — 상태 전이 우회 차단, mass-assignment 방어는
//  전역 whitelist+forbidNonWhitelisted가 이중으로 막는다).
import { PartialType } from '@nestjs/swagger';
import { CreateExpenseDto } from './create-expense.dto';

export class UpdateExpenseDto extends PartialType(CreateExpenseDto) {}
