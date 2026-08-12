type HistoricalChildRef = {
  child: string;
  field: string;
  row: Record<string, unknown>;
};

/**
 * Soft-delete된 부모를 참조해도 되는 명시적 역사 관계.
 * 학생 원부 삭제는 활성 수강을 canceled로 전이해 이력은 남기므로 해당 행은 고아가 아니다.
 */
export const allowsDeletedParentReference = ({ child, field, row }: HistoricalChildRef): boolean =>
  child === 'enrollments' && field === 'studentId' && row.status === 'canceled';
