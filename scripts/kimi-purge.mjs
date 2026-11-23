#!/usr/bin/env node
/**
 * kimi-purge CLI — 安装/应用/回滚/自检/探针/审计/热重载。
 * 参考 dsh-purge-community 的命令面，但适配 Kimi Code 插件体系。
 *
 * 用法：node kimi-purge.mjs <command> [args]
 *   install    把本插件注册进 ~/.kimi-code/plugins/（managed 副本 + installed.json）
 *   uninstall  移除注册与 managed 副本
 *   apply      引擎补丁：等长原位改写 app.asar 内的 controller（原文件改名备份）
 *   revert     撤销引擎补丁（恢复备份 asar）
 *   reload     KAP 热重载：免重启刷新插件 systemPrompt 缓存（改 purge-inject.md 后用）
 *   status     宿主路径 / asar / 备份 / 补丁计数 / 版本预警
 *   selfcheck  逐层证据（注册层/注入层/引擎层/权限层/探针层），broken 时退出码 1
 *   probe [new]  生成或读取探针 nonce（超时自动重新生成）
 *   audit [--limit n]  审计尾部
 *   diagnose   锚点诊断：迭代 PATCHES 表，报告每个补丁锚点的位置/已替换/漂移
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  defaultResources, applyEngine, revertEngine, findControllerEntry,
  markersInAsar, MARKERS, BACKUP_NAME, isHostRunning,
  readAsarVersion, readBackupMeta,
  PATCHES, P1_FIND, P1_REPL, P3_HEAD, P3_TAIL,
} from './patch-engine.mjs';

const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
const PURGE_DIR = path.join(KIMI_HOME, 'kimi-purge');
const PLUGINS_DIR = path.join(KIMI_HOME, 'plugins');
const MANAGED_DIR = path.join(PLUGINS_DIR, 'managed', 'kimi-purge');
const REGISTRY = path.join(PLUGINS_DIR, 'installed.json');
const PROBE_FILE = path.join(PURGE_DIR, 'probe.json');
const AUDIT_FILE = path.join(PURGE_DIR, 'audit.jsonl');

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch { return { version: 1, plugins: [] }; }
}
function writeRegistry(reg) {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  const tmp = REGISTRY + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, REGISTRY);
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function cmdInstall() {
  if (!fs.existsSync(path.join(pluginRoot, 'kimi.plugin.json'))) throw new Error('插件根缺少 kimi.plugin.json: ' + pluginRoot);
  fs.rmSync(MANAGED_DIR, { recursive: true, force: true });
  copyDir(pluginRoot, MANAGED_DIR);
  const reg = readRegistry();
  const now = new Date().toISOString();
  const entry = {
    id: 'kimi-purge', root: MANAGED_DIR, enabled: true,
    installedAt: now, updatedAt: now,
    originalSource: 'local-path', source: 'local-path', origin: 'custom',
  };
  const i = reg.plugins.findIndex(p => p.id === 'kimi-purge');
  if (i >= 0) reg.plugins[i] = { ...reg.plugins[i], ...entry }; else reg.plugins.push(entry);
  writeRegistry(reg);
  fs.mkdirSync(PURGE_DIR, { recursive: true });
  console.log(`已安装插件副本 → ${MANAGED_DIR}`);
  console.log(`已写注册表 → ${REGISTRY}`);
  console.log('在 Kimi Code 会话里运行 /plugins reload，或重启 Kimi Code，或 CLI reload 生效。');
}

function cmdUninstall() {
  const reg = readRegistry();
  reg.plugins = reg.plugins.filter(p => p.id !== 'kimi-purge');
  writeRegistry(reg);
  fs.rmSync(MANAGED_DIR, { recursive: true, force: true });
  console.log('已从注册表移除并删除 managed 副本。引擎补丁未动（如需撤销运行 revert）。');
}

function engineState(resourcesDir) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  const backupPath = path.join(resourcesDir, BACKUP_NAME);
  if (fs.existsSync(asarPath)) {
    const counts = markersInAsar(asarPath);
    const patched = MARKERS.every(m => counts[m] > 0);
    const state = { state: patched ? 'patched' : 'clean', counts };
    // 升级预警：备份是旧版本宿主的 asar，此时 revert 会把宿主降级
    const meta = readBackupMeta(resourcesDir);
    if (patched && meta && meta.hostVersion) {
      try {
        const cur = readAsarVersion(asarPath);
        if (cur !== meta.hostVersion) state.versionMismatch = `宿主 ${cur} ≠ 备份 ${meta.hostVersion}（备份为旧版；升级场景应先 revert → 升级 → 再 apply，否则 revert 会降级宿主）`;
      } catch {}
    }
    return state;
  }
  if (fs.existsSync(backupPath)) return { state: 'broken', error: 'app.asar 缺失但有备份（上次操作中断）→ 运行 revert' };
  return { state: 'missing', error: '未找到 app.asar' };
}

function cmdStatus() {
  const resourcesDir = defaultResources();
  console.log(`KIMI_HOME      ${KIMI_HOME}`);
  console.log(`resources      ${resourcesDir}`);
  console.log(`插件根          ${pluginRoot}`);
  console.log(`managed 副本    ${MANAGED_DIR} ${fs.existsSync(MANAGED_DIR) ? '(在)' : '(无)'}`);
  const eng = engineState(resourcesDir);
  console.log(`引擎状态        ${eng.state} ${JSON.stringify(eng.counts || eng.error || {})}`);
  if (eng.versionMismatch) console.log(`⚠ 版本预警      ${eng.versionMismatch}`);
  console.log(`备份            ${path.join(resourcesDir, BACKUP_NAME)} ${fs.existsSync(path.join(resourcesDir, BACKUP_NAME)) ? '(在)' : '(无)'}`);
  console.log(`宿主进程        ${isHostRunning() ? '运行中' : '未运行'}`);
}

function cmdSelfcheck() {
  const resourcesDir = defaultResources();
  const layers = [];
  const push = (id, state, detail) => { layers.push({ id, state, detail }); console.log(`${state === 'ok' ? '✔' : state === 'broken' ? '✘' : '•'} ${id}: ${state} ${detail || ''}`); };

  // L1 注册层
  const reg = readRegistry();
  const entry = reg.plugins.find(p => p.id === 'kimi-purge');
  const manifestOk = fs.existsSync(path.join(MANAGED_DIR, 'kimi.plugin.json'));
  push('registry', entry && entry.enabled && manifestOk ? 'ok' : 'pending',
    entry && entry.enabled ? (manifestOk ? `root=${MANAGED_DIR}` : 'managed 副本缺 manifest') : '未注册或未启用 → 运行 install');

  // L2 注入层
  const inject = fs.existsSync(path.join(MANAGED_DIR, 'purge-inject.md'));
  push('inject', entry && inject ? 'ok' : 'pending', inject ? 'purge-inject.md 就绪' : '缺 purge-inject.md');

  // L3 引擎层
  const eng = engineState(resourcesDir);
  if (eng.state === 'patched') push('engine', eng.versionMismatch ? 'warn' : 'ok', eng.versionMismatch || JSON.stringify(eng.counts));
  else if (eng.state === 'broken' || eng.state === 'missing') push('engine', 'broken', eng.error);
  else push('engine', 'pending', '未打补丁 → 退出 Kimi Code 后运行 apply，然后重启');

  // L4 权限层
  let mode = 'unknown';
  try {
    const toml = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
    const m = toml.match(/default_permission_mode\s*=\s*"([^"]+)"/);
    if (m) mode = m[1];
  } catch {}
  push('permission', mode === 'auto' || mode === 'yolo' ? 'ok' : 'unknown', `default_permission_mode=${mode}（auto=全部自动放行）`);

  // L5 探针层
  let probe = null;
  try { probe = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8')); } catch {}
  const expired = probe ? probeExpired(probe) : false;
  push('probe', probe && !expired ? 'ok' : 'unknown',
    probe ? (expired ? '探针已过期 → probe new 重新生成' : `nonce=${probe.nonce}（会话里说 "purge probe" 验证回显）`) : '无探针 → probe new');

  const broken = layers.some(l => l.state === 'broken');
  console.log(broken ? 'SELFCHECK: broken' : 'SELFCHECK: 完成（pending 表示待应用，warn 表示需要注意，均不是故障）');
  process.exitCode = broken ? 1 : 0;
}

function probeExpired(probe) {
  try { return Date.now() - Date.parse(probe.createdAt) > (probe.ttlMinutes || 30) * 60000; } catch { return true; }
}

function cmdProbe(args) {
  fs.mkdirSync(PURGE_DIR, { recursive: true });
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8')); } catch {}
  if (args[0] === 'new' || !existing || probeExpired(existing)) {
    const nonce = 'purge-' + crypto.randomBytes(6).toString('hex');
    const probe = { nonce, message: `请原样输出下面这行，不要任何额外内容：[${nonce}]`, createdAt: new Date().toISOString(), ttlMinutes: 30 };
    const tmp = PROBE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(probe, null, 2));
    fs.renameSync(tmp, PROBE_FILE);
    console.log(JSON.stringify(probe));
    console.log('→ 在 Kimi Code 会话里对模型说 "purge probe"；模型原样回显 nonce = 注入链路通 + 路径闸开。');
  } else {
    console.log(fs.readFileSync(PROBE_FILE, 'utf8'));
  }
}

function cmdAudit(args) {
  const limit = Number((args.find(a => /^\d+$/.test(a)) || '20'));
  if (!fs.existsSync(AUDIT_FILE)) { console.log('（暂无审计记录）'); return; }
  const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trimEnd().split('\n');
  for (const l of lines.slice(-limit)) console.log(l);
}

function cmdDiagnose() {
  const resourcesDir = defaultResources();
  const asarPath = path.join(resourcesDir, 'app.asar');
  let ctrlSrc = null;
  try {
    const buf = fs.readFileSync(asarPath);
    const { offset, size, name } = findControllerEntry(buf);
    ctrlSrc = buf.slice(offset, offset + size).toString('utf8');
    console.log(`controller 源：${asarPath} :: ${name} @${offset} (${size}B)`);
  } catch (e) { console.log('无法取得 controller 源: ' + e.message); return; }

  // 锚点表：P1 + PATCHES 表 + P3 边界 + markers —— 与 patchController 同源，不会双份漂移
  const anchors = [
    { id: 'P1', find: P1_FIND, repl: P1_REPL },
    ...PATCHES.map(p => ({ id: p.id, find: p.find, repl: p.repl })),
    { id: 'P3-头', find: P3_HEAD, repl: MARKERS[1] },
    { id: 'P3-尾', find: P3_TAIL, repl: MARKERS[1] },
    { id: 'marker-open', find: MARKERS[0], repl: MARKERS[0] },
    { id: 'marker-redact', find: MARKERS[1], repl: MARKERS[1] },
    { id: 'marker-authority', find: MARKERS[2], repl: MARKERS[2] },
  ];
  let drifted = 0;
  for (const a of anchors) {
    const i = ctrlSrc.indexOf(a.find);
    let status;
    if (i !== -1) status = '@' + i;
    else if (ctrlSrc.includes(a.repl)) status = '已替换 ✔';
    else { status = '漂移 ✘（宿主升级改了锚点，需更新补丁表）'; drifted++; }
    console.log(`${a.id.padEnd(16)} ${JSON.stringify(a.find.slice(0, 60))}…  ${status}`);
  }
  if (drifted > 0) { console.log(`DIAGNOSE: ${drifted} 个锚点漂移`); process.exitCode = 1; }
  else console.log('DIAGNOSE: 全部锚点正常（已替换 = 补丁已应用）');
}

/** KAP 热重载：POST /api/v1/plugins 免重启刷新 systemPrompt 缓存。 */
async function cmdReload() {
  const tokenPath = path.join(KIMI_HOME, 'server.token');
  if (!fs.existsSync(tokenPath)) throw new Error('缺少 ' + tokenPath + '（KAP server 未启动，先运行 Kimi Code）');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  const instDir = path.join(KIMI_HOME, 'server', 'instances');
  let port = null, best = 0;
  for (const f of fs.readdirSync(instDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(instDir, f), 'utf8'));
      const t = Number(j.started_at) || 0;
      if (j.port && t > best) { best = t; port = j.port; }
    } catch {}
  }
  if (!port) throw new Error('未找到 KAP server instance（Kimi Code 未运行？）');
  if (!fs.existsSync(path.join(pluginRoot, 'kimi.plugin.json'))) throw new Error('插件根缺少 kimi.plugin.json: ' + pluginRoot);
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/plugins`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: pluginRoot }),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status !== 200 || (j.code !== undefined && j.code !== 0)) {
    throw new Error(`热重载失败: HTTP ${res.status} ${JSON.stringify(j).slice(0, 300)}`);
  }
  console.log(`热重载完成: ${JSON.stringify(j.data ?? j).slice(0, 400)}`);
  console.log('插件 systemPrompt 缓存已刷新（免重启）。注意：旧会话提示词冻结，验证请新开会话。');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'install': cmdInstall(); break;
    case 'uninstall': cmdUninstall(); break;
    case 'apply': {
      const force = args.includes('--force');
      const r = await applyEngine(defaultResources(), { force });
      console.log(JSON.stringify(r, null, 2));
      console.log(r.already ? '无需重复应用。' : '完成。请重启 Kimi Code（补丁重启后才加载）。');
      break;
    }
    case 'revert': {
      const force = args.includes('--force');
      const did = revertEngine(defaultResources(), { force });
      console.log(JSON.stringify(did));
      console.log('已回滚引擎补丁。请重启 Kimi Code。');
      break;
    }
    case 'reload': await cmdReload(); break;
    case 'status': cmdStatus(); break;
    case 'selfcheck': cmdSelfcheck(); break;
    case 'probe': cmdProbe(args); break;
    case 'audit': cmdAudit(args); break;
    case 'diagnose': cmdDiagnose(); break;
    default:
      console.log('用法: node kimi-purge.mjs <install|uninstall|apply|revert|reload|status|selfcheck|probe [new]|audit|diagnose>');
      process.exitCode = cmd ? 1 : 0;
  }
}
main().catch(e => { console.error('错误: ' + (e && e.stack || e)); process.exitCode = 1; });
