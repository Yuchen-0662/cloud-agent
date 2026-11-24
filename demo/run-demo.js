#!/usr/bin/env node
/**
 * 端到端演示脚本：驱动真实工作台 API，完成
 *   会话A：代码开发任务 + 追加修改（多轮）
 *   会话B：上传材料 + 分析整理报告
 *   并演示两个会话交错推进（多会话并行）。
 * 运行证据（事件日志、产物清单、验证输出）保存到 demo/evidence/。
 *
 * 用法: node demo/run-demo.js [--base http://127.0.0.1:8787]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const baseIdx = args.indexOf('--base');
const BASE = baseIdx >= 0 ? args[baseIdx + 1] : 'http://127.0.0.1:8787';
const EVIDENCE = path.join(__dirname, 'evidence');
fs.mkdirSync(EVIDENCE, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, {
    headers: opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(`${p} -> ${data.error || res.status}`);
  return data;
}

async function waitIdle(sessionId, timeoutMs = 15 * 60 * 1000) {
  const t0 = Date.now();
  let lastSeq = -1;
  while (Date.now() - t0 < timeoutMs) {
    const { session, events } = await api(`/api/sessions/${sessionId}`);
    for (const ev of events) {
      if (ev.seq > lastSeq) {
        lastSeq = ev.seq;
        if (['assistant_message', 'tool_call', 'run_error'].includes(ev.type)) {
          const brief = ev.type === 'tool_call' ? `🔧 ${ev.name}` : (ev.text || ev.error || '').slice(0, 90).replace(/\n/g, ' ');
          if (brief) log(`  [${sessionId.slice(-4)}] ${brief}`);
        }
      }
    }
    if (!session.running) return session.lastRunStatus;
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`会话 ${sessionId} 等待超时`);
}

async function send(sessionId, text) {
  log(`→ 发送任务 [${sessionId.slice(-4)}]: ${text.slice(0, 60)}…`);
  await api(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
}

async function upload(sessionId, filePath) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('files', new Blob([buf]), path.basename(filePath));
  const { files } = await api(`/api/sessions/${sessionId}/upload`, { method: 'POST', body: fd });
  return files;
}

async function saveEvidence(sessionId, name) {
  const { session, events } = await api(`/api/sessions/${sessionId}`);
  const { tree } = await api(`/api/sessions/${sessionId}/files`);
  fs.writeFileSync(path.join(EVIDENCE, `${name}.json`), JSON.stringify({ session, events, tree }, null, 2));
  return { session, events, tree };
}

function flatten(tree, acc = []) {
  for (const n of tree) {
    if (n.dir) flatten(n.children || [], acc);
    else acc.push(n);
  }
  return acc;
}

async function main() {
  const health = await api('/api/health');
  log('服务健康:', JSON.stringify(health.model));
  fs.writeFileSync(path.join(EVIDENCE, '00-health.json'), JSON.stringify(health, null, 2));

  // ---------- 会话A：代码开发 ----------
  const { session: dev } = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: '开发：记账命令行工具' }) });
  log('会话A(代码开发):', dev.id);

  // ---------- 会话B：材料分析 ----------
  const { session: ana } = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: '分析：Q3 销售数据' }) });
  log('会话B(材料分析):', ana.id);
  const csv = await upload(ana.id, path.join(__dirname, 'materials', '销售流水_2026Q3.csv'));
  const md = await upload(ana.id, path.join(__dirname, 'materials', '门店周报节选.md'));
  log('已上传材料:', csv.concat(md).map((f) => f.path).join(', '));

  // 两个会话交错推进：先发A，再发B，然后并行等待
  await send(dev.id,
    '帮我开发一个 Python 命令行记账小工具 ledger.py：支持 add(金额,分类,备注)、list、summary(按分类汇总) 三个子命令，' +
    '数据存 JSON 文件。写完后实际运行几条命令验证功能正常，再写一个 test_ledger.py 用 unittest 覆盖核心逻辑并跑通。' +
    '最终代码和简短使用说明放到 outputs/ 目录。');
  await send(ana.id,
    `我上传了两份材料：${csv[0].path} 和 ${md[0].path}。` +
    '请用 Python 实际计算：各门店/品类/渠道的销售额汇总与占比、月度趋势，找出亮点和风险点，' +
    '结合周报节选交叉验证你的数据结论，最后在 outputs/ 写一份中文分析报告 report.md（含数据表格），' +
    '并把汇总数据导出 outputs/summary.csv。');

  log('两个会话并行执行中…');
  const [devStatus1] = await Promise.all([waitIdle(dev.id), waitIdle(ana.id)]);
  log('会话A首轮:', devStatus1, '| 会话B首轮: 完成');

  const evB = await saveEvidence(ana.id, '02-analysis-session');
  log('会话B产物:', flatten(evB.tree).filter((f) => f.path.startsWith('outputs/')).map((f) => f.path).join(', '));

  // ---------- 会话A追加修改（多轮交流） ----------
  await send(dev.id,
    '很好。现在追加一个需求：给 ledger.py 增加 export 子命令，把所有记录导出为 CSV 文件（含表头），' +
    '补充对应测试并全部跑通，更新 outputs/ 里的代码和说明。');
  const devStatus2 = await waitIdle(dev.id);
  log('会话A第二轮(追加修改):', devStatus2);
  const evA = await saveEvidence(dev.id, '01-dev-session');
  log('会话A产物:', flatten(evA.tree).filter((f) => f.path.startsWith('outputs/')).map((f) => f.path).join(', '));

  // ---------- 验证证据：在工作区里实际重跑测试 ----------
  // 通过再发一条验证消息，让 Agent 展示真实运行输出
  await send(dev.id, '请在项目目录重新运行一次全部测试和 export 演示命令，把真实输出展示给我，确认交付可用。');
  await waitIdle(dev.id);
  const evA2 = await saveEvidence(dev.id, '01-dev-session-final');

  // 汇总
  const sessions = (await api('/api/sessions')).sessions;
  fs.writeFileSync(path.join(EVIDENCE, '03-sessions-list.json'), JSON.stringify(sessions, null, 2));
  const summary = {
    finishedAt: new Date().toISOString(),
    devSession: { id: dev.id, status: devStatus2, files: flatten(evA2.tree).map((f) => f.path) },
    analysisSession: { id: ana.id, files: flatten(evB.tree).map((f) => f.path) },
    sessionsTotal: sessions.length,
  };
  fs.writeFileSync(path.join(EVIDENCE, '04-summary.json'), JSON.stringify(summary, null, 2));
  log('演示完成 ✅ 证据已保存到 demo/evidence/');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error('演示失败:', e.message); process.exit(1); });
