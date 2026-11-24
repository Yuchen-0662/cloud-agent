import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        '在当前会话的工作区目录中执行一条 shell 命令（Linux 环境为 bash）。可用于运行代码、安装依赖、处理文件、调用 python3/git/ripgrep/ffmpeg/pdftotext 等已预装工具。返回 stdout、stderr 与退出码。长任务请拆分或后台化，单条命令有超时限制。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          timeout_seconds: { type: 'number', description: '可选，本条命令超时秒数，默认 120，最大 600' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作区内一个文本文件的内容（带行号）。大文件可用 offset/limit 分页。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          offset: { type: 'number', description: '起始行号（1 开始），默认 1' },
          limit: { type: 'number', description: '最多读取行数，默认 400' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把完整内容写入工作区内的文件（覆盖或新建），自动创建父目录。适合生成代码、报告、数据文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '对工作区内文件做精确字符串替换。old_string 必须在文件中唯一存在（除非 replace_all）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean', description: '默认 false' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出工作区目录树或某个子目录内容（自动忽略 node_modules/.git 等）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的目录路径，默认 "."' },
        },
        required: [],
      },
    },
  },
];

const IGNORED = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv']);

export function createExecutor({ workspace, defaultTimeoutMs, onFileChanged }) {
  function safeResolve(rel) {
    if (typeof rel !== 'string' || rel.includes('\0')) throw new Error('路径必须是字符串');
    const base = path.resolve(workspace);
    const target = path.resolve(base, rel);
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new Error(`路径越界：只允许操作会话工作区内的文件（${rel}）`);
    }
    return target;
  }

  function runCommand(args) {
    const command = String(args.command || '').trim();
    if (!command) return Promise.resolve({ error: 'command 不能为空' });
    const timeoutMs = Math.min(Math.max((Number(args.timeout_seconds) || defaultTimeoutMs / 1000), 1), 600) * 1000;
    return new Promise((resolve) => {
      const shell = process.platform === 'win32' ? 'bash' : '/bin/bash';
      const child = spawn(shell, ['-lc', command], {
        cwd: workspace,
        env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '', killed = false;
      const cap = 24000;
      const timer = setTimeout(() => {
        killed = true;
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          else child.kill('SIGKILL');
        } catch { /* ignore */ }
      }, timeoutMs);
      child.stdout.on('data', (d) => { if (out.length < cap) out += d.toString('utf8').slice(0, cap - out.length); });
      child.stderr.on('data', (d) => { if (err.length < cap) err += d.toString('utf8').slice(0, cap - err.length); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ error: `命令启动失败：${e.message}（环境里需要有 bash）` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        onFileChanged?.();
        resolve({
          exit_code: code,
          timed_out: killed,
          stdout: out || '(空)',
          stderr: err || '(空)',
          ...(killed ? { note: `命令超过 ${Math.round(timeoutMs / 1000)} 秒被终止` } : {}),
        });
      });
    });
  }

  function readFile(args) {
    const target = safeResolve(args.path);
    const st = fs.statSync(target);
    if (st.isDirectory()) return { error: '这是目录，请用 list_files' };
    if (st.size > 5 * 1024 * 1024) return { error: '文件超过 5MB，请用 run_command 配合 head/grep 等处理' };
    const buf = fs.readFileSync(target);
    if (buf.subarray(0, 8192).includes(0)) return { error: '二进制文件，请用 run_command 配合相应工具处理' };
    const lines = buf.toString('utf8').split('\n');
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.min(Math.max(Number(args.limit) || 400, 1), 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
    return {
      path: args.path,
      total_lines: lines.length,
      showing: `${offset}-${Math.min(offset + slice.length - 1, lines.length)}`,
      content: numbered.slice(0, 40000),
      truncated: numbered.length > 40000 || offset - 1 + limit < lines.length,
    };
  }

  function writeFile(args) {
    const target = safeResolve(args.path);
    const content = String(args.content ?? '');
    if (content.length > 2 * 1024 * 1024) return { error: '内容超过 2MB，请分块或用 run_command 生成' };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const existed = fs.existsSync(target);
    fs.writeFileSync(target, content, 'utf8');
    onFileChanged?.(args.path);
    return { path: args.path, bytes: Buffer.byteLength(content), overwritten: existed };
  }

  function editFile(args) {
    const target = safeResolve(args.path);
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    if (!oldStr) return { error: 'old_string 不能为空' };
    if (oldStr === newStr) return { error: 'old_string 与 new_string 相同' };
    const text = fs.readFileSync(target, 'utf8');
    const count = text.split(oldStr).length - 1;
    if (count === 0) return { error: '文件中找不到 old_string，请先 read_file 确认精确内容' };
    if (count > 1 && !args.replace_all) return { error: `old_string 出现 ${count} 次，请增加上下文使其唯一，或设置 replace_all=true` };
    const next = args.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
    fs.writeFileSync(target, next, 'utf8');
    onFileChanged?.(args.path);
    return { path: args.path, replacements: args.replace_all ? count : 1 };
  }

  function listFiles(args) {
    const target = safeResolve(args.path || '.');
    const st = fs.statSync(target);
    if (!st.isDirectory()) return { error: '不是目录' };
    const lines = [];
    const walk = (dir, depth, prefix) => {
      if (lines.length > 800 || depth > 6) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (IGNORED.has(ent.name)) continue;
        const full = path.join(dir, ent.name);
        const rel = path.relative(workspace, full).split(path.sep).join('/');
        if (ent.isDirectory()) {
          lines.push(`${rel}/`);
          walk(full, depth + 1, prefix);
        } else {
          let size = 0;
          try { size = fs.statSync(full).size; } catch { /* ignore */ }
          lines.push(`${rel} (${size}B)`);
        }
        if (lines.length > 800) { lines.push('…(截断)'); return; }
      }
    };
    walk(target, 0, '');
    return { path: args.path || '.', entries: lines.join('\n') || '(空目录)' };
  }

  return async function execute(name, args) {
    try {
      switch (name) {
        case 'run_command': return await runCommand(args || {});
        case 'read_file': return readFile(args || {});
        case 'write_file': return writeFile(args || {});
        case 'edit_file': return editFile(args || {});
        case 'list_files': return listFiles(args || {});
        default: return { error: `未知工具：${name}` };
      }
    } catch (e) {
      return { error: `${e.code === 'ENOENT' ? '文件/目录不存在：' : ''}${e.message}` };
    }
  };
}
