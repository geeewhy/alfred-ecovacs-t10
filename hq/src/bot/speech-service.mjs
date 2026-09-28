import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = path.join(root, 'artifacts/hq');
const settingsFile = path.join(directory, 'speech.json');
const voices = [{ id: 'Daniel', label: 'Daniel · Male (British English)' }, { id: 'Samantha', label: 'Samantha · Female (American English)' }];
export class SpeechService {
  constructor(engine){this.engine=engine;}
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
      const temp=await mkdtemp(path.join(tmpdir(),'alfred-speech-'));
      try {
        await writeFile(path.join(temp,'text.txt'),text.trim());
        await exec('say',['-v',voice,'-o',path.join(temp,'speech.aiff'),'-f',path.join(temp,'text.txt')],{timeout:15000});
        await exec('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',path.join(temp,'speech.aiff'),'-ar','16000','-ac','1','-c:a','libvorbis',path.join(temp,'speech.ogg')],{timeout:15000});
        const clip=await readFile(path.join(temp,'speech.ogg'));
        const response=await this.engine.request('/v1/audio/play',15000,{method:'POST',headers:{'content-type':'audio/ogg','content-length':String(clip.length)},body:clip});
        if(!response.ok)throw Error('Robot audio playback failed');
      } finally {await rm(temp,{recursive:true,force:true});}
      this.speakingUntil = Date.now() + Math.max(3000, text.length * 100 + 2000);
      return { voice, message: 'Sent to Alfred' };
    } finally { this.busy = false; }
  }
}
