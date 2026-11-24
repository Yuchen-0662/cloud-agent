import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const sessionsDir = () => path.join(config.dataDir, 'sessions');
const metaPath = (id) => path.join(sessionsDir(), `${id}.json`);
const eventsPath = (id) => path.join(sessionsDir(), `${id}.events.jsonl`);

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function createSession(title) {
  const id = newId('s');
  const now = Date.now();
  const meta = {
    id,
    title: (title || '').trim().slice(0, 80) || '新会话',
    createdAt: now,
    updatedAt: now,
    lastRunStatus: 'idle', // idle | running | done | error | interrupted | stopped
  };
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  fs.writeFileSync(eventsPath(id), '');
  fs.mkdirSync(path.join(config.workspacesDir, id, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(config.workspacesDir, id, 'outputs'), { recursive: true });
  return meta;
}

export function getSession(id) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

export function saveSession(meta) {
  meta.updatedAt = Date.now();
  fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2));
}

export function listSessions() {
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), 'utf8'));
      meta.eventCount = countEvents(meta.id);
      out.push(meta);
    } catch {
      /* 跳过损坏的元数据 */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function deleteSession(id) {
  for (const p of [metaPath(id), eventsPath(id)]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  fs.rmSync(path.join(config.workspacesDir, id), { recursive: true, force: true });
}

function countEvents(id) {
  try {
    const txt = fs.readFileSync(eventsPath(id), 'utf8');
    if (!txt) return 0;
    return txt.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function appendEvent(sessionId, ev) {
  const seq = countEvents(sessionId); // 单进程内串行追加，seq 即行号
  const full = { seq, ts: Date.now(), ...ev };
  fs.appendFileSync(eventsPath(sessionId), JSON.stringify(full) + '\n');
  return full;
}

export function readEvents(sessionId, afterSeq = -1) {
  let txt = '';
  try {
    txt = fs.readFileSync(eventsPath(sessionId), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.seq > afterSeq) out.push(ev);
    } catch {
      /* 忽略损坏行 */
    }
  }
  return out;
}

/** 将 JSONL 事件流折叠为 OpenAI Chat Completions 消息数组（供 CLI 恢复上下文） */
export function rebuildMessages(sessionId) {
  const msgs = [];
  for (const ev of readEvents(sessionId)) {
    if (ev.type === 'user_message') {
      msgs.push({ role: 'user', content: ev.text });
    } else if (ev.type === 'assistant_message') {
      const m = { role: 'assistant', content: ev.text || '' };
      if (ev.toolCalls && ev.toolCalls.length) m.tool_calls = ev.toolCalls;
      msgs.push(m);
    } else if (ev.type === 'tool_result') {
      msgs.push({ role: 'tool', tool_call_id: ev.toolCallId, content: ev.content });
    }
  }
  // 修复悬空 tool_calls：中断/出错时可能有 assistant(tool_calls) 没有对应 tool 结果
  const answered = new Set(msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  const fixed = [];
  for (const m of msgs) {
    fixed.push(m);
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (!answered.has(tc.id)) {
          fixed.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: '[系统] 该工具调用因任务中断/进程重启未完成，没有执行结果。如仍需要请重新调用。',
          });
          answered.add(tc.id);
        }
      }
    }
  }
  // 清理尾部悬空的 tool 消息之前的孤儿（role=tool 但前面无对应 assistant）理论上不会出现
  return fixed;
}

export function workspaceDir(sessionId) {
  return path.join(config.workspacesDir, sessionId);
}
