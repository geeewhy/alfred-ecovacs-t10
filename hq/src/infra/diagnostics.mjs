import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const logPath = fileURLToPath(new URL('../../../artifacts/hq/diagnostics.log', import.meta.url));
const limit = 10 * 1024;
let queue = Promise.resolve();
const states = new Map();
export function diagnostic(event, detail = {}) {
  queue = queue.catch(() => {}).then(async () => {
    await mkdir(path.dirname(logPath), { recursive: true });
    let line = Buffer.from(JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + '\n');
    if (line.length > limit) line = Buffer.from(JSON.stringify({ at: new Date().toISOString(), event, truncated: true }) + '\n');
    const size = await stat(logPath).then(s => s.size).catch(() => 0);
    if (size + line.length <= limit) return appendFile(logPath, line, { mode: 0o600 });
    let tail = Buffer.concat([await readFile(logPath), line]).subarray(-limit);
    const newline = tail.indexOf(10);
    if (newline >= 0) tail = tail.subarray(newline + 1);
    await writeFile(logPath + '.tmp', tail, { mode: 0o600 });
    await rename(logPath + '.tmp', logPath);
  }).catch(error => console.error('Diagnostic log:', error.message));
  return queue;
}
export function diagnosticState(component, state, detail = {}) {
  if (states.get(component) === state) return;
  states.set(component, state);
  return diagnostic(component, { state, ...detail });
}
