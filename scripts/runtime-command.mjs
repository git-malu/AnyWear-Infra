import { readFileSync } from 'node:fs';

export function runtimeCommandBytes() {
  // Embed the exact shared contract in the unchanged selected image.
  const shared = readFileSync(new URL('./json-contract.mjs', import.meta.url), 'utf8')
    .replace("import { createHash } from 'node:crypto';", "const { createHash } = require('node:crypto');")
    .replace(/^export /gm, '');
  const command = readFileSync(new URL('../.github/scripts/read-only-runtime.cjs', import.meta.url), 'utf8');
  const inner = `${shared}\n${command}`;
  // An OS timeout also bounds synchronous reads/hashing in the selected image.
  return Buffer.from(`const {spawnSync}=require('node:child_process');\nconst result=spawnSync(process.execPath,['-e',${JSON.stringify(inner)}],{timeout:30000,killSignal:'SIGKILL',maxBuffer:1048576});\nif(result.error||result.status!==0){console.error('Read-only evidence process deadline/result failed');process.exit(1);}\nprocess.stdout.write(result.stdout);\n`);
}
