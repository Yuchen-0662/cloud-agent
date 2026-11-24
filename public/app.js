/* 云端 Agent 助手工作台 前端逻辑（无框架，原生 JS） */
'use strict';

const $ = (sel) => document.querySelector(sel);
const state = {
  sessions: [],
  current: null,        // 当前会话 meta
  events: [],           // 当前会话事件
  es: null,             // EventSource
  lastSeq: -1,
  toolCards: new Map(), // toolCallId -> DOM
  running: false,
  filesOpen: false,
};

// ---------- 工具 ----------
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 4200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败(${res.status})`);
  return data;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 会话列表 ----------
async function refreshSessions() {
  try {
    const { sessions } = await api('/api/sessions');
    state.sessions = sessions;
    renderSessionList();
    setConn(true);
  } catch (e) {
    setConn(false);
  }
}

function renderSessionList() {
  const list = $('#session-list');
  list.innerHTML = '';
  for (const s of state.sessions) {
    const div = document.createElement('div');
    div.className = 'session-item' + (state.current?.id === s.id ? ' active' : '');
    const statusIcon = s.running ? '🔵' : s.lastRunStatus === 'error' ? '🔴' : s.lastRunStatus === 'interrupted' ? '🟠' : '';
    div.innerHTML = `
      <div class="si-title">${statusIcon} ${esc(s.title)}</div>
      <div class="si-meta"><span>${fmtTime(s.updatedAt)}</span><span>${s.eventCount || 0} 条记录</span></div>`;
    div.onclick = () => openSession(s.id);
    list.appendChild(div);
  }
}

function setConn(ok) {
  $('#conn-dot').className = 'dot ' + (ok ? 'dot-green' : 'dot-red');
  $('#conn-text').textContent = ok ? '服务已连接' : '服务连接断开，自动重试中';
}

async function createSession() {
  try {
    const { session } = await api('/api/sessions', { method: 'POST', body: JSON.stringify({}) });
    await refreshSessions();
    openSession(session.id);
    $('#input').focus();
  } catch (e) { toast(e.message, true); }
}
window.createSession = createSession;

// ---------- 打开会话 & 事件流 ----------
async function openSession(id) {
  if (state.current?.id === id) return;
  closeStream();
  state.current = null;
  state.events = [];
  state.lastSeq = -1;
  state.toolCards.clear();
  $('#timeline').innerHTML = '';
  $('#upload-chips').innerHTML = '';
  try {
    const { session, events } = await api(`/api/sessions/${id}`);
    state.current = session;
    $('#empty-state').classList.add('hidden');
    $('#session-view').classList.remove('hidden');
    $('#session-title').textContent = session.title;
    document.title = `${session.title} · Agent 工作台`;
    for (const ev of events) applyEvent(ev, { replay: true });
    state.running = session.running;
    updateRunUI();
    renderSessionList();
    openStream(id);
    if (state.filesOpen) loadFiles();
    scrollBottom(true);
  } catch (e) {
    toast(e.message, true);
    refreshSessions();
  }
}

function closeStream() {
  if (state.es) { state.es.close(); state.es = null; }
}

function openStream(id) {
  closeStream();
  const es = new EventSource(`/api/sessions/${id}/stream?after=${state.lastSeq}`);
  state.es = es;
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false); // EventSource 自动重连，服务端按 after 补齐
  es.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data);
      if (state.current?.id !== id) return;
      applyEvent(ev);
    } catch { /* ignore */ }
  };
}

// ---------- 事件渲染 ----------
function applyEvent(ev, { replay = false } = {}) {
  if (typeof ev.seq === 'number') {
    if (ev.seq <= state.lastSeq) return;
    state.lastSeq = ev.seq;
    state.events.push(ev);
  }
  const tl = $('#timeline');
  removeThinking();

  switch (ev.type) {
    case 'user_message': {
      const div = el('div', 'ev ev-user');
      div.textContent = ev.text;
      tl.appendChild(div);
      break;
    }
    case 'run_start': {
      state.running = true;
      updateRunUI();
      tl.appendChild(sysLine(`▶ 任务开始 · ${fmtTime(ev.ts)}`));
      break;
    }
    case 'agent_thinking': {
      if (state.running) showThinking(ev.step, ev.maxSteps);
      break;
    }
    case 'assistant_message': {
      if (ev.text && ev.text.trim()) {
        const div = el('div', 'ev ev-assistant');
        div.innerHTML = renderMarkdownLite(ev.text);
        tl.appendChild(div);
      }
      for (const tc of ev.toolCalls || []) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
        addToolCard(tc.id, tc.function.name, args);
      }
      break;
    }
    case 'tool_call': {
      if (!state.toolCards.has(ev.toolCallId)) addToolCard(ev.toolCallId, ev.name, ev.args);
      break;
    }
    case 'tool_result': {
      fillToolResult(ev.toolCallId, ev.name, ev.content, ev.isError);
      break;
    }
    case 'run_done': {
      state.running = false;
      updateRunUI();
      const usage = ev.usage ? ` · tokens ${ev.usage.prompt_tokens}+${ev.usage.completion_tokens}` : '';
      tl.appendChild(sysLine(`✅ 任务完成（${ev.steps} 轮${usage}）· ${fmtTime(ev.ts)}`));
      refreshSessions();
      if (state.filesOpen) loadFiles();
      break;
    }
    case 'run_paused': {
      state.running = false;
      updateRunUI();
      tl.appendChild(sysLine(`⏸ ${ev.reason}`));
      break;
    }
    case 'run_error': {
      state.running = false;
      updateRunUI();
      const div = el('div', 'ev ev-error');
      div.textContent = `⚠ 任务出错：${ev.error}\n会话与文件已保留，直接再发一条消息即可重试或继续。`;
      tl.appendChild(div);
      refreshSessions();
      break;
    }
    case 'run_stopped': {
      state.running = false;
      updateRunUI();
      tl.appendChild(sysLine(`■ 已停止（${ev.reason || '用户操作'}），已完成的步骤和文件保留`));
      refreshSessions();
      break;
    }
    case 'run_interrupted': {
      state.running = false;
      updateRunUI();
      const div = el('div', 'ev ev-error');
      div.textContent = `🟠 ${ev.reason}`;
      tl.appendChild(div);
      break;
    }
    case 'stop_requested': {
      tl.appendChild(sysLine('… 正在停止任务'));
      break;
    }
    case 'files_uploaded': {
      const div = el('div', 'ev ev-files');
      div.innerHTML = `📎 已上传到工作区 uploads/：` + ev.files.map((f) => `<b>${esc(f.name)}</b>(${fmtSize(f.size)})`).join('、');
      tl.appendChild(div);
      if (state.filesOpen) loadFiles();
      break;
    }
    case 'session_title': {
      if (state.current) state.current.title = ev.title;
      $('#session-title').textContent = ev.title;
      document.title = `${ev.title} · Agent 工作台`;
      refreshSessions();
      break;
    }
    case 'session_status': {
      if (ev.status === 'running') state.running = true;
      else if (['done', 'error', 'stopped', 'interrupted', 'idle'].includes(ev.status)) state.running = false;
      updateRunUI();
      break;
    }
    case 'files_hint': {
      if (state.filesOpen && !replay) debounceLoadFiles();
      break;
    }
    case 'agent_log': {
      const div = el('div', 'ev ev-system');
      div.textContent = `[agent] ${ev.text}`;
      tl.appendChild(div);
      break;
    }
    default: break;
  }
  if (!replay) scrollBottom();
}

function el(tag, cls) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  return d;
}

function sysLine(text) {
  const div = el('div', 'ev ev-system');
  div.textContent = text;
  return div;
}

function renderMarkdownLite(text) {
  // 极简安全渲染：先转义，再支持 `code` 与 **bold**
  let s = esc(text);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  return s;
}

const TOOL_ICONS = { run_command: '⚡', read_file: '📖', write_file: '✏️', edit_file: '🔧', list_files: '📂' };

function toolSummary(name, args) {
  if (name === 'run_command') return String(args.command || '').slice(0, 120);
  if (name === 'write_file') return `${args.path || ''} (${(args.content || '').length} 字符)`;
  if (name === 'edit_file') return args.path || '';
  return args.path || '';
}

function addToolCard(id, name, args) {
  if (state.toolCards.has(id)) return;
  const card = el('div', 'ev tool-card');
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-icon">${TOOL_ICONS[name] || '🔹'}</span>
      <span class="tool-name">${esc(name)}</span>
      <span class="tool-summary">${esc(toolSummary(name, args))}</span>
      <span class="tool-status pending">执行中…</span>
    </div>
    <div class="tool-body">
      <div class="tb-label">参数</div>
      <pre class="tb-args">${esc(JSON.stringify(args, null, 2)).slice(0, 6000)}</pre>
      <div class="tb-label tb-result-label hidden">结果</div>
      <pre class="tb-result hidden"></pre>
    </div>`;
  card.querySelector('.tool-head').onclick = () => card.classList.toggle('open');
  $('#timeline').appendChild(card);
  state.toolCards.set(id, card);
}

