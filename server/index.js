import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs, modelConfigured, ROOT } from './config.js';
import * as store from './store.js';
import * as runner from './runner.js';
import { subscribe, publish } from './bus.js';

ensureDirs();
runner.recoverInterrupted();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.disable('x-powered-by');

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code, error) => res.status(code).json({ ok: false, error });

function requireSession(req, res) {
  const meta = store.getSession(req.params.id);
  if (!meta) {
    fail(res, 404, '会话不存在');
    return null;
  }
  return meta;
}

/** 把用户提供的相对路径安全解析到会话工作区内 */
function safeResolve(sessionId, rel) {
  const base = store.workspaceDir(sessionId);
  const target = path.resolve(base, '.' + path.sep + (rel || ''));
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(baseWithSep)) return null;
  // 防符号链接逃逸
  try {
    const real = fs.realpathSync(target);
    const realBase = fs.realpathSync(base);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
  } catch {
    /* 不存在的路径由调用方处理 */
  }
  return target;
}

// ---------- 健康与配置 ----------
app.get('/api/health', (req, res) => {
  ok(res, {
    version: '1.0.0',
    model: {
      configured: modelConfigured(),
      name: config.model.name || null,
      endpointHost: config.model.baseUrl ? new URL(config.model.baseUrl).host : null,
    },
    runningSessions: runner.runningIds(),
    dataDir: config.dataDir,
  });
});

// ---------- 会话 ----------
app.get('/api/sessions', (req, res) => {
  const list = store.listSessions().map((m) => ({ ...m, running: runner.isRunning(m.id) }));
  ok(res, { sessions: list });
});

app.post('/api/sessions', (req, res) => {
  const meta = store.createSession(req.body?.title);
  ok(res, { session: { ...meta, running: false } });
});

app.get('/api/sessions/:id', (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  ok(res, { session: { ...meta, running: runner.isRunning(meta.id) }, events: store.readEvents(meta.id) });
});

app.delete('/api/sessions/:id', (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  if (runner.isRunning(meta.id)) return fail(res, 409, '任务执行中，请先停止再删除');
  store.deleteSession(meta.id);
  ok(res, {});
});

app.post('/api/sessions/:id/messages', (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  const result = runner.startRun(meta.id, req.body?.text);
  if (!result.ok) return fail(res, 409, result.error);
  ok(res, { runId: result.runId });
});

app.post('/api/sessions/:id/stop', (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  const result = runner.stopRun(meta.id);
  if (!result.ok) return fail(res, 409, result.error);
  ok(res, {});
});

// ---------- SSE 实时事件 ----------
app.get('/api/sessions/:id/stream', (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  const after = parseInt(req.query.after ?? '-1', 10);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  let lastSeq = Number.isFinite(after) ? after : -1;
  const send = (ev) => {
    if (typeof ev.seq === 'number') {
      if (ev.seq <= lastSeq) return;
      lastSeq = ev.seq;
    }
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  for (const ev of store.readEvents(meta.id, lastSeq)) send(ev);
  const unsub = subscribe(meta.id, send);
  const heartbeat = setInterval(() => res.write(': hb\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });
});

// ---------- 文件工作区 ----------
const IGNORED_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv']);

function walkTree(dir, base, depth = 0, acc = { count: 0 }) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  const out = [];
  for (const ent of entries) {
    if (acc.count > 2000) break;
    if (ent.isDirectory() && IGNORED_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    let st = null;
    try { st = fs.statSync(full); } catch { continue; }
    acc.count++;
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (ent.isDirectory()) {
      out.push({
        name: ent.name, path: rel, dir: true,
        children: depth < 8 ? walkTree(full, base, depth + 1, acc) : [],
      });
    } else {
      out.push({ name: ent.name, path: rel, dir: false, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

app.get('/api/sessions/:id/files', (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  const base = store.workspaceDir(meta.id);
  ok(res, { tree: walkTree(base, base) });
});

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.sh', '.bash', '.html', '.htm', '.css', '.csv', '.tsv', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.sql', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.rb', '.php', '.svg', '.env', '.gitignore', '.dockerfile']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);

app.get('/api/sessions/:id/file', (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  const target = safeResolve(meta.id, String(req.query.path || ''));
  if (!target) return fail(res, 400, '非法路径');
  let st;
  try { st = fs.statSync(target); } catch { return fail(res, 404, '文件不存在'); }
  if (st.isDirectory()) return fail(res, 400, '目标是目录，请使用打包下载');
  const ext = path.extname(target).toLowerCase();
  if (req.query.raw === '1' || IMAGE_EXTS.has(ext)) {
    return res.sendFile(target);
  }
  const isText = TEXT_EXTS.has(ext) || ext === '' || st.size < 4096;
  if (!isText || st.size > 2 * 1024 * 1024) {
    return ok(res, { kind: 'binary', size: st.size, name: path.basename(target) });
  }
  const buf = fs.readFileSync(target);
  // 简单二进制探测：前 8KB 含 NUL 则视为二进制
  if (buf.subarray(0, 8192).includes(0)) {
    return ok(res, { kind: 'binary', size: st.size, name: path.basename(target) });
  }
  ok(res, { kind: 'text', size: st.size, name: path.basename(target), content: buf.toString('utf8') });
});

app.get('/api/sessions/:id/download', (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  const target = safeResolve(meta.id, String(req.query.path || ''));
  if (!target) return fail(res, 400, '非法路径');
  let st;
  try { st = fs.statSync(target); } catch { return fail(res, 404, '文件不存在'); }
  if (st.isDirectory()) {
    res.attachment(`${path.basename(target) || meta.id}.zip`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', () => res.destroy());
    archive.pipe(res);
    archive.directory(target, false);
    archive.finalize();
  } else {
    res.download(target);
  }
});

// ---------- 上传 ----------
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(store.workspaceDir(req.params.id), 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      // multer 默认 latin1 解码文件名，转回 utf8 保中文
      let name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(-120) || 'file';
      const stamp = Date.now().toString(36);
      cb(null, `${stamp}-${name}`);
    },
  }),
  limits: { fileSize: config.maxUploadMB * 1024 * 1024, files: 10 },
});

app.post('/api/sessions/:id/upload', (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  upload.array('files')(req, res, (err) => {
    if (err) return fail(res, 400, `上传失败：${err.message}`);
    const files = (req.files || []).map((f) => ({
      name: f.filename,
      path: `uploads/${f.filename}`,
      size: f.size,
    }));
    if (files.length) {
      const ev = store.appendEvent(meta.id, { type: 'files_uploaded', files });
      publish(meta.id, ev);
      publish(meta.id, { type: 'files_hint', ts: Date.now() });
    }
    ok(res, { files });
  });
});

// ---------- 静态页面 ----------
app.use(express.static(path.join(ROOT, 'public')));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// 统一错误兜底
app.use((err, req, res, next) => {
  console.error('[server]', err);
  if (res.headersSent) return next(err);
  fail(res, 500, '服务端内部错误');
});

app.listen(config.port, () => {
  console.log(`[workbench] listening on http://0.0.0.0:${config.port}`);
  console.log(`[workbench] model configured: ${modelConfigured()} (${config.model.name || '未配置'})`);
});
