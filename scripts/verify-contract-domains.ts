/**
 * [TBO-79 F2] 계약 union ↔ DBML Enum 도메인 게이트.
 *
 * 왜 필요한가: `db:verify-schema-shape`는 **DBML ↔ 물리 DB**만 비교한다. contracts는 입력이
 * 아니어서, 계약이 물리 CHECK가 절대 허용하지 않는 값을 선언해도 "enum-domain drift 0"이
 * 초록으로 나온다. 실제로 `AccountRole`이 백오피스 users.role에 없는 'student' | 'parent'를
 * 계속 들고 있는데도 TBO-78 78C3이 drift 0으로 닫혔다(거짓 완료 FC-4).
 *
 * 이 스크립트는 DB 연결 없이 파일만 비교한다 — CI에서 자격증명 없이 돌릴 수 있고,
 * `verify-schema-shape`(DBML↔물리)와 체인을 이루면 계약↔물리 정합이 전이적으로 보장된다.
 *
 * 판정:
 *  · contractOnly — 계약에만 있는 값. DB가 만들 수 없는 상태를 UI/로직이 다루고 있다는 뜻이라
 *    보통 결함이다. 의도적이면 `allowContractOnly`에 사유와 함께 등록한다.
 *  · dbmlOnly     — DB에만 있는 값. 계약 소비자가 모르는 상태가 저장될 수 있다는 뜻이다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

type DomainBinding = {
  /** contracts에 선언된 union 타입 이름 */
  contract: string;
  /** docs/erd.dbml의 Enum 이름 */
  dbmlEnum: string;
  /** 계약에만 있어도 되는 값 + 사유(없으면 빈 객체) */
  allowContractOnly?: Record<string, string>;
  /** DBML에만 있어도 되는 값 + 사유 */
  allowDbmlOnly?: Record<string, string>;
};

const BINDINGS: DomainBinding[] = [
  {
    contract: 'AccountRole',
    dbmlEnum: 'user_role',
    allowContractOnly: {
      // [학생·학부모: 엔티티 유지·로그인 역할 없음] 재무·상담에서 엔티티로 쓰지만 로그인 역할은 없다.
      //  백오피스 users.role CHECK는 직원 4종만 허용한다 — 계약의 두 값은 로그인 계정이 아니다.
      student: '학생은 엔티티일 뿐 로그인 역할이 아니다 — users 행이 생기지 않는다',
      parent: '학부모는 엔티티일 뿐 로그인 역할이 아니다 — users 행이 생기지 않는다',
    },
  },
  { contract: 'StaffRole', dbmlEnum: 'user_role' },
  { contract: 'StaffAccountStatus', dbmlEnum: 'user_status' },
  { contract: 'AuthEventType', dbmlEnum: 'auth_event_type' },
  { contract: 'StudentStatus', dbmlEnum: 'student_status' },
  { contract: 'CounselStatus', dbmlEnum: 'counsel_status' },
  { contract: 'EnrollmentStatus', dbmlEnum: 'enrollment_status' },
  { contract: 'SessionStatus', dbmlEnum: 'session_status' },
  { contract: 'AttendanceStatus', dbmlEnum: 'attendance_status' },
  { contract: 'InstructorAttendanceStatus', dbmlEnum: 'instructor_attendance_status' },
  { contract: 'PaymentStatus', dbmlEnum: 'payment_status' },
  { contract: 'PayoutStatus', dbmlEnum: 'payout_status' },
  { contract: 'ScheduleRequestStatus', dbmlEnum: 'request_status' },
  { contract: 'ScheduleRequestKind', dbmlEnum: 'schedule_request_kind' },
];

const root = resolve(__dirname, '..');
const workspace = resolve(root, '..');

function contractsSource(): string {
  const dir = resolve(workspace, 'contracts/src');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(resolve(dir, name), 'utf8'))
    .join('\n');
}

/** `export type X = 'a' | 'b' | 'c';` 형태의 문자열 union만 읽는다(여러 줄 허용). */
function unionValues(source: string, typeName: string): string[] | null {
  const match = new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*([^;]+);`).exec(source);
  if (!match) return null;
  const body = match[1];
  // 문자열 리터럴이 하나도 없으면 union이 아니다(파생 타입 등) — 비교 대상 아님.
  const values = [...body.matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  return values.length ? [...new Set(values)].sort() : null;
}

function dbmlEnumValues(source: string, enumName: string): string[] | null {
  const match = new RegExp(`^Enum\\s+${enumName}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(source);
  if (!match) return null;
  return [...new Set(
    match[1]
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').replace(/\[[^\]]*\]/g, '').trim())
      .filter(Boolean),
  )].sort();
}

function main(): void {
  const contracts = contractsSource();
  const dbml = readFileSync(resolve(workspace, 'docs/erd.dbml'), 'utf8');
  const errors: string[] = [];
  const compared: Array<{ contract: string; dbmlEnum: string; values: number }> = [];
  const allowed: Array<{ contract: string; value: string; side: 'contract' | 'dbml'; reason: string }> = [];

  for (const binding of BINDINGS) {
    const contractValues = unionValues(contracts, binding.contract);
    if (!contractValues) {
      errors.push(`${binding.contract}: contracts/src에 문자열 union 선언을 찾지 못했습니다`);
      continue;
    }
    const dbmlValues = dbmlEnumValues(dbml, binding.dbmlEnum);
    if (!dbmlValues) {
      errors.push(`${binding.dbmlEnum}: docs/erd.dbml에 Enum 정의가 없습니다`);
      continue;
    }
    for (const value of contractValues.filter((entry) => !dbmlValues.includes(entry))) {
      const reason = binding.allowContractOnly?.[value];
      if (reason) allowed.push({ contract: binding.contract, value, side: 'contract', reason });
      else errors.push(`${binding.contract}.'${value}' 는 DBML Enum ${binding.dbmlEnum}에 없습니다 (DB가 만들 수 없는 상태)`);
    }
    for (const value of dbmlValues.filter((entry) => !contractValues.includes(entry))) {
      const reason = binding.allowDbmlOnly?.[value];
      if (reason) allowed.push({ contract: binding.contract, value, side: 'dbml', reason });
      else errors.push(`${binding.dbmlEnum}.'${value}' 는 계약 ${binding.contract}에 없습니다 (소비자가 모르는 상태가 저장될 수 있음)`);
    }
    compared.push({ contract: binding.contract, dbmlEnum: binding.dbmlEnum, values: contractValues.length });
  }

  console.log(JSON.stringify({
    ok: errors.length === 0,
    comparedBindings: compared.length,
    documentedExceptions: allowed,
    errors,
  }, null, 2));
  if (errors.length) process.exit(1);
}

main();
