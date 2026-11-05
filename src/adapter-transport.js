#!/usr/bin/env node
/**
 * qq-bridge transport-only entrypoint.
 *
 * This intentionally does NOT create DSH sessions or use qq-bridge's presets,
 * roles, social memory or console state machine. It is the QQ half of the
 * unified platform-adapter architecture:
 *
 *   SnowLuma OneBot WS -> POST /webhook/qq
 *   GET /api/bridge/outbox?platform=qq -> SnowLuma HTTP/WS send
 *
 * Run: npm run start:transport
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, message, text } from '@snowluma/sdk';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = process.env.QQ_BRIDGE_CONFIG || path.join(ROOT, 'config.json');
const STATUS_FILE = path.join(ROOT, 'state', 'adapter-transport-status.json');

function writeStatus(value) {
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ at: Date.now(), ...value }, null, 2), 'utf8');
  } catch { /* status must not kill the bridge */ }
}

function log(...args) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + args.map(String).join(' ');
  console.log(line);
  try { fs.appendFileSync(path.join(ROOT, 'adapter-transport.log'), line + '\n'); } catch { /* ignore */ }
}

function readConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const a = c.adapter || {};
  return {
    snowluma: c.snowluma || {},
    adapter: {
      baseUrl: String(a.baseUrl || 'http://127.0.0.1:8788').replace(/\/+$/, ''),
      token: String(a.token || ''),
      pollMs: Math.max(300, Number(a.pollMs) || 1200),
      maxImageBytes: Math.max(1024 * 1024, Number(a.maxImageBytes) || 10 * 1024 * 1024),
    },
  };
}

function segmentText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message.map((seg) => {
    const d = seg && seg.data ? seg.data : {};
    switch (seg && seg.type) {
      case 'text': return String(d.text || '');
      case 'at': return d.qq === 'all' ? '@全体成员' : '@' + String(d.qq || '');
      case 'face': return '[表情]';
      case 'image': return '[图片]';
      case 'record': return '[语音]';
      case 'video': return '[视频]';
      case 'file': return '[文件 ' + String(d.name || '') + ']';
      case 'reply': return '[引用]';
      default: return '[' + String((seg && seg.type) || '未知') + ']';
    }
  }).join('');
}

function firstImage(message) {
  if (!Array.isArray(message)) return null;
  for (const seg of message) {
    if (!seg || seg.type !== 'image') continue;
    const d = seg.data || {};
    const url = String(d.url || d.file || '');
    if (url) return { url, mime: 'image/jpeg' };
  }
  return null;
}

