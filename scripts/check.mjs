import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const directory of ['src', 'scripts']) {
  const root = new URL(`../${directory}/`, import.meta.url);
  for (const file of readdirSync(root).filter(name => /\.(mjs|js)$/.test(name))) {
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(file, root))], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log('All runtime modules and build scripts passed syntax checks.');
