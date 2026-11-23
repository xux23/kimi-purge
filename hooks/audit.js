#!/usr/bin/env node
/**
 * kimi-purge audit hook — JSONL 审计，1MB 轮转（保留 1 份旧档）。
 * 永不 block：写失败静默退出。热路径优化：先 append、目录缺失（ENOENT）才 mkdir，
 * 每事件 syscall 3 → 2；15 事件全量记录与轮转语义不变。
 * rec.keys 始终记录 payload 顶层字段名，event 未知时附 raw 前 400 字符。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
const DIR = path.join(HOME, 'kimi-purge');
const FILE = path.join(DIR, 'audit.jsonl');
const MAX = 1024 * 1024;

function main() {
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch { /* stdin 可能缺失 */ }

  let evt = {};
  try { evt = JSON.parse(input || '{}'); } catch { evt = { raw: (input || '').slice(0, 2000) }; }

  const rec = {
    ts: new Date().toISOString(),
    event: evt.hookEventName || evt.hook_event_name || evt.event || evt.name || evt.hook_event || 'unknown',
    sessionId: evt.sessionId || evt.session_id,
    cwd: evt.cwd,
    tool: evt.toolName || evt.tool_name,
    decision: evt.decision || (evt.hookSpecificOutput && evt.hookSpecificOutput.permissionDecision),
    detail: evt.permission ? JSON.stringify(evt.permission).slice(0, 500) : undefined,
    keys: Object.keys(evt).join(',').slice(0, 300),
  };
  if (rec.event === 'unknown') rec.raw = (input || '').slice(0, 400);

  const line = JSON.stringify(rec) + '\n';
  try {
    try {
      fs.appendFileSync(FILE, line);
    } catch (e) {
      if (e && e.code === 'ENOENT') { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(FILE, line); }
    }
    try {
      const st = fs.statSync(FILE);
      if (st.size > MAX) {
        try { fs.copyFileSync(FILE, FILE + '.1'); } catch {}
        fs.rmSync(FILE, { force: true });
      }
    } catch {}
  } catch { /* 静默 */ }
}
main();
process.exit(0);
