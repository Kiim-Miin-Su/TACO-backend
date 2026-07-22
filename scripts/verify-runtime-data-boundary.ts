import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(__dirname, '..');
const failures: string[] = [];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

for (const file of sourceFiles(join(root, 'src'))) {
  const body = readFileSync(file, 'utf8');
  for (const forbidden of [
    'SEED_DEMO',
    'demoSeedEnabled',
    'config/demo-seed',
    'TEST_BUSINESS_FIXTURES',
    'business-fixtures',
    'park_inst',
    'jung_inst',
    'prof_admin',
    '김서연',
    '최민준',
  ]) {
    if (body.includes(forbidden)) failures.push(`${relative(root, file)} contains ${forbidden}`);
  }
}

for (const path of ['test/fixtures/business-fixtures.json', 'test/fixtures/seed-business-fixtures.ts']) {
  if (!existsSync(join(root, path))) failures.push(`${path} must exist under test/`);
}

for (const path of [
  'scripts/reset-demo-data.ts',
  'scripts/seed-calendar-demo.ts',
  'scripts/cleanup-demo-data.ts',
]) {
  if (existsSync(join(root, path))) failures.push(`${path} must not exist`);
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
for (const name of Object.keys(packageJson.scripts ?? {})) {
  if (name.includes(':demo')) failures.push(`package script ${name} must not expose demo data commands`);
}

if (failures.length) {
  throw new Error(`runtime data boundary failed:\n- ${failures.join('\n- ')}`);
}
console.log('runtime data boundary: production demo env/import/CLI/fixture imports 0; fixtures live under test/ only');
