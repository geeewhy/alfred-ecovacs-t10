import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = path.join(root, 'artifacts/hq');
const settingsFile = path.join(directory, 'speech.json');
const voices = [{ id: 'Daniel', label: 'Daniel · Male (British English)' }, { id: 'Samantha', label: 'Samantha · Female (American English)' }];
export class SpeechService {
  busy = false;
  async settings() {
    let voice = 'Daniel';
    try { const saved = JSON.parse(await readFile(settingsFile, 'utf8')); if (voices.some(v => v.id === saved.voice)) voice = saved.voice; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { voice, voices };
  }
  async save({ voice }) {
    if (!voices.some(v => v.id === voice)) throw new Error('Choose a supported voice');
    await mkdir(directory, { recursive: true });
    const temp = `${settingsFile}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ voice }));
    await rename(temp, settingsFile);
    return this.settings();
  }
  async say(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Enter 1–1,000 characters');
    if (this.busy) throw new Error('Speech is already being prepared');
    this.busy = true;
    try {
      const { voice } = await this.settings();
      await exec('python3', [path.join(root, 'runtime/alfred.py'), 'say', '--voice', voice, '--', text.trim()], { timeout: 15000, maxBuffer: 65536 });
      this.speakingUntil = Date.now() + Math.max(3000, text.length * 100 + 2000);
      return { voice, message: 'Sent to Alfred' };
    } finally { this.busy = false; }
  }
}