async function imageAsBase64(url, maxBytes) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('image HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > maxBytes) throw new Error('image too large/empty');
  const ct = String(r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  return { b64: buf.toString('base64'), mime: ct };
}

function isAtMe(event, selfId) {
  const sid = String(selfId || event.self_id || '');
  if (!sid) return false;
  if (Array.isArray(event.message)) {
    if (event.message.some((s) => s && s.type === 'at' && String(s.data && s.data.qq) === sid)) return true;
  }
  return String(event.raw_message || '').includes('[CQ:at,qq=' + sid + ']');
}

export function normalizeEvent(event, kind, selfId) {
  const group = kind === 'group';
  const chatId = String(group ? event.group_id : event.user_id || '');
  const sender = event.sender || {};
  const sid = String(selfId || event.self_id || '');
  let text = String(segmentText(event.message) || event.raw_message || '').trim();
  if (group && sid) text = text.replaceAll('@' + sid, '').trim();
  return {
    platform: 'qq',
    chat_id: chatId,
    chat_type: group ? 'group' : 'private',
    msg_id: String(event.message_id || ''),
    sender_id: String(event.user_id || ''),
    sender_name: String(sender.card || sender.nickname || event.user_id || 'QQ用户'),
    text,
    at_me: group && isAtMe(event, sid),
    chat_title: group ? String(event.group_id || '') : String(sender.nickname || ''),
    ts: Number(event.time ? Number(event.time) * 1000 : Date.now()),
  };
}

async function adapterCall(adapter, pathname, options = {}) {
  const r = await fetch(adapter.baseUrl + pathname, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(adapter.token ? { 'x-bot-token': adapter.token } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  const textBody = await r.text();
  let data = null;
  try { data = JSON.parse(textBody); } catch { /* ignore */ }
  if (!r.ok) throw new Error('adapter HTTP ' + r.status + ': ' + textBody.slice(0, 200));
  return data;
}

async function main() {
  const { snowluma, adapter } = readConfig();
  if (!snowluma.wsUrl) throw new Error('missing snowluma.wsUrl');
  if (!adapter.baseUrl) throw new Error('missing adapter.baseUrl');
  writeStatus({ connected: false, starting: true, adapter: adapter.baseUrl, snowluma: snowluma.wsUrl });

  const bot = new SnowLumaWebSocketClient({
    url: snowluma.wsUrl,
    accessToken: snowluma.accessToken || undefined,
    reconnect: true,
  });
  let selfId = '';
  let outboxBusy = false;

  async function onMessage(kind, event) {
    if (!event) return;
    if (String(event.user_id || '') === String(selfId || event.self_id || '')) return;
    try {
      const payload = normalizeEvent(event, kind, selfId);
      if (!payload.chat_id || !payload.msg_id) return;
      const img = firstImage(event.message);
      if (img) {
        try {
          const got = await imageAsBase64(img.url, adapter.maxImageBytes);
          if (got) { payload.image = got.b64; payload.mime = got.mime; }
        } catch (e) { log('[media:error]', e.message); }
      }
      log('[in]', kind, payload.chat_id, payload.sender_name, payload.text.slice(0, 40));
      writeStatus({ connected: true, lastInboundAt: Date.now(), lastChat: payload.chat_id, lastChatType: payload.chat_type });
      await adapterCall(adapter, '/webhook/qq', { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      log('[in:error]', e && e.message || e);
      writeStatus({ connected: true, lastErrorAt: Date.now(), lastError: 'in: ' + String(e && e.message || e) });
    }
  }

  bot.onGroupMessage(async (event) => onMessage('group', event));
  bot.onPrivateMessage(async (event) => onMessage('private', event));
  bot.on('open', async () => {
    log('[snowluma] connected', bot.url || snowluma.wsUrl);
    writeStatus({ connected: true, connectedAt: Date.now() });
    try {
      const login = await bot.getLoginInfo();
      selfId = String(login && login.user_id || '');
      log('[snowluma] login', login && login.nickname || '?', selfId || '?');
      writeStatus({ connected: true, selfId, nickname: login && login.nickname || '' });
    } catch (e) {
      log('[snowluma:login:error]', e && e.message || e);
    }
  });
  bot.on('close', (info) => {
    log('[snowluma] closed', info && info.code || '?');
    writeStatus({ connected: false, lastCloseAt: Date.now(), lastCloseCode: info && info.code || null });
  });
  bot.on('error', (e) => {
    log('[snowluma:error]', e && e.message || e);
    writeStatus({ connected: false, lastErrorAt: Date.now(), lastError: 'ws: ' + String(e && e.message || e) });
  });

  setInterval(async () => {
    if (outboxBusy) return;
    outboxBusy = true;
    try {
      const data = await adapterCall(adapter, '/api/bridge/outbox?platform=qq');
      const items = Array.isArray(data && data.items) ? data.items : [];
      if (!items.length) return;
      const done = [];
      for (const item of items) {
        try {
          const id = Number(item.chatId);
          if (!Number.isSafeInteger(id) || id <= 0) throw new Error('bad chatId ' + item.chatId);
          const content = String(item.text || '');
          const file = String(item.file || '');
          if (item.kind === 'file' && file) {
            if (!fs.existsSync(file)) throw new Error('file missing: ' + file);
            if (item.chatType === 'group') await bot.uploadGroupFile(id, file);
            else await bot.uploadPrivateFile(id, file);
            done.push(item.id);
            log('[out]', item.chatType, item.chatId, 'file=' + path.basename(file));
            writeStatus({ connected: true, lastOutboundAt: Date.now() });
            continue;
          }
          const chain = file && item.kind === 'image'
            ? (content ? text(content).image(file) : message.image(file))
            : text(content);
          if (!content.trim() && !(file && item.kind === 'image')) { done.push(item.id); continue; }
          if (item.chatType === 'group') await bot.sendGroupMessage(id, chain);
          else await bot.sendPrivateMessage(id, chain);
          done.push(item.id);
          log('[out]', item.chatType, item.chatId, (content || file).slice(0, 40));
          writeStatus({ connected: true, lastOutboundAt: Date.now() });
        } catch (e) {
          log('[out:error]', item.id, e && e.message || e);
          writeStatus({ connected: true, lastErrorAt: Date.now(), lastError: 'out: ' + String(e && e.message || e) });
        }
      }
      if (done.length) await adapterCall(adapter, '/api/bridge/outbox/ack', { method: 'POST', body: JSON.stringify({ ids: done }) });
    } catch (e) {
      log('[outbox:error]', e && e.message || e);
    } finally {
      outboxBusy = false;
    }
  }, adapter.pollMs);

  await bot.connect();
  log('[bridge] transport-only started; adapter=' + adapter.baseUrl);
  process.on('SIGINT', () => { try { bot.disconnect?.(); } catch { /* ignore */ } process.exit(0); });
  process.on('SIGTERM', () => { try { bot.disconnect?.(); } catch { /* ignore */ } process.exit(0); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    log('[fatal]', e && e.stack || e);
    process.exitCode = 1;
  });
}
