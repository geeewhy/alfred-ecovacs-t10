import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatService } from '../src/bot/chat-service.mjs';

test('closed session recovers once, retains history and model, and waits for launch', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alfred-chat-'));
  try {
    const file = path.join(dir, 'chat.json');
    const messages = [{ role: 'you', text: 'hello' }];
    await writeFile(file, JSON.stringify({ enabled: true, sessionId: 'closed', model: 'chosen-model', messages }));
    const calls = []; let listed = false;
    const service = new ChatService({}, { file, poll: false, command: async args => {
      calls.push(args);
      if (args[0] === 'list') return { sessions: listed ? [{ id: 'live', label: service.state.sessionLabel, thread: 'one-offs/diy-ecovacs-t10-salvage', agent: 'codex' }] : [] };
      if (args[1] === 'open') return {};
      if (args[2] === 'closed') return { closed: true };
      return { id: 'live', agent: 'codex', thread: 'one-offs/diy-ecovacs-t10-salvage', pane_live: true, transcript_path: '/tmp/transcript' };
    }});
    await service.ready;
    await service.exclusive(() => service.ensureSession());
    await service.exclusive(() => service.ensureSession());
    assert.equal(calls.filter(args => args[1] === 'open').length, 1);
    listed = true;
    await service.exclusive(() => service.ensureSession());
    assert.equal(service.snapshot().sessionStatus, 'ready');
    assert.equal(service.state.sessionId, 'live');
    assert.deepEqual(service.state.messages, messages);
    assert.equal(service.state.model, 'chosen-model');
    assert.equal(calls.filter(args => args[1] === 'send').length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('disabled chat does not create a session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alfred-chat-'));
  try {
    const service = new ChatService({}, { file: path.join(dir, 'chat.json'), poll: false, command: async () => { throw Error('unexpected CLI call'); } });
    await service.exclusive(() => service.poll());
    assert.equal(service.snapshot().sessionStatus, 'off');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
