import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
if (!process.versions.electron || !process.env.DSH_INSTALL_DIR) {
  throw new Error('Run this installed-host validation with DSH_NODE_EXECUTABLE, ELECTRON_RUN_AS_NODE=1 and DSH_INSTALL_DIR.');
}
const anchor = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
let resolving = false;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (!resolving && specifier.startsWith('@deepseek-ai/')) {
    resolving = true;
    try { return { url: pathToFileURL(anchor.resolve(specifier)).href, shortCircuit: true }; }
    finally { resolving = false; }
  }
  return nextResolve(specifier, context);
}});
console.log('Installed-host validation:', process.version, anchor.resolve('@deepseek-ai/cordis'));