function fillToolResult(id, name, content, isError) {
  const card = state.toolCards.get(id);
  if (!card) return;
  const status = card.querySelector('.tool-status');
  status.className = 'tool-status ' + (isError ? 'err' : 'ok');
  status.textContent = isError ? '出错' : '完成';
  let pretty = content;
  try {
    const obj = JSON.parse(content);
    if (name === 'run_command') {
      pretty = `$ exit=${obj.exit_code}${obj.timed_out ? ' (超时终止)' : ''}\n--- stdout ---\n${obj.stdout}\n--- stderr ---\n${obj.stderr}`;
      if (obj.error) pretty = obj.error;
    } else {
      pretty = JSON.stringify(obj, null, 2);
    }
  } catch { /* keep raw */ }
  const pre = card.querySelector('.tb-result');
  pre.textContent = pretty.slice(0, 12000);
  pre.classList.remove('hidden');
  card.querySelector('.tb-result-label').classList.remove('hidden');
  if (isError) card.classList.add('open');
}

function showThinking(step, maxSteps) {
  removeThinking();
  const div = el('div', 'thinking');
  div.id = 'thinking-line';
  div.innerHTML = `<span class="spinner"></span> Agent 正在思考与执行（第 ${step}/${maxSteps} 轮）…`;
  $('#timeline').appendChild(div);
}

