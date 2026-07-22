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
  for (const forbidden of ['SEED_DEMO', 'demoSeedEnabled', 'config/demo-seed']) {
    if (body.includes(forbidden)) failures.push(`${relative(root, file)} contains ${forbidden}`);
  }
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

const fixtureBoundary = readFileSync(join(root, 'src/config/test-fixtures.ts'), 'utf8');
if (!fixtureBoundary.includes("process.env.NODE_ENV === 'test'")) {
  failures.push('test fixture boundary must require NODE_ENV=test');
}

if (failures.length) {
  throw new Error(`runtime data boundary failed:\n- ${failures.join('\n- ')}`);
}
console.log('runtime data boundary: production demo env/import/CLI 0; test-only fixture gate verified');
