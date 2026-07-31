// [TBO-80 80C = TBO-79 A4] 코호트 판정 사본 탐지 게이트.
//
// 배경: `session-participant.policy.ts`는 "정책 변경 시 이 파일의 두 구현을 함께 고칠 것
// (단일 소스 유지 — 다른 곳에 사본 금지)"를 코드 주석으로 못박았지만, 강제 장치가 없어
// FC-1(TBO-79 — enrollments.service의 인라인 재구현이 활성 필터를 누락해 비활성 수강까지
// 강사에게 노출)이 실제로 일어났다. 이 게이트는 그 부류의 재발을 기계적으로 차단한다.
//
// 규칙 1(구조): `studentIds`와 enrollment를 함께 만지는 파일은 코호트 판정 SSOT
//   (`session-participant.policy` 또는 계약 `resolveSessionParticipantIds`)를 import하거나,
//   판정을 하지 않는 이유가 명기된 allowlist에 있어야 한다.
// 규칙 2(문자): enrollment 행에 대한 `status === 'active'` 인라인 필터(FC-1·80C 실증 시그니처)는
//   정책 파일과 enrollment lifecycle 소유자 밖에서 금지한다.
//
// 한계: 문자열·경로 휴리스틱이다 — "통과 = 사본 0 증명"이 아니라 **알려진 사본 패턴의 재발 차단**이
// 목적이다(80C에서 students.service의 실사본을 이 규칙으로 잡아 교정했다). 새 우회 형태를 발견하면
// 시그니처를 추가하고, allowlist에는 반드시 "왜 판정이 아닌지" 한 줄 사유를 남긴다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(__dirname, '..', 'src');
const POLICY_MARKERS = ['session-participant.policy', 'resolveSessionParticipantIds'];
const POLICY_FILE = 'src/modules/schedule/session-participant.policy.ts';

// 규칙 1 allowlist — "studentIds+enrollment 동시 참조지만 코호트 판정이 아닌" 파일과 그 사유.
const STRUCTURAL_ALLOWLIST: Record<string, string> = {
  'src/modules/schedule/schedule.service.ts':
    '참가자·roster 판정은 read.validateSessionInput(schedule-read — 정책 소비)과 EnrollmentsService에 위임. open-class 흐름은 enrollment 생성 명령이지 판정이 아니다',
  'src/modules/schedule/schedule.controller.ts': 'Swagger 설명 문자열만 — 판정 코드 없음',
  'src/modules/schedule/class-sessions.store.ts': 'SQL DDL 문자열의 enrollment_id 컬럼 — 판정 없음',
  'src/database/calendar-asset-specs.ts': 'enrollments 표 DDL·인덱스 정의 문자열 — 판정 코드 없음',
  'src/database/db-analytics-snapshot.repository.ts':
    '[TBO-80 80F] 분석 스냅샷의 행 선별만(폼 학생 id 목록으로 원시 행 조회 — WHERE student_id ANY). '
    + '활성/등록 판정은 counsel-analytics 순수 함수가 수행하며, 그쪽 enrolled 규칙(status!==canceled)은 '
    + '세션 코호트 규칙(active)과 다른 도메인이라 정책 소비 대상이 아니다',
};

// 규칙 2 allowlist — enrollment 행 status 인라인 필터가 정당한 파일과 그 사유.
const ACTIVE_FILTER_ALLOWLIST: Record<string, string> = {
  [POLICY_FILE]: '코호트 규칙의 정본 — 활성 필터의 유일한 선언 지점',
  'src/modules/enrollments/enrollments.service.ts':
    'enrollment lifecycle 소유자 — 재수강 중복·상태 전이 검증의 자체 의미(코호트 판정은 79A에서 정책 소비로 교체됨)',
};

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts')) acc.push(full);
  }
  return acc;
}

function main(): void {
  const failures: string[] = [];
  const flagged: string[] = [];

  for (const file of walk(SRC_ROOT)) {
    const rel = relative(join(__dirname, '..'), file).split('\\').join('/');
    if (rel === POLICY_FILE) continue;
    const text = readFileSync(file, 'utf8');

    // 규칙 1 — 구조 후보: studentIds와 enrollment를 함께 참조
    if (/studentIds/.test(text) && /enrollment/i.test(text)) {
      const consumesPolicy = POLICY_MARKERS.some((marker) => text.includes(marker));
      if (!consumesPolicy && !(rel in STRUCTURAL_ALLOWLIST)) {
        failures.push(
          `코호트 SSOT 미소비 후보: ${rel} — studentIds와 enrollment를 함께 다루면서 `
          + `session-participant.policy를 import하지 않는다. 판정이면 정책을 소비하고, 아니면 allowlist에 사유를 명기하라`,
        );
      } else {
        flagged.push(rel);
      }
    }

    // 규칙 2 — 문자 시그니처: enrollment 행에 대한 인라인 활성 필터
    if (!(rel in ACTIVE_FILTER_ALLOWLIST)) {
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return; // 규칙을 설명하는 주석은 사본이 아니다
        if (/status\s*===\s*'active'/.test(line) && /enrollment/i.test(line)) {
          failures.push(
            `인라인 활성 코호트 필터: ${rel}:${i + 1} — \`${line.trim()}\` — `
            + `buildCohortIndex/participantIdsForSession(SSOT)을 소비하라(FC-1·80C 재발 시그니처)`,
          );
        }
      });
    }
  }

  // allowlist 자체의 부패 방지 — 항목이 가리키는 파일이 사라지면 알림
  for (const rel of [...Object.keys(STRUCTURAL_ALLOWLIST), ...Object.keys(ACTIVE_FILTER_ALLOWLIST)]) {
    try {
      statSync(join(__dirname, '..', rel));
    } catch {
      failures.push(`낡은 allowlist 항목: ${rel} — 파일이 없다. allowlist에서 제거하라`);
    }
  }

  console.log(JSON.stringify({ ok: failures.length === 0, candidates: flagged.length, failures }, null, 2));
  if (failures.length) process.exit(1);
}

main();
