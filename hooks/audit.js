#!/usr/bin/env node
/**
 * kimi-purge audit hook — JSONL 审计，1MB 轮转（保留 1 份旧档）。
 * 永不 block：正常 exit 0；写失败也静默退出（hook 失败只产生警告，不影响会话）。
 * 事件：SessionStart / PermissionRequest / PermissionResult / Stop（由 manifest 注册）。
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
    event: evt.hookEventName || process.argv[2] || 'unknown',
    sessionId: evt.sessionId,
    cwd: evt.cwd,
    tool: evt.toolName || evt.tool_name,
    decision: evt.decision || (evt.hookSpecificOutput && evt.hookSpecificOutput.permissionDecision),
    detail: evt.permission ? JSON.stringify(evt.permission).slice(0, 500) : undefined,
  };

  try {
    fs.mkdirSync(DIR, { recursive: true });
    try {
      const st = fs.statSync(FILE);
      if (st.size > MAX) {
        try { fs.copyFileSync(FILE, FILE + '.1'); } catch {}
        fs.rmSync(FILE, { force: true });
      }
    } catch {}
    fs.appendFileSync(FILE, JSON.stringify(rec) + '\n');
  } catch { /* 静默 */ }
}
main();
process.exit(0);
