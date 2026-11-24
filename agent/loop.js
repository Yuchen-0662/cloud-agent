import { TOOL_SCHEMAS, createExecutor } from './tools.js';

export const SYSTEM_PROMPT = `你是"云端 Agent 助手工作台"中的执行 Agent，运行在一个隔离的 Linux 容器里，拥有当前会话专属的文件工作区（你的当前目录）。

工作方式：
- 你通过工具实际执行任务：run_command 执行 shell 命令，read_file/write_file/edit_file/list_files 操作文件。
- 环境已预装：bash、python3（含 pip）、node22、git、curl、ripgrep(rg)、jq、sqlite3、zip/unzip、ffmpeg、imagemagick(convert/identify)、pdftotext/poppler、tree、file。需要 Python 库时可 pip install。
- 用户上传的材料在 uploads/ 目录；你产出的最终成果（报告、代码、数据、图表等）统一放到 outputs/ 目录，用户会在界面上查看和下载。中间文件放工作区其他位置。
- 开发代码任务：写代码 → 实际运行/测试验证 → 修复问题，不要只写不跑。交付时在 outputs/ 放代码与简短使用说明。
- 分析整理任务：先查看材料再动手，结论基于材料内容，不编造数据；报告用 Markdown 写到 outputs/。
- 每完成一个关键步骤，用一两句话向用户说明进展（普通文本输出即可，界面会实时展示）。
- 任务完成后，用简洁的中文总结：做了什么、验证结果、成果文件在 outputs/ 的哪些路径。
- 遇到错误先诊断原因再重试，不要原样重复失败的操作。
- 你的活动范围仅限当前工作区，不要尝试访问工作区之外的系统路径。`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function chatCompletion({ baseUrl, apiKey, model, messages, tools, signal }) {
  const maxRetries = 3;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error('任务已停止');
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice: 'auto',
          max_tokens: 8192,
          stream: false,
        }),
        signal,
      });
      if (res.status === 429 || res.status >= 500) {
        const body = await res.text().catch(() => '');
        lastErr = new Error(`模型服务返回 ${res.status}：${body.slice(0, 300)}`);
        if (attempt < maxRetries) {
          await sleep(2000 * Math.pow(2, attempt));
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`模型服务返回 ${res.status}：${body.slice(0, 500)}`);
      }
      const data = await res.json();
      const choice = data.choices?.[0];
      if (!choice?.message) throw new Error('模型服务返回了空结果');
      return { message: choice.message, usage: data.usage || null };
    } catch (e) {
      if (signal?.aborted) throw new Error('任务已停止');
      lastErr = e;
      const retriable = e.name === 'TypeError' || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket/i.test(e.message);
      if (retriable && attempt < maxRetries) {
        await sleep(2000 * Math.pow(2, attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('模型调用失败');
}

/**
 * 运行一轮 Agent 循环。
 * emit(ev) 由调用方提供（CLI 中写 stdout JSONL）。
 */
export async function runAgentLoop({ messages, model, workspace, maxSteps, cmdTimeoutMs, emit, signal }) {
  const execute = createExecutor({
    workspace,
    defaultTimeoutMs: cmdTimeoutMs,
    onFileChanged: (p) => emit({ type: 'files_hint', path: p || null }),
  });

  let steps = 0;
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };

  while (steps < maxSteps) {
    if (signal?.aborted) throw new Error('任务已停止');
    steps++;
    emit({ type: 'agent_thinking', step: steps, maxSteps });

    const { message, usage } = await chatCompletion({
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      model: model.name,
      messages,
      tools: TOOL_SCHEMAS,
      signal,
    });
    if (usage) {
      totalUsage.prompt_tokens += usage.prompt_tokens || 0;
      totalUsage.completion_tokens += usage.completion_tokens || 0;
    }

    const text = typeof message.content === 'string' ? message.content : '';
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    const assistantMsg = { role: 'assistant', content: text || '' };
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
    messages.push(assistantMsg);
    emit({
      type: 'assistant_message',
      text: text || '',
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function?.name, arguments: tc.function?.arguments },
      })),
      usage,
      step: steps,
    });

    if (!toolCalls.length) {
      return { done: true, steps, usage: totalUsage };
    }

    for (const tc of toolCalls) {
      if (signal?.aborted) throw new Error('任务已停止');
      const name = tc.function?.name || '';
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        args = {};
      }
      emit({ type: 'tool_call', toolCallId: tc.id, name, args: summarizeArgs(args) });
      let result;
      if (!tc.function?.arguments || Object.keys(args).length === 0) {
        result = { error: '工具参数不是合法 JSON，请重新生成调用' };
      } else {
        result = await execute(name, args);
      }
      const content = JSON.stringify(result).slice(0, 30000);
      messages.push({ role: 'tool', tool_call_id: tc.id, content });
      emit({
        type: 'tool_result',
        toolCallId: tc.id,
        name,
        content,
        isError: Boolean(result?.error),
      });
    }
  }
  return { done: false, steps, usage: totalUsage, reason: `达到单轮最大步骤数（${maxSteps}），任务暂停。发送"继续"可接着推进。` };
}

function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string' && v.length > 600) out[k] = v.slice(0, 600) + `…(${v.length} 字符)`;
    else out[k] = v;
  }
  return out;
}
