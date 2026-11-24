# 云端 Agent 助手工作台
# 单容器同时提供：Web 工作台 + 会话服务 + Agent CLI 运行环境
# REGISTRY 可切换镜像源：默认国内加速站；海外环境可 --build-arg REGISTRY=docker.io/library
ARG REGISTRY=docker.m.daocloud.io/library
FROM ${REGISTRY}/node:22-bookworm-slim

# Agent 处理日常工作所需的系统工具（文件检索/文本处理/压缩包/图片信息/Python 数据分析等）
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      git curl wget ca-certificates \
      ripgrep file unzip zip xz-utils \
      poppler-utils imagemagick ffmpeg \
      jq sqlite3 tree \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    WORKSPACES_DIR=/data/workspaces \
    CMD_TIMEOUT_SECONDS=120

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY cli ./cli
COPY agent ./agent
COPY public ./public

RUN mkdir -p /data/workspaces
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
