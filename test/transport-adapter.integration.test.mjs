import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const QQ_ROOT = path.resolve(import.meta.dirname, '..');
const ADAPTER_PATH = path.resolve(QQ_ROOT, '..', '..', 'chat', 'whale_gril', 'plugins', 'platform-adapter', 'index.js');

function listen(server) {
  return new Promise((resolve) => server.once('listening', () => resolve(server.address().port)));
}

function waitFor(check, timeoutMs = 10000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      try {
        const value = check();
        if (value) { clearInterval(timer); resolve(value); return; }
      } catch { /* retry */ }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timeout waiting for ' + label));
      }
    }, 50);
  });
}

function oneBotReply(ws, msg, data = {}) {
  if (!msg || !msg.action) return;
  ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo }));
}

test('fake OneBot -> real transport -> real platform-adapter -> outbox -> OneBot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-int-'));
  const cfgFile = path.join(dir, 'config.json');
  const adapterCfg = path.join(dir, 'whale.json');
  const accessFile = path.join(dir, 'platform-access.json');
  fs.writeFileSync(adapterCfg, JSON.stringify({
    persona: { master: { wxids: ['wxid_master'] } },
    gateway: { wechat: { inboundToken: 't' } },
    wechat: { listen: { enabled: false, groups: [], privates: [] }, groupSettings: {} },
  }), 'utf8');
  fs.writeFileSync(accessFile, JSON.stringify({
    wechat: { groups: [], privates: [] },
    qq: { groups: [], privates: ['10001'], allowAllGroups: false, owner: '' },
  }), 'utf8');

  const { apply } = await import(pathToFileURL(ADAPTER_PATH).href);
  const adapterServer = apply({
    agents: {},
    systemPrompt: { section: () => {} },
    effect: () => {},
  }, {
    host: '127.0.0.1',
    port: 0,
    token: 't',
    whaleConfigPath: adapterCfg,
    modeFile: path.join(dir, 'mode.json'),
    sessionsFile: path.join(dir, 'sessions.json'),
    logFile: path.join(dir, 'adapter.log'),
    personaFile: path.join(dir, 'persona.md'),
    outboxFile: path.join(dir, 'outbox.json'),
    groupHistoryFile: path.join(dir, 'group-history.jsonl'),
    groupStateFile: path.join(dir, 'group-state.json'),
    dataDir: dir,
    memoryUrl: 'http://127.0.0.1:1',
  });
  const adapterPort = await listen(adapterServer);

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const wsPort = await listen(wss);
  let child;
  const sent = [];
  try {
    const outbound = new Promise((resolve, reject) => {
      wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(String(raw)); } catch { return; }
          if (msg.action === 'get_login_info') {
            oneBotReply(ws, msg, { user_id: 99999, nickname: 'FakeBot' });
            // The transport only starts forwarding after login; emit exactly one
            // allowed private /help after it has had time to register selfId.
            setTimeout(() => {
              ws.send(JSON.stringify({
                post_type: 'message',
                message_type: 'private',
                sub_type: 'friend',
                message_id: 'int-1',
                user_id: 10001,
                self_id: 99999,
                time: Math.floor(Date.now() / 1000),
                raw_message: '/help',
                message: [{ type: 'text', data: { text: '/help' } }],
                sender: { nickname: 'Tester', card: 'Tester' },
              }));
            }, 300);
            return;
          }
          if (msg.action === 'send_private_msg' || msg.action === 'send_group_msg') {
            sent.push(msg);
            oneBotReply(ws, msg);
            resolve(msg);
            return;
          }
          oneBotReply(ws, msg);
        });
      });
      setTimeout(() => reject(new Error('no outbound send within 10s')), 10000);
    });

    fs.writeFileSync(cfgFile, JSON.stringify({
      adapter: { baseUrl: `http://127.0.0.1:${adapterPort}`, token: 't', pollMs: 150 },
      snowluma: { wsUrl: `ws://127.0.0.1:${wsPort}`, accessToken: '' },
      access: { allowAllGroups: false, groups: [], privates: [] },
    }), 'utf8');

    child = spawn(process.execPath, ['src/adapter-transport.js'], {
      cwd: QQ_ROOT,
      env: { ...process.env, QQ_BRIDGE_CONFIG: cfgFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', (d) => { logs += String(d); });
    child.stderr.on('data', (d) => { logs += String(d); });

    const msg = await outbound;
    assert.equal(msg.action, 'send_private_msg');
    assert.equal(String(msg.params.user_id), '10001');
    const text = JSON.stringify(msg.params.message);
    assert.match(text, /\/help/);
    assert.match(text, /命令/);
  } finally {
    try { child?.kill(); } catch { /* ignore */ }
    wss.close();
    adapterServer.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
