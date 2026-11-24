# 云端 Agent 助手工作台（Cloud Agent Workbench）

把 Agent CLI 的能力带进浏览器：打开网页，新建会话，把开发代码、分析材料、整理报告等任务交给运行在容器里的 Agent；实时看到它的思考、工具调用与产出，随时追加修改意见；多个会话并行推进，关掉页面回来还能继续。

> 本项目为「云端 Agent 助手工作台」考题的实现。接入真实 Agent CLI（自研 `agent-cli`，OpenAI 兼容协议），通过 Docker 构建与启动，单用户使用，无需公网部署。

## 功能一览

- **多会话工作台**：左侧会话列表，每个会话独立的聊天记录 + 独立的文件工作区，互不干扰，可并行执行任务。
- **真实 Agent CLI**：`cli/agent-cli.js` 是独立可执行的 Agent 进程，连接 OpenAI 兼容模型服务，通过 function calling 驱动工具循环（执行 shell、读/写/改文件、列目录）。
- **实时执行过程**：SSE 推送每一步——Agent 的说明文字、每次工具调用（可展开看参数与完整输出）、完成/出错状态。
- **文件工作区**：每个会话一个隔离目录；上传材料进 `uploads/`，Agent 成果统一放 `outputs/`；界面内预览文本/图片、单文件下载、整区打包 zip 下载。
- **断点续聊**：会话与事件全部落盘（JSON + JSONL）。刷新页面、关闭浏览器、甚至重启服务，历史都在；服务重启会把中断的任务标记出来，发消息即可继续。
- **异常处理**：模型 429/5xx 自动指数退避重试；单条命令超时终止；任务可随时停止；Agent 进程崩溃有兜底事件与状态；上传大小/文件名清洗；路径越界防护。

## 架构与取舍

```
浏览器 (原生 JS SPA)
   │  REST + SSE
   ▼
Node/Express 服务 (server/)
   │  spawn 子进程 + JSONL stdout 事件流
   ▼
agent-cli (cli/agent-cli.js)  ←—— 真实 Agent CLI，每轮任务一个进程
   │  OpenAI 兼容 /chat/completions (tools)
   ▼
模型服务（环境变量配置）
   │
   └─ 工具执行：bash / python3 / node / git / rg / ffmpeg / pdftotext …
        工作区: /data/workspaces/<session-id>/
```

关键设计取舍：

1. **自研轻量 Agent CLI 而非包装 Codex/Claude Code**：考试模型端点是 OpenAI Chat Completions 兼容协议；Codex 依赖 Responses API、Claude Code 依赖 Anthropic 协议，均需额外协议转换层。自研 CLI 直接讲 OpenAI 协议，链路最短、行为完全可控（工具集、超时、重试、事件格式），且代码全部开源可审计。CLI 与服务端解耦：服务端只负责 spawn 进程、捕获 JSONL 事件流，CLI 也可以单独在终端运行。
2. **事件溯源（event sourcing）**：会话历史唯一事实来源是 append-only 的 JSONL 事件日志。发给模型的上下文由事件日志折叠重建（`store.rebuildMessages`），中断产生的悬空 tool_call 自动补占位结果，保证续聊时上下文合法。
3. **每轮任务一个子进程**：崩溃隔离（一轮失败不影响服务与其他会话）、停止即杀进程树、服务重启后状态可恢复。
4. **单容器一体化**：Web 服务、Agent CLI、执行环境（Python/Node/常用工具）打进同一镜像，`docker compose up` 一条命令即可用；数据在命名卷 `/data` 中持久化。
5. **安全边界（单用户定位）**：Agent 的文件工具限制在会话工作区内（路径解析 + realpath 双重校验）；shell 命令在容器内执行，天然与宿主机隔离；模型凭据只存在于服务端环境变量，绝不下发浏览器、绝不进仓库。**注意：shell 工具本身不做命令白名单——这是有意的取舍（Agent 需要自由度），隔离靠容器边界，因此本应用只适合单用户本地使用，不要直接暴露公网。**

## 快速开始（Docker，推荐）

前置：安装 Docker（Windows/macOS 用 Docker Desktop，Linux 用 docker engine + compose 插件）。

```bash
git clone <本仓库>
cd cloud-agent-workbench
cp .env.example .env
# 编辑 .env，填入模型服务三项：
#   MODEL_API_KEY=你的Key
#   MODEL_BASE_URL=https://.../v1   （OpenAI 兼容，需支持 tools）
#   MODEL_NAME=模型名
docker compose up -d --build
```

打开浏览器访问 **http://localhost:8787** 。

