import type { UpdateReportTemplateInput } from '@kms545487/contracts';
import { CreateReportTemplateDto } from './create-report-template.dto';

// 템플릿 수정은 세 필드의 완전한 replacement다. create와 같은 runtime 검증을 상속해
// 빈 부분 PATCH가 기존 내용을 조용히 지우는 경로를 만들지 않는다.
export class UpdateReportTemplateDto extends CreateReportTemplateDto implements UpdateReportTemplateInput {}
