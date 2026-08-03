// Remove all build output across the monorepo.
import { rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

for (const group of ['packages', 'apps']) {
  if (!existsSync(group)) continue;
  for (const name of readdirSync(group)) {
    const dist = join(group, name, 'dist');
    rmSync(dist, { recursive: true, force: true });
  }
}
console.log('cleaned dist/ in all workspaces');
