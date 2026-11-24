import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, config, modelConfigured } from './config.js';
import * as store from './store.js';
import { publish } from './bus.js';

const CLI_PATH = path.join(ROOT, 'cli', 'agent-cli.js');
const running = new Map(); // sessionId -> { child, stopRequested }

export function isRunning(sessionId) {
  return running.has(sessionId);
}

export function runningIds() {
  return [...running.keys()];
}

function emit(sessionId, ev) {
  const full = store.appendEvent(sessionId, ev);
  publish(sessionId, full);
  return full;
}

function setStatus(sessionId, status) {
  const meta = store.getSession(sessionId);
  if (!meta) return;
  meta.lastRunStatus = status;
  store.saveSession(meta);
  publish(sessionId, { type: 'session_status', ts: Date.now(), status });
}

/** 启动一轮任务。返回 {ok, error} */
export function startRun(sessionId, userText) {
  const meta = store.getSession(sessionId);
  if (!meta) return { ok: false, error: '会话不存在' };
  if (running.has(sessionId)) return { ok: false, error: '该会话正在执行任务，请等待完成或先停止' };
  if (!modelConfigured()) return { ok: false, error: '服务端未配置模型 API（MODEL_API_KEY / MODEL_BASE_URL / MODEL_NAME）' };
  const text = String(userText || '').trim();
  if (!text) return { ok: false, error: '消息不能为空' };

  // 标题自动生成：取首条用户消息前 30 字
  if (meta.title === '新会话') {
    meta.title = text.replace(/\s+/g, ' ').slice(0, 30);
    store.saveSession(meta);
    publish(sessionId, { type: 'session_title', ts: Date.now(), title: meta.title });
  }

  emit(sessionId, { type: 'user_message', text });
  const runId = store.newId('run');
  emit(sessionId, { type: 'run_start', runId, text: text.slice(0, 200) });
  setStatus(sessionId, 'running');

  const child = spawn(process.execPath, [CLI_PATH, '--session', sessionId, '--run-id', runId], {
    cwd: store.workspaceDir(sessionId),
    env: {
      ...process.env,
      DATA_DIR: config.dataDir,
      WORKSPACES_DIR: config.workspacesDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(sessionId, { child, stopRequested: false, terminalSeen: false });

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        ev = { type: 'agent_log', text: line.slice(0, 2000) };
      }
      emit(sessionId, ev);
      // CLI 的终态事件在这里同步落状态，避免 close 兜底误判
      if (['run_done', 'run_error', 'run_stopped', 'run_paused'].includes(ev.type)) {
        const entry = running.get(sessionId);
        if (entry) entry.terminalSeen = true;
      }
      if (ev.type === 'run_done') setStatus(sessionId, 'done');
      else if (ev.type === 'run_error') setStatus(sessionId, 'error');
      else if (ev.type === 'run_stopped') setStatus(sessionId, 'stopped');
      else if (ev.type === 'run_paused') setStatus(sessionId, 'idle');
      if (ev.type === 'file_changed') {
        publish(sessionId, { type: 'files_hint', ts: Date.now() });
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text) emit(sessionId, { type: 'agent_log', text: text.slice(0, 4000), stream: 'stderr' });
  });

  child.on('error', (err) => {
    emit(sessionId, { type: 'run_error', runId, error: `无法启动 Agent 进程：${err.message}` });
  });

  child.on('close', (code, signal) => {
    const entry = running.get(sessionId);
    running.delete(sessionId);
    const current = store.getSession(sessionId);
    const lastStatus = current?.lastRunStatus;
    // CLI 自己会发 run_done / run_error / run_stopped；这里兜底异常退出
    if (entry?.stopRequested) {
      if (!entry.terminalSeen && lastStatus === 'running') {
        emit(sessionId, { type: 'run_stopped', runId, reason: '用户停止' });
        setStatus(sessionId, 'stopped');
      }
    } else if (!entry?.terminalSeen && lastStatus === 'running') {
      emit(sessionId, {
        type: 'run_error',
        runId,
        error: `Agent 进程异常退出（code=${code}${signal ? `, signal=${signal}` : ''}）。会话记录已保存，可直接重试。`,
      });
      setStatus(sessionId, 'error');
    }
    publish(sessionId, { type: 'files_hint', ts: Date.now() });
  });

  return { ok: true, runId };
}

/** 请求停止当前任务 */
export function stopRun(sessionId) {
  const entry = running.get(sessionId);
  if (!entry) return { ok: false, error: '该会话当前没有正在执行的任务' };
  entry.stopRequested = true;
  emit(sessionId, { type: 'stop_requested' });
  try {
    entry.child.kill('SIGTERM');
  } catch { /* ignore */ }
  // Windows 上 SIGTERM 不可靠，5 秒后强制结束进程树
  setTimeout(() => {
    if (running.has(sessionId)) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          entry.child.kill('SIGKILL');
        }
      } catch { /* ignore */ }
    }
  }, 5000).unref();
  return { ok: true };
}

/** 服务启动时：把上次进程遗留的 running 状态标记为中断 */
export function recoverInterrupted() {
  for (const meta of store.listSessions()) {
    if (meta.lastRunStatus === 'running') {
      emit(meta.id, {
        type: 'run_interrupted',
        reason: '服务重启导致任务中断。已完成的步骤和文件都在，发送消息即可继续。',
      });
      setStatus(meta.id, 'interrupted');
    }
  }
}
