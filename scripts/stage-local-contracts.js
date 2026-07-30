#!/usr/bin/env node
/**
 * [TBO-79 J1] 로컬 빌드한 contracts를 소비자 node_modules에 스테이징한다.
 *
 * 왜 필요한가: `release.zsh`는 `run_gates`에서 contracts를 **빌드만** 하고, 실제 설치는
 * publish 이후 `refresh_contract_lock`에서 한다. 그래서 게이트는 **npm에 이미 올라간 구버전**
 * contracts로 돌았다. 코드가 새 export를 쓰기 시작하는 순간 닭-달걀이 된다.
 *   · 게이트를 통과시키려면 publish가 먼저여야 하고
 *   · publish하려면 게이트가 먼저여야 한다.
 * 2026-07-30에 이 교착이 실제로 터졌다(typecheck 24 errors — 전부 "has no exported member").
 *
 * 더 중요한 건, 스테이징이 없으면 게이트가 **배포될 것과 다른 contracts**를 검사한다는 점이다.
 * 구버전으로 초록이 떠도 배포 후 깨질 수 있다. 이 스크립트는 그 구멍을 막는다.
 *
 * publish를 대체하지 않는다 — publish 후 `refresh_contract_lock`이 lockfile을 진짜 tarball로
 * 갱신하고 게이트를 다시 돌린다. 이건 그 **앞단**의 정합 확보다.
 *
 * 사용: node backend/scripts/stage-local-contracts.js [--check]
 *   --check: 스테이징 없이 현재 상태만 보고(스크립트가 필요한지 판정)
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PKG = '@kms545487/contracts';
const CONSUMERS = ['backend', 'frontend'];
const checkOnly = process.argv.includes('--check');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const sourceDir = path.join(ROOT, 'contracts');
  const localVersion = readJson(path.join(sourceDir, 'package.json')).version;
  const distDir = path.join(sourceDir, 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.d.ts'))) {
    console.error(`contracts/dist가 비어 있습니다 — 먼저 'npm run build'를 실행하세요.`);
    process.exit(1);
  }

  const report = [];
  let staged = 0;
  for (const consumer of CONSUMERS) {
    const installed = path.join(ROOT, consumer, 'node_modules', PKG);
    if (!fs.existsSync(installed)) {
      report.push(`${consumer}: 미설치 — 건너뜀(npm ci 선행 필요)`);
      continue;
    }
    const installedPkg = path.join(installed, 'package.json');
    const before = readJson(installedPkg).version;
    if (before === localVersion) {
      report.push(`${consumer}: v${before} — 이미 최신`);
      continue;
    }
    if (checkOnly) {
      report.push(`${consumer}: v${before} → v${localVersion} 스테이징 필요`);
      staged += 1;
      continue;
    }
    // 구버전에만 있던 파일이 남지 않도록 통째로 교체한다(부분 덮어쓰기는 유령 모듈을 남긴다).
    fs.rmSync(path.join(installed, 'dist'), { recursive: true, force: true });
    fs.cpSync(distDir, path.join(installed, 'dist'), { recursive: true });
    const pkg = readJson(installedPkg);
    pkg.version = localVersion;
    fs.writeFileSync(installedPkg, `${JSON.stringify(pkg, null, 2)}\n`);
    report.push(`${consumer}: v${before} → v${localVersion} 스테이징 완료`);
    staged += 1;
  }

  console.log(`contracts local v${localVersion}`);
  for (const line of report) console.log(`  ${line}`);
  if (checkOnly && staged > 0) {
    console.log('  → 게이트 전 스테이징이 필요합니다(release.zsh가 자동 수행).');
  }
}

main();
