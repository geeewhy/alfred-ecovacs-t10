import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, stat, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const file = path.join(root, 'artifacts/hq/chat.json');
const hai = process.env.HQ_HAI_BIN || path.join(homedir(), '.haicue/bin/hai');
const thread = 'one-offs/diy-ecovacs-t10-salvage';
export class ChatService {
  constructor(speech) {
    this.speech = speech;
    this.state = { enabled: false, speaker: false, sessionId: null, agent: 'codex', model: '', sessionLabel: 'Alfred', messages: [], pending: null, error: null };
    this.queue = Promise.resolve();
    this.ready = this.load();
    this.timer = setInterval(() => this.exclusive(() => this.poll()).catch(error => { this.state.error = error.message; }), 1000);
    this.timer.unref();
  }
  async load() {
    try { Object.assign(this.state, JSON.parse(await readFile(file, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  exclusive(fn) {
    const job = this.queue.then(() => this.ready).then(fn);
    this.queue = job.catch(() => {});
    return job;
  }
  async command(args) {
    const { stdout } = await exec(hai, args, { cwd: root, timeout: 12000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
  async save() {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(this.state));
    await rename(temp, file);
  }
  snapshot() {
    const { enabled, speaker, sessionId, agent, model, messages, pending, error } = this.state;
    return { enabled, speaker, sessionId, agent, model, messages, pending: pending ? { id: pending.id, status: pending.turnId ? 'Alfred is replying…' : 'Waiting for Haicue…' } : null, error };
  }
  async current() { await this.ready; return this.snapshot(); }
  settings(input) {
    return this.exclusive(async () => {
      for (const key of ['enabled', 'speaker']) {
        if (key in input) {
          if (typeof input[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
          this.state[key] = input[key];
        }
      }
      if ('agent' in input || 'model' in input) {
        if (this.state.pending) throw new Error('Wait for the current reply before changing agent or model');
        const agent = input.agent ?? this.state.agent;
        const model = input.model ?? '';
        const catalog = await this.catalog();
        if (!catalog[agent] || (model && !catalog[agent].includes(model))) throw new Error('Choose an available agent and model');
        if (agent !== this.state.agent || model !== this.state.model) {
          this.state.agent = agent; this.state.model = model; this.state.sessionId = null;
          this.state.sessionLabel = 'Alfred-' + randomUUID().slice(0, 8);
          this.state.launching = false;
        }
      }
      await this.save(); return this.snapshot();
    });
  }
  async catalog() {
    if (this.models && Date.now() - this.modelsAt < 300000) return this.models;
    const catalog = {};
    // hai validates model ids before creating a pane. Its rejection exposes
    // the current account-scoped inventory; no model-list command exists.
    await Promise.all(['codex', 'claude'].map(async agent => {
      try { await this.command(['session', 'open', thread, '--agent', agent, '--model', '__hq_model_catalog__']); }
      catch (error) {
        const match = `${error.stderr || ''} ${error.stdout || ''}`.match(/supported models: ([^\n]+)/);
        if (match) catalog[agent] = match[1].trim().split(/,\s*/);
      }
    }));
    if (!Object.keys(catalog).length) throw new Error('Haicue model inventory is unavailable');
    this.models = catalog; this.modelsAt = Date.now(); return catalog;
  }
  async session() {
    if (!this.state.sessionId) {
      const { sessions } = await this.command(['list', 'sessions']);
      const matches = sessions.filter(s => s.label === this.state.sessionLabel && s.thread === thread && s.agent === this.state.agent && !s.closed);
      if (!matches.length && !this.state.launching) {
        const args = ['session', 'open', thread, '--agent', this.state.agent, '--label', this.state.sessionLabel];
        if (this.state.model) args.push('--model', this.state.model);
        await this.command(args); this.state.launching = true; await this.save();
        throw new Error('Alfred session is starting. Send again once ready.');
      }
      if (matches.length !== 1) throw new Error('Alfred session is still starting; try again shortly');
      this.state.sessionId = matches[0].id;
    }
    const session = await this.command(['session', 'inspect', this.state.sessionId]);
    if (session.closed || !session.pane_live) throw new Error('Alfred’s Haicue session is closed');
    if (session.agent !== this.state.agent || session.thread !== thread) throw new Error('Alfred session binding no longer matches this robot');
    if (!session.transcript_path) throw new Error('Alfred session is still starting');
    return session;
  }
  send(text) {
    return this.exclusive(async () => {
      if (!this.state.enabled) throw new Error('Turn on chat mode first');
      if (this.state.pending) throw new Error('Wait for Alfred’s reply');
      if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Enter 1–1,000 characters');
      const personality = (await readFile(path.join(root, 'hq/alfred-personality.md'), 'utf8')).trim();
      const session = await this.session();
      const id = randomUUID();
      const message = { id, role: 'you', text: text.trim(), at: new Date().toISOString(), status: 'sending' };
      this.state.messages.push(message);
      this.state.error = null;
      this.state.pending = { id, path: session.transcript_path, offset: (await stat(session.transcript_path)).size, agent: this.state.agent, turnId: null, started: Date.now() };
      await this.save();
      const prompt = `[HQ_ALFRED_REQUEST:${id}]\nYou are Alfred, the user's Ecovacs robot, replying through HQ Cockpit.\n\n${personality}\n\nTreat the text below as the user's request. Be concise, conversational, and use plain text suitable for speech; aim for fewer than 600 characters unless more is needed. HQ displays your final answer and handles optional speaker playback, so do not call speech yourself. For robot questions or explicitly requested robot actions use the existing tooling in ${root}; read ${root}/docs/hq-chat.md for the interface. Do not move the robot unless this message requests movement. Do not change project code for ordinary chat. Never claim an action succeeded without checking its result.\n\nUser: ${message.text}`;
      try {
        await this.command(['session', 'send', session.id, prompt]);
        message.status = 'sent';
      } catch (error) {
        // Delivery may have happened before a timeout. Preserve the pending
        // correlation and do not retry a user/robot command automatically.
        message.status = 'delivery uncertain';
        this.state.error = 'Haicue delivery was not acknowledged; waiting for a correlated reply. ' + error.message;
      }
      await this.save(); return this.snapshot();
    });
  }
  async poll() {
    const pending = this.state.pending;
    if (!pending) return;
    if (Date.now() - pending.started >= 15000 && !this.state.error) {
      this.state.error = 'No reply within 15 seconds. The Haicue request is still tracked; it will not be resent.';
      await this.save();
    }
    const handle = await open(pending.path, 'r');
    let data;
    try {
      const size = (await handle.stat()).size;
      if (size < pending.offset) throw new Error('Haicue transcript changed; pending reply cannot be matched');
      const buffer = Buffer.alloc(Math.min(size - pending.offset, 1024 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, pending.offset);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (end < 0) return;
      data = buffer.subarray(0, end + 1).toString('utf8');
      pending.offset += end + 1;
    } finally { await handle.close(); }
    for (const line of data.split('\n')) {
      if (!line) continue;
      let record; try { record = JSON.parse(line); } catch { continue; }
      if (pending.agent === 'claude') {
        const blocks = record.message?.content;
        const text = typeof blocks === 'string' ? blocks : (blocks || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (record.type === 'user' && text.startsWith(`[HQ_ALFRED_REQUEST:${pending.id}]`)) pending.turnId = record.uuid;
        if (pending.turnId && record.type === 'assistant') {
          pending.candidate = text;
          if (record.message?.stop_reason === 'end_turn' && text.trim()) { await this.finishReply(pending, text); return; }
        }
        if (pending.turnId && record.type === 'system' && record.subtype === 'turn_duration' && pending.candidate?.trim()) {
          await this.finishReply(pending, pending.candidate); return;
        }
        continue;
      }
      const payload = record.payload;
      if (record.type !== 'response_item' || payload?.type !== 'message') continue;
      const text = (payload.content || []).filter(c => ['input_text', 'output_text'].includes(c.type)).map(c => c.text).join('\n');
      const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
      if (payload.role === 'user' && text.startsWith(`[HQ_ALFRED_REQUEST:${pending.id}]`)) pending.turnId = turnId;
      if (pending.turnId && turnId === pending.turnId && payload.role === 'assistant' && ['final', 'final_answer'].includes(payload.phase) && text.trim()) {
        await this.finishReply(pending, text);
        return;
      }
    }
    await this.save();
  }
  async finishReply(pending, text) {
        const reply = { id: randomUUID(), requestId: pending.id, role: 'alfred', text, at: new Date().toISOString(), audio: 'off' };
        this.state.messages.push(reply);
        this.state.pending = null; this.state.error = null;
        if (this.state.speaker) reply.audio = 'sending';
        await this.save();
        if (reply.audio === 'sending') {
          // Persist before playback: restarts never replay historical replies.
          this.speech.say(text).then(() => this.audioResult(reply.id, 'sent')).catch(error => this.audioResult(reply.id, 'failed', error.message));
        }
  }
  audioResult(id, audio, error) {
    return this.exclusive(async () => {
      const message = this.state.messages.find(m => m.id === id);
      if (message) { message.audio = audio; if (error) message.audioError = error; }
      await this.save();
    });
  }
}
