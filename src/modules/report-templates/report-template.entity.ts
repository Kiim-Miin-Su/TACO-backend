import type { ReportTemplate as ReportTemplateContract } from '@kms545487/contracts';
import type { BaseRow } from '../../database/in-memory.database';

// [자산화] 리포트 템플릿 — zustand(브라우저 세션 휘발)에서 DB 컬렉션으로 이관.
//  강사들이 공유하는 작성 표준 = 사내 자산(실DB 이관 시 report_templates 테이블).
export const REPORT_TEMPLATES = 'report_templates';
export type ReportTemplate = ReportTemplateContract & BaseRow;
