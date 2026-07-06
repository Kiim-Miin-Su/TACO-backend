/**
 * 공용 타입. 본 프로젝트는 기본적으로 `type`을 사용합니다.
 * (interface는 선언 병합(declaration merging)이나 클래스 implements 계약이
 *  필요한 경우에만 사용하고, 그럴 땐 해당 위치에 사유를 주석으로 남깁니다.)
 */

// 모든 in-memory 레코드의 공통 필드
// [v9 soft delete — TBO-16] deletedAt(null/undefined=활성)·deletedBy(users FK).
//  삭제 = 행 제거가 아닌 마킹(erd.dbml v9 §31). 조회는 DB 계층에서 기본 제외.
//  예외(원장 transactions·audit_log)는 서비스에서 remove를 호출하지 않는 방식으로 보장.
export type BaseRow = {
  id: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  deletedBy?: number | null;
};
