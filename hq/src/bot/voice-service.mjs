import { diagnostic, diagnosticState } from "../infra/diagnostics.mjs";
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
export class VoiceService {
  constructor(chat, speech) {
    this.chat = chat; this.speech = speech; this.child = null;
    this.speech.on?.('activity', () => this.pauseCapture());
    this.state = { status: 'off', message: 'Robot microphone off' };
    this.tick = setInterval(() => this.sync().catch(error => { this.state = { status: 'error', message: error.message }; }), 1000);
    this.tick.unref();
  }
  async sync() {
    const state = await this.chat.current();
    if (!state.enabled) {
      if (this.child) this.child.stdin.end();
      this.state = { status: 'off', message: 'Robot microphone off' }; return;
    }
    if (this.state.status === 'error' && !this.child && !this.starting) {
      this.retryAt ||= Date.now() + 15000;
      if (Date.now() < this.retryAt) return;
      this.retryAt = null;
      this.state = { status: 'off', message: 'Reconnecting robot microphone' };
    }
    if (!this.child && !this.starting && this.state.status !== 'error') {
      this.starting = true;
      try {
        const python = process.env.ALFRED_VOICE_PYTHON || path.join(root, '.venv-voice/bin/python');
        const child = spawn(python, [path.join(root, 'runtime/voice_listener.py')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
        this.lastWake = null; this.lastHeard = null; this.meter = null; this.transcription = null; this.workerState = null;
        this.child = child; this.state = { status: 'loading', message: 'Starting robot microphone' };
        const startup = setTimeout(() => {
          this.state = { status: 'error', message: 'Microphone startup exceeded 75 seconds' };
          child.stdin.end(); child.kill('SIGTERM');
        }, 75000);
        let buffer = '', errors = '';
        child.stdout.on('data', data => {
          buffer += data.toString();
          const lines = buffer.split('\n'); buffer = lines.pop();
          for (const line of lines) {
            let event; try { event = JSON.parse(line); } catch { continue; }
            if (event.status === 'error') diagnosticState('microphone', 'error', { error: event.message });
            if (event.status === 'listening') diagnosticState('microphone', 'listening');
            if (event.status === 'listening' || event.status === 'error') clearTimeout(startup);
            if (event.status) { this.workerState = { status: event.status, message: event.message }; this.state = { ...this.workerState, lastWake: this.lastWake, lastHeard: this.lastHeard, meter: this.meter, transcription: this.transcription }; }
            if (event.meter) { this.meter = event.meter; this.state = { ...this.state, meter: this.meter }; }
            if (event.transcription) { this.transcription = event.transcription; this.state = { ...this.state, transcription: this.transcription }; }
            if (event.heard) {
              this.lastHeard = { text: event.heard, accepted: event.accepted, at: new Date().toISOString() };
              this.state = { ...this.state, lastWake: this.lastWake, lastHeard: this.lastHeard, meter: this.meter, transcription: this.transcription };
            }
            if (event.wake) {
              this.lastWake=new Date().toISOString();
              this.state={...this.state,lastWake:this.lastWake};
              void diagnostic("voice-wake",{at:this.lastWake});
              this.speech.click({wake:true}).catch(error => {
              this.state = {...this.state, message:'Wake detected; blip failed: '+error.message};
              });
            }
            if (event.text) this.submit(event.text);
          }
        });
        child.stderr.on('data', data => { errors = (errors + data.toString()).slice(-2000); });
        child.on('error', error => { this.state = { status: 'error', message: error.message }; });
        child.on('close', code => {
          clearTimeout(startup);
          this.child = null;
          if (code && this.state.status !== 'error') this.state = { status: 'error', message: 'Microphone process failed: ' + errors.slice(-300) };
        });
        child.stdin.on('error', () => {});
      } finally { this.starting = false; }
    }
    if (this.child?.stdin.writable) {
      const preparing = state.sessionStatus !== 'ready';
      const paused = preparing || !!state.pending || this.speech.busy || Date.now() < (this.speech.speakingUntil || 0);
      if (!this.vocabularyAt || Date.now()-this.vocabularyAt>30000) {
        try {
          const maps = await this.chat.sections();
          this.vocabulary = [...new Set(maps.flatMap(map=>map.sections.flatMap(section=>[section.name,...(section.aliases||[])])))].slice(0,60);
          this.vocabularyAt = Date.now();
        } catch { this.vocabularyAt = Date.now(); }
      }
      if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify({ paused, vocabulary:this.vocabulary || [] }) + '\n');
      if (paused) this.state = { status: 'paused', message: preparing ? (state.error || 'Connecting Alfred’s chat session…') : 'Listening paused while Alfred replies' };
      else if (this.state.status === 'paused') this.state = { ...(this.workerState || { status: 'listening', message: 'Listening. Start with Alfred.' }), lastWake: this.lastWake, lastHeard: this.lastHeard, meter: this.meter, transcription: this.transcription };
    }
  }
  pauseCapture() {
    if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify({paused:true}) + "\n");
  }
  async submit(text) {
    const state = await this.chat.current();
    if (!state.enabled || state.sessionStatus !== 'ready' || state.pending || this.speech.busy || Date.now() < (this.speech.speakingUntil || 0)) return;
    try { this.pauseCapture(); await this.chat.send(text, {receipt:false}); }
    catch (error) { this.state = { status: 'error', message: error.message }; }
  }
  reset() { if (this.state.status === 'error') this.state = { status: 'off', message: 'Starting robot microphone' }; }
}
