#!/usr/bin/env node
/**
 * 发布前安全检查：扫描 git 已跟踪文件，确保没有真实凭据。
 * 用法: node scripts/check-secrets.js
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const patterns = [
  { name: '考试临时Key', re: /exam_[A-Za-z0-9]{20,}/ },
  { name: 'OpenAI风格Key', re: /sk-[A-Za-z0-9]{32,}/ },
  { name: 'GitHub令牌', re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'AWS密钥', re: /AKIA[0-9A-Z]{16}/ },
  { name: '私钥块', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

let bad = 0;
for (const f of files) {
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) {
      // .env.example 里的 sk-xxx 占位符不算
      if (f === '.env.example' && /sk-xxx/.test(m[0])) continue;
      console.error(`❌ ${f}: 命中 ${p.name} (${m[0].slice(0, 10)}…)`);
      bad++;
    }
  }
}
if (files.includes('.env')) { console.error('❌ .env 被 git 跟踪了！'); bad++; }
if (bad) { console.error(`\n发现 ${bad} 处风险，禁止发布。`); process.exit(1); }
console.log(`✅ 已扫描 ${files.length} 个已跟踪文件，未发现凭据泄露。`);
