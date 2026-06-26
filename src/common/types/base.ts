/**
 * 공용 타입. 본 프로젝트는 기본적으로 `type`을 사용합니다.
 * (interface는 선언 병합(declaration merging)이나 클래스 implements 계약이
 *  필요한 경우에만 사용하고, 그럴 땐 해당 위치에 사유를 주석으로 남깁니다.)
 */

// 모든 in-memory 레코드의 공통 필드
export type BaseRow = {
  id: number;
  createdAt: string;
  updatedAt: string;
};
