import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DOCS_ROOT = resolve(process.cwd(), '../docs');
const SOURCE_FILES = ['TODO.md', 'FABLE.md'];

function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(?:#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (!match) continue;
    const base = match[1]
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
      .replace(/ /g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  return anchors;
}

function main(): void {
  const failures: string[] = [];
  let total = 0;
  let local = 0;
  let external = 0;

  for (const sourceName of SOURCE_FILES) {
    const sourcePath = join(DOCS_ROOT, sourceName);
    const markdown = readFileSync(sourcePath, 'utf8');
    for (const match of markdown.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
      total += 1;
      const destination = match[1].trim().replace(/^<|>$/g, '').split(/\s+["']/)[0];
      if (/^(?:https?:|mailto:)/.test(destination)) {
        external += 1;
        continue;
      }
      if (destination.startsWith('/')) continue; // application route, not a documentation link
      local += 1;
      const [encodedPath, encodedFragment] = destination.split('#');
      const targetPath = encodedPath ? resolve(dirname(sourcePath), decodeURIComponent(encodedPath)) : sourcePath;
      if (!existsSync(targetPath)) {
        failures.push(`${sourceName}: missing target ${destination}`);
        continue;
      }
      if (encodedFragment && targetPath.endsWith('.md')) {
        const fragment = decodeURIComponent(encodedFragment).toLowerCase();
        if (!headingAnchors(readFileSync(targetPath, 'utf8')).has(fragment)) {
          failures.push(`${sourceName}: missing heading #${fragment} in ${targetPath.replace(`${DOCS_ROOT}/`, '')}`);
        }
      }
    }
  }

  if (failures.length) throw new Error(`Documentation link verification failed:\n- ${failures.join('\n- ')}`);
  // eslint-disable-next-line no-console
  console.log(`Documentation links verified — sources=${SOURCE_FILES.length}, total=${total}, local=${local}, external=${external}`);
}

main();