- 数据（会话记录 + 全部工作区文件）保存在命名卷 `workbench-data`，`docker compose down` 不会丢失；`down -v` 才会清数据。
- 查看日志：`docker compose logs -f workbench`
- 健康检查：`curl http://localhost:8787/api/health`

### 不用 Docker 的本地运行（开发模式）

```bash
npm install
cp .env.example .env   # 填入模型配置
set -a; . ./.env; set +a   # Windows Git Bash；其他 shell 自行导出环境变量
npm start
```

同样访问 http://localhost:8787 。注意：本地模式下 Agent 的 shell 命令直接跑在宿主机（需要 bash），没有容器隔离，仅建议开发调试用。

### 单独使用 Agent CLI

```bash
node cli/agent-cli.js --session <会话id>
```

CLI 从事件日志恢复上下文并执行一轮任务，事件以 JSONL 打到 stdout。这就是服务端调度的同一入口。

## 使用方式

1. **新建会话** → 输入任务，例如"帮我写一个命令行记账工具，带测试"。
2. 观察时间线：Agent 的文字说明、每个工具卡片（点击展开参数与输出）、状态徽标。
3. 任务完成后继续发消息追加需求（"再加一个导出 CSV 功能"），Agent 带着完整上下文继续。
4. 点 📎 或拖拽上传材料（进 `uploads/`），让 Agent 分析整理；成果在 `outputs/`。
5. 点 **📁 文件** 打开工作区面板：预览、下载单文件、⬇全部 打包 zip。
6. 左侧随时切换会话；执行中的会话可并行；关闭页面后再打开，会话与进度都在。
7. 任务跑偏了点 **■ 停止**；出错会有明确提示，直接再发消息重试即可。

## 演示

`demo/` 目录包含：

- `materials/`：演示材料（销售流水 CSV + 门店周报节选）。
- `run-demo.js`：端到端演示脚本，驱动真实 API 完成——
  - 会话A「代码开发」：开发 Python 记账 CLI → 运行验证 → 追加 export 需求（多轮修改）→ 重跑全部测试展示真实输出；
  - 会话B「材料分析」：上传两份材料 → Python 实际计算汇总/趋势 → 交叉验证周报 → 产出中文报告与汇总 CSV；
  - 两个会话**交错发起、并行执行**，演示多会话能力。
- `evidence/`：脚本自动保存的运行证据（健康检查、完整事件日志、产物清单、汇总）。
- `results/`：两个演示会话最终交付物的副本——`dev/`（记账工具源码 + 66 项测试 + 使用说明）、`analysis/`（分析报告 + 汇总 CSV + 4 张图表）。

```bash
# 服务启动后：
node demo/run-demo.js
```

## 已知限制

- **单用户、无鉴权**：按考题定位设计，无登录/权限体系；请勿暴露公网。
- **shell 无命令白名单**：Agent 可在容器内执行任意命令（这是能力也是风险），隔离依赖容器；本地开发模式没有这层隔离。
- **模型协议**：仅支持 OpenAI Chat Completions 兼容端点（需支持 function calling）；不支持 Anthropic 原生协议/Responses API 端点，接入它们需自行加转换层。
- **非流式 token 输出**：模型回复按"整段消息"展示（工具过程实时），没有逐字打字机效果；长回复等待时间取决于模型。
- **单轮步骤上限**：默认 32 轮工具调用后暂停（防失控消耗），发"继续"可接着推进；可用 `AGENT_MAX_STEPS` 调整。
- **上传限制**：单文件默认 50MB、一次最多 10 个；无断点续传。
- **会话删除不可恢复**；无回收站。
- **容器内 pip 安装的包**在容器重建后丢失（工作区文件在卷里不受影响）。
- **Windows 本地开发模式**：停止任务用 taskkill 兜底，极端情况下正在执行的 shell 子进程可能残留几秒。

## 目录结构

```
├── server/          # Express 服务：REST + SSE + 进程调度 + 持久化
│   ├── index.js     # 路由入口（会话/文件/上传/SSE/健康）
│   ├── runner.js    # Agent 子进程生命周期（启动/停止/崩溃兜底/重启恢复）
│   ├── store.js     # 会话元数据 + JSONL 事件日志 + 上下文重建
│   ├── bus.js       # 进程内事件总线
│   └── config.js    # 环境变量配置
├── cli/agent-cli.js # 真实 Agent CLI（独立进程，JSONL 事件输出）
├── agent/           # Agent 核心：工具 schema/执行器 + 模型循环
├── public/          # 前端 SPA（原生 JS，无构建步骤）
├── demo/            # 演示材料 + 端到端脚本 + 运行证据
├── Dockerfile
├── compose.yaml
└── .env.example
```

## License

MIT
