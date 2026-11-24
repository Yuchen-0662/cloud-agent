import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function intEnv(name, def) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export const config = {
  port: intEnv('PORT', 8787),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
  workspacesDir: path.resolve(
    process.env.WORKSPACES_DIR ||
      path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'workspaces')
  ),
  model: {
    baseUrl: (process.env.MODEL_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.MODEL_API_KEY || '',
    name: process.env.MODEL_NAME || '',
  },
  cmdTimeoutMs: intEnv('CMD_TIMEOUT_SECONDS', 120) * 1000,
  maxSteps: intEnv('AGENT_MAX_STEPS', 32),
  maxUploadMB: intEnv('MAX_UPLOAD_MB', 50),
};

export function modelConfigured() {
  return Boolean(config.model.baseUrl && config.model.apiKey && config.model.name);
}

export function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.workspacesDir, { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'tmp'), { recursive: true });
}
