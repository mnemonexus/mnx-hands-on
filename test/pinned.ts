import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Copies of a few activities, kept so the engine tests stand still while content/ is edited.
 * Every shipped activity is still checked by the loops over content/ in each test file.
 */
export function pinnedFor<T>(engine: string): Record<string, T> {
  const dir = join(import.meta.dir, 'fixtures', 'pinned', engine);
  const found: Record<string, T> = {};
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) found[f.replace('.json', '')] = JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
  return found;
}
