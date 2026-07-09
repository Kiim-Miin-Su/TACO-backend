import { existsSync } from 'fs';
import { resolve } from 'path';
import { config } from 'dotenv';

let loaded = false;

export function loadLocalEnv(): void {
  if (loaded) return;
  loaded = true;

  for (const file of ['.env.local', '.env']) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    config({ path, override: false, quiet: true });
  }
}
