import type { ReportTemplate as ReportTemplateContract } from '@kms545487/contracts';
import type { BaseRow } from '../../database/in-memory.database';

// [자산화] 리포트 템플릿 — zustand(브라우저 세션 휘발)에서 DB 컬렉션으로 이관.
//  createdBy가 있는 행은 작성자/관리자만 변경하고, null 레거시·기본 템플릿은 관리자만 변경한다.
export const REPORT_TEMPLATES = 'report_templates';
export type ReportTemplate = ReportTemplateContract & BaseRow;
