// [B8 E4 2026-07-16] 라우트 커버리지 매트릭스 — e2e 실행이 남긴 라우트 로그(E2E_ROUTE_LOG,
//  test/setup-app.ts 계측)를 openapi.json paths×methods와 대조한다.
//  판정: ① 미기록 = 미커버 ② 401만 기록 = 가드에서만 튕김(본 로직 미실행) → 미커버로 간주.
//  미커버 > 0이면 exit 1 — "엔드포인트는 e2e 없이 존재할 수 없다"(29E §2-4)의 기계 게이트.
//  사용: E2E_ROUTE_LOG=/tmp/e2e-routes.log npx jest --config test/jest-e2e.json --runInBand
//       node dist/scripts/e2e-route-coverage.js /tmp/e2e-routes.log [openapi.json]
import { readFileSync } from 'node:fs';

const [, , logPath = '/tmp/e2e-routes.log', specPath = 'openapi.json'] = process.argv;

// 의도적 미커버 allowlist — 항목마다 사유 필수(빈 배열 유지가 목표 상태).
const ALLOWLIST: Array<{ op: string; reason: string }> = [];

type OpState = { hit: boolean; nonGuardHit: boolean };
const METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;

const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};
const wanted = new Map<string, OpState>();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    if (!item[method]) continue;
    const expressPath = path.replace(/\{([^}]+)\}/g, ':$1'); // OpenAPI {id} → express :id
    wanted.set(`${method.toUpperCase()} ${expressPath}`, { hit: false, nonGuardHit: false });
  }
}

const unknownHits = new Set<string>(); // 로그엔 있는데 스펙에 없음 = 역방향 드리프트(스펙 누락)
for (const line of readFileSync(logPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const [method, pattern, status] = line.split(' ');
  const key = `${method} ${pattern}`;
  const entry = wanted.get(key);
  if (!entry) {
    unknownHits.add(key);
    continue;
  }
  entry.hit = true;
  if (Number(status) !== 401) entry.nonGuardHit = true;
}

const allow = new Set(ALLOWLIST.map((a) => a.op));
const uncovered = [...wanted].filter(([, v]) => !v.hit).map(([k]) => k);
const guardOnly = [...wanted].filter(([, v]) => v.hit && !v.nonGuardHit).map(([k]) => k);
const effective = [...uncovered, ...guardOnly].filter((k) => !allow.has(k));
const coveredCount = wanted.size - uncovered.length - guardOnly.length;

console.log('── e2e 라우트 커버리지 매트릭스 (B8 E4) ──');
console.log(`스펙 연산: ${wanted.size} · 커버(비가드 응답 ≥1): ${coveredCount} · 401만: ${guardOnly.length} · 미기록: ${uncovered.length} · allowlist: ${ALLOWLIST.length}`);
if (unknownHits.size) {
  console.log(`\n⚠ 스펙에 없는 라우트가 테스트에서 호출됨(스펙 누락 의심) ${unknownHits.size}건:`);
  for (const k of [...unknownHits].sort()) console.log('  ', k);
}
if (effective.length) {
  console.log(`\n❌ 미커버 ${effective.length}건 (401만 = 가드 통과 검증 없음):`);
  for (const k of effective.sort()) console.log('  ', k, guardOnly.includes(k) ? '(401만)' : '(미기록)');
  process.exit(1);
}
console.log('\n✅ 미커버 0 — 전 연산이 e2e에서 비가드 응답으로 실행됨.');
