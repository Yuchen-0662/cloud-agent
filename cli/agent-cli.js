#!/usr/bin/env node
/**
 * agent-cli —— 工作台的 Agent 执行端（真实 CLI）
 *
 * 用法：
 *   node cli/agent-cli.js --session <id> [--run-id <id>]
 *
 * 从会话事件日志恢复完整上下文，连接 OpenAI 兼容模型服务执行工具循环，
 * 以 JSONL 事件流写 stdout（由工作台服务端捕获、持久化并推送给浏览器）。
 * 凭据只从环境变量读取：MODEL_API_KEY / MODEL_BASE_URL / MODEL_NAME。
 */
import { config, modelConfigured, ensureDirs } from '../server/config.js';
import * as store from '../server/store.js';
import { runAgentLoop, SYSTEM_PROMPT } from '../agent/loop.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') out.session = argv[++i];
    else if (argv[i] === '--run-id') out.runId = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

function emit(ev) {
  process.stdout.write(JSON.stringify(ev) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.session) {
    console.error('用法: node cli/agent-cli.js --session <id> [--run-id <id>]');
    process.exit(args.help ? 0 : 2);
  }
  ensureDirs();
  const meta = store.getSession(args.session);
  if (!meta) {
    emit({ type: 'run_error', error: `会话不存在：${args.session}` });
    process.exit(2);
  }
  if (!modelConfigured()) {
    emit({ type: 'run_error', error: '未配置模型 API：请设置 MODEL_API_KEY / MODEL_BASE_URL / MODEL_NAME 环境变量' });
    process.exit(2);
  }

  const workspace = store.workspaceDir(args.session);
  const messages = [
    {
      role: 'system',
      content:
        SYSTEM_PROMPT +
        `\n\n当前会话工作区目录名：${args.session}。现在时间：${new Date().toISOString()}。`,
    },
    ...store.rebuildMessages(args.session),
  ];

  const controller = new AbortController();
  const onTerm = () => {
    controller.abort();
    // 给正在进行的 fetch 一点时间退出，然后硬退
    setTimeout(() => process.exit(130), 1500).unref();
  };
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onTerm);

  try {
    const result = await runAgentLoop({
      messages,
      model: config.model,
      workspace,
      maxSteps: config.maxSteps,
      cmdTimeoutMs: config.cmdTimeoutMs,
      emit,
      signal: controller.signal,
    });
    if (result.done) {
      emit({ type: 'run_done', runId: args.runId, steps: result.steps, usage: result.usage });
    } else {
      emit({ type: 'run_paused', runId: args.runId, reason: result.reason, steps: result.steps });
    }
    process.exit(0);
  } catch (e) {
    if (controller.signal.aborted || /任务已停止/.test(e.message)) {
      emit({ type: 'run_stopped', runId: args.runId, reason: '用户停止' });
      process.exit(130);
    }
    emit({ type: 'run_error', runId: args.runId, error: e.message });
    process.exit(1);
  }
}

main();
