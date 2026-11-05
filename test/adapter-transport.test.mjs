import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../src/adapter-transport.js';

test('normalizes a QQ group message and removes the self @', () => {
  const e = normalizeEvent({
    group_id: 123,
    user_id: 456,
    self_id: 999,
    message_id: 'm1',
    time: 1800000000,
    message: [
      { type: 'text', data: { text: 'hi ' } },
      { type: 'at', data: { qq: 999 } },
    ],
    sender: { card: 'A' },
  }, 'group', '999');
  assert.equal(e.platform, 'qq');
  assert.equal(e.chat_id, '123');
  assert.equal(e.chat_type, 'group');
  assert.equal(e.sender_name, 'A');
  assert.equal(e.text, 'hi');
  assert.equal(e.at_me, true);
  assert.equal(e.ts, 1800000000000);
});

test('normalizes a QQ private message', () => {
  const e = normalizeEvent({
    user_id: 456,
    message_id: 'm2',
    message: [{ type: 'text', data: { text: 'hello' } }],
    sender: { nickname: 'B' },
  }, 'private', '999');
  assert.equal(e.chat_type, 'private');
  assert.equal(e.chat_id, '456');
  assert.equal(e.text, 'hello');
  assert.equal(e.at_me, false);
});
