import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

// [E0.6 H1 2026-07-15] PATCH /reports/:id — 기존 보고서의 작성값 수정(임시 저장·제출 전 정정).
//  종전엔 update 경로가 없어 기존 보고서의 '임시 저장'이 조용히 유실됐다(감사 검출).
//  승인(approved) 후에는 불변(시수 반영) — 서비스가 400으로 차단.
export class UpdateReportDto {
  @ApiPropertyOptional({ example: '오늘 진도: 추론 문제 3세트. 정답률 향상.', description: '보고서 본문(진도·피드백)' })
  @IsOptional() @IsString() @MaxLength(4000)
  content?: string;

  @ApiPropertyOptional({ example: 'Vocab #6 PDF 단어 문장 만들기', description: '진도 페이지(선택 — 빈 문자열로 비움)' })
  @IsOptional() @IsString() @MaxLength(2000)
  progressPage?: string;

  @ApiPropertyOptional({ example: '워크북 12–15p', description: '숙제(선택 — 빈 문자열로 비움)' })
  @IsOptional() @IsString() @MaxLength(2000)
  homework?: string;
}