function removeThinking() {
  $('#thinking-line')?.remove();
}

function scrollBottom(force = false) {
  const tl = $('#timeline');
  const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 160;
  if (force || nearBottom) tl.scrollTop = tl.scrollHeight;
}

function updateRunUI() {
  const badge = $('#run-badge');
  const status = state.running ? 'running' : (state.current?.lastRunStatus || 'idle');
  const labels = { running: '执行中', idle: '空闲', done: '已完成', error: '出错', interrupted: '已中断', stopped: '已停止' };
  badge.className = 'badge badge-' + (state.running ? 'running' : status);
  badge.textContent = labels[state.running ? 'running' : status] || status;
  $('#btn-send').classList.toggle('hidden', state.running);
  $('#btn-stop').classList.toggle('hidden', !state.running);
  $('#input').disabled = false;
}

// ---------- 发送 / 停止 ----------
async function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text || !state.current) return;
  if (state.running) { toast('任务执行中，请等待或先停止', true); return; }
  input.value = '';
  autoGrow(input);
  try {
    await api(`/api/sessions/${state.current.id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    // 事件由 SSE 推回
  } catch (e) {
    toast(e.message, true);
    input.value = text;
  }
}

async function stopRun() {
  if (!state.current) return;
  try {
    await api(`/api/sessions/${state.current.id}/stop`, { method: 'POST' });
  } catch (e) { toast(e.message, true); }
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 160) + 'px';
}

// ---------- 上传 ----------
async function uploadFiles(files) {
  if (!state.current || !files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  try {
    const { files: saved } = await api(`/api/sessions/${state.current.id}/upload`, { method: 'POST', body: fd });
    const chips = $('#upload-chips');
    for (const f of saved) {
      const chip = el('span', 'chip');
      chip.textContent = `📎 uploads/${f.name}`;
      chip.title = '发送消息时可提醒 Agent 处理该文件';
      chips.appendChild(chip);
    }
    const input = $('#input');
    if (!input.value.trim()) {
      input.value = `请处理我刚上传的材料：${saved.map((f) => 'uploads/' + f.name).join('、')}`;
      autoGrow(input);
    }
    input.focus();
  } catch (e) { toast(e.message, true); }
}

// ---------- 文件面板 ----------
let filesTimer = null;
function debounceLoadFiles() {
  clearTimeout(filesTimer);
  filesTimer = setTimeout(loadFiles, 800);
}

async function loadFiles() {
  if (!state.current) return;
  try {
    const { tree } = await api(`/api/sessions/${state.current.id}/files`);
    const root = $('#file-tree');
    root.innerHTML = '';
    root.appendChild(renderTree(tree));
    if (!tree.length) root.innerHTML = '<div class="ev-system">工作区还是空的</div>';
  } catch (e) { /* 会话可能已删除 */ }
}

function renderTree(nodes) {
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    const row = el('div', 'ft-node');
    if (n.dir) {
      row.innerHTML = `<span>📂</span><span class="ft-dirname">${esc(n.name)}</span>`;
      const children = el('div', 'ft-children');
      children.appendChild(renderTree(n.children || []));
      let open = ['uploads', 'outputs'].includes(n.name);
      children.style.display = open ? '' : 'none';
      row.onclick = () => { open = !open; children.style.display = open ? '' : 'none'; };
      frag.appendChild(row);
      frag.appendChild(children);
    } else {
      row.innerHTML = `<span>📄</span><span>${esc(n.name)}</span><span class="ft-size">${fmtSize(n.size)}</span>`;
      row.onclick = () => previewFile(n);
      frag.appendChild(row);
    }
  }
  return frag;
}

async function previewFile(n) {
  if (!state.current) return;
  const p = $('#file-preview');
  const content = $('#preview-content');
  $('#preview-name').textContent = n.path;
  $('#preview-download').href = `/api/sessions/${state.current.id}/download?path=${encodeURIComponent(n.path)}`;
  content.textContent = '加载中…';
  p.classList.remove('hidden');
  const ext = n.name.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) {
    content.innerHTML = `<img src="/api/sessions/${state.current.id}/file?path=${encodeURIComponent(n.path)}&raw=1" alt="${esc(n.name)}"/>`;
    return;
  }
  try {
    const data = await api(`/api/sessions/${state.current.id}/file?path=${encodeURIComponent(n.path)}`);
    content.textContent = data.kind === 'text' ? data.content : `[二进制文件 ${fmtSize(data.size)}，请点击下载]`;
  } catch (e) { content.textContent = e.message; }
}

// ---------- 删除会话 ----------
async function deleteCurrentSession() {
  if (!state.current) return;
  if (!confirm(`删除会话「${state.current.title}」？\n聊天记录和它的全部工作区文件都会被删除，不可恢复。`)) return;
  try {
    await api(`/api/sessions/${state.current.id}`, { method: 'DELETE' });
    closeStream();
    state.current = null;
    $('#session-view').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    $('#files-panel').classList.add('hidden');
    state.filesOpen = false;
    document.title = '云端 Agent 助手工作台';
    refreshSessions();
  } catch (e) { toast(e.message, true); }
}

// ---------- 初始化 ----------
async function init() {
  try {
    const h = await api('/api/health');
    $('#model-badge').textContent = h.model.configured ? `模型：${h.model.name}` : '⚠ 未配置模型 API';
    setConn(true);
  } catch {
    $('#model-badge').textContent = '服务不可用';
    setConn(false);
  }
  await refreshSessions();
  setInterval(refreshSessions, 15000);

  $('#btn-new-session').onclick = createSession;
  $('#btn-send').onclick = sendMessage;
  $('#btn-stop').onclick = stopRun;
  $('#btn-delete-session').onclick = deleteCurrentSession;
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  $('#input').addEventListener('input', (e) => autoGrow(e.target));
  $('#btn-upload').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ''; };

  $('#btn-toggle-files').onclick = () => {
    state.filesOpen = !state.filesOpen;
    $('#files-panel').classList.toggle('hidden', !state.filesOpen);
    if (state.filesOpen) loadFiles();
  };
  $('#btn-close-files').onclick = () => {
    state.filesOpen = false;
    $('#files-panel').classList.add('hidden');
  };
  $('#btn-refresh-files').onclick = loadFiles;
  $('#btn-download-all').onclick = () => {
    if (state.current) window.location = `/api/sessions/${state.current.id}/download?path=.`;
  };
  $('#btn-close-preview').onclick = () => $('#file-preview').classList.add('hidden');

  // 拖拽上传
  const main = $('#main');
  main.addEventListener('dragover', (e) => e.preventDefault());
  main.addEventListener('drop', (e) => {
    e.preventDefault();
    if (state.current && e.dataTransfer?.files?.length) uploadFiles([...e.dataTransfer.files]);
  });

  // URL hash 直达会话，便于刷新后恢复
  if (location.hash.startsWith('#s_')) {
    openSession(location.hash.slice(1));
  }
  const origOpen = openSession;
  // 记录 hash
  setInterval(() => {
    if (state.current && location.hash !== '#' + state.current.id) {
      history.replaceState(null, '', '#' + state.current.id);
    }
  }, 1000);
}

init();
