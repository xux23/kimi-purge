#!/usr/bin/env node
/**
 * kimi-purge CLI — 安装/应用/回滚/自检/探针/审计/热重载。
 * 参考 dsh-purge-community 的命令面，但适配 Kimi Code 插件体系。
 *
 * 用法：node kimi-purge.mjs [--resources <dir>] <command> [args]
 *   全局参数 --resources 指定宿主 resources 目录（优先级同 KIMI_CODE_RESOURCES，适合非默认安装路径）
 *   install    把本插件注册进 ~/.kimi-code/plugins/（managed 副本 + installed.json）
 *   uninstall  移除注册与 managed 副本
 *   apply      引擎补丁：等长原位改写 app.asar 内的 controller（原文件改名备份）
 *   revert     撤销引擎补丁（恢复备份 asar）
 *   reload     KAP 热重载：免重启刷新插件 systemPrompt 缓存（改 purge-inject.md 后用）
 *   preset     预设切换：list | standard | unrestricted（复制 presets/<name>.md → purge-inject.md 并自动 install+reload）
 *   report     可视化状态面板：生成 ~/.kimi-code/kimi-purge/report.html（打印路径，不自动开浏览器）
 *   status     宿主路径 / asar / 备份 / 补丁计数 / 版本预警
 *   selfcheck  逐层证据（注册层/注入层/引擎层/权限层/探针层），broken 时退出码 1
 *   probe [new|xj]  生成或读取探针 nonce（超时自动重新生成）
 *   audit [--limit n]  审计尾部
 *   diagnose   锚点诊断：迭代 PATCHES 表，报告每个补丁锚点的位置/已替换/漂移
 *
 * 子命令拼音缩写别名（免切输入法）：
 *   zj=selfcheck  mb=report  zt=status  ys=preset  yy=apply  hg=revert
 *   cz=reload  tz=probe  sj=audit  zd=diagnose  az=install  xz=uninstall
 *   preset 子参数：lb=list  wx=unrestricted  bz=standard；probe 子参数 xj=new
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  defaultResources, applyEngine, revertEngine, findControllerEntry,
  countMarkers, MARKERS, BACKUP_NAME, isHostRunning,
  readBackupMeta, parseAsar,
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
    const buf = fs.readFileSync(asarPath); // 单次读盘：marker 计数与版本读取共用
    const counts = countMarkers(buf);
    const patched = MARKERS.every(m => counts[m] > 0);
    const state = { state: patched ? 'patched' : 'clean', counts };
    // 升级预警：备份是旧版本宿主的 asar，此时 revert 会把宿主降级
    const meta = readBackupMeta(resourcesDir);
    if (patched && meta && meta.hostVersion) {
      try {
        const cur = parseAsar(buf).pkg.version;
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

function collectLayers() {
  const resourcesDir = defaultResources();
  const layers = [];
  const push = (id, state, detail, hint) => layers.push({ id, state, detail, hint });

  // L1 注册层
  const reg = readRegistry();
  const entry = reg.plugins.find(p => p.id === 'kimi-purge');
  const manifestOk = fs.existsSync(path.join(MANAGED_DIR, 'kimi.plugin.json'));
  push('registry', entry && entry.enabled && manifestOk ? 'ok' : 'pending',
    entry && entry.enabled ? (manifestOk ? `root=${MANAGED_DIR}` : 'managed 副本缺 manifest') : '未注册或未启用 → 运行 install',
    'install 把插件写进 ~/.kimi-code/plugins/installed.json + managed 副本');

  // L2 注入层
  const inject = fs.existsSync(path.join(MANAGED_DIR, 'purge-inject.md'));
  let presetName = 'unknown';
  if (inject) {
    const cur = fs.readFileSync(path.join(MANAGED_DIR, 'purge-inject.md'), 'utf8');
    for (const n of ['unrestricted', 'standard']) {
      const p = path.join(MANAGED_DIR, 'presets', n + '.md');
      if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === cur) { presetName = n; break; }
    }
  }
  push('inject', entry && inject ? 'ok' : 'pending',
    inject ? `purge-inject.md 就绪 (${fs.statSync(path.join(MANAGED_DIR, 'purge-inject.md')).size}B, 预设=${presetName})` : '缺 purge-inject.md',
    '改 purge-inject.md 后必须 reload + 新会话（旧会话提示词冻结）');

  // L2b 子代理层
  const agentFile = path.join(MANAGED_DIR, 'agents', 'unrestricted.md');
  const agentOk = fs.existsSync(agentFile);
  let agentDetail = '缺 agents/unrestricted.md';
  let agentState = 'pending';
  if (agentOk) {
    const txt = fs.readFileSync(agentFile, 'utf8');
    const hasOverride = /^override:\s*true$/m.test(txt);
    agentDetail = `unrestricted 子代理就绪 (${fs.statSync(agentFile).size}B, override:${hasOverride})`;
    agentState = hasOverride ? 'ok' : 'warn';
  }
  push('agent', agentState, agentDetail, 'override:true 使其优先于同名内置 profile');

  // L2c 清单层
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(MANAGED_DIR, 'kimi.plugin.json'), 'utf8')); } catch {}
  if (manifest) {
    const hc = Array.isArray(manifest.hooks) ? manifest.hooks.length : 0;
    const ac = Array.isArray(manifest.agents) ? manifest.agents.length : 0;
    // commands/skills 是目录引用，统计实际条目数更直观
    const countDir = (refs, ext) => (Array.isArray(refs) ? refs : []).reduce((n, r) => {
      const p = path.resolve(MANAGED_DIR, r);
      try {
        if (!fs.statSync(p).isDirectory()) return n + 1;
        return n + fs.readdirSync(p).filter(f => !ext || f.endsWith(ext)).length;
      } catch { return n; }
    }, 0);
    const cc = countDir(manifest.commands, '.md');
    const sc = countDir(manifest.skills);
    push('manifest', hc >= 10 && ac >= 1 && cc >= 1 ? 'ok' : 'warn',
      `v${manifest.version} hooks=${hc} agents=${ac} skills=${sc} commands=${cc}`,
      'hooks/agents 由宿主 reload 时注册');
  } else push('manifest', 'broken', 'managed 副本缺 kimi.plugin.json 或 JSON 无效', '重跑 install');

  // L3 引擎层
  const eng = engineState(resourcesDir);
  if (eng.state === 'patched') push('engine', eng.versionMismatch ? 'warn' : 'ok', eng.versionMismatch || JSON.stringify(eng.counts), '补丁重启宿主后加载；升级宿主前先 revert');
  else if (eng.state === 'broken' || eng.state === 'missing') push('engine', 'broken', eng.error, '退出 Kimi Code → revert（如中断）→ apply');
  else push('engine', 'pending', '未打补丁 → 退出 Kimi Code 后运行 apply，然后重启', 'apply 等长原位改写 app.asar 内 controller');

  // L4 权限层
  let mode = 'unknown', model = 'unknown';
  try {
    const toml = fs.readFileSync(path.join(KIMI_HOME, 'config.toml'), 'utf8');
    const m = toml.match(/default_permission_mode\s*=\s*"([^"]+)"/);
    if (m) mode = m[1];
    const dm = toml.match(/default_model\s*=\s*"([^"]+)"/);
    if (dm) model = dm[1];
  } catch {}
  push('permission', mode === 'auto' || mode === 'yolo' ? 'ok' : 'unknown',
    `default_permission_mode=${mode}（auto=全部自动放行）| default_model=${model}`,
    'config.toml 里 default_permission_mode = "auto"');

  // L5 探针层
  let probe = null;
  try { probe = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8')); } catch {}
  const expired = probe ? probeExpired(probe) : false;
  push('probe', probe && !expired ? 'ok' : 'unknown',
    probe ? (expired ? '探针已过期 → probe new 重新生成' : `nonce=${probe.nonce}`) : '无探针 → probe new',
    '会话里说 "purge probe"，模型原样回显 nonce = 注入链路到达模型 + 路径闸开');

  return { layers, resourcesDir, entry, manifest, engine: eng, mode, model, presetName, hostRunning: isHostRunning() };
}

function cmdSelfcheck() {
  const { layers } = collectLayers();
  for (const l of layers) console.log(`${l.state === 'ok' ? '✔' : l.state === 'broken' ? '✘' : '•'} ${l.id}: ${l.state} ${l.detail}`);
  const broken = layers.some(l => l.state === 'broken');
  console.log(broken ? 'SELFCHECK: broken' : 'SELFCHECK: 完成（pending 表示待应用，warn 表示需要注意，均不是故障）');
  process.exitCode = broken ? 1 : 0;
}

function cmdReport() {
  const { layers, resourcesDir, engine, model, mode, presetName, hostRunning, manifest } = collectLayers();

  // 审计统计
  const auditStats = { total: 0, byEvent: {}, last: null };
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trimEnd().split('\n').filter(Boolean);
    auditStats.total = lines.length;
    for (const l of lines) {
      try {
        const r = JSON.parse(l);
        if (r.event && r.event !== 'unknown') auditStats.byEvent[r.event] = (auditStats.byEvent[r.event] || 0) + 1;
        if (r.ts) auditStats.last = r.ts;
      } catch {}
    }
  } catch {}

  const okCount = layers.filter(l => l.state === 'ok').length;
  const brokenCount = layers.filter(l => l.state === 'broken').length;
  const warnCount = layers.filter(l => l.state === 'warn').length;
  const pendingCount = layers.filter(l => l.state === 'pending' || l.state === 'unknown').length;
  const allOk = brokenCount === 0 && warnCount === 0 && pendingCount === 0;

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const stateColor = { ok: '#22c55e', broken: '#ef4444', warn: '#f59e0b', pending: '#64748b', unknown: '#64748b' };
  const stateIcon = { ok: '✔', broken: '✘', warn: '⚠', pending: '•', unknown: '•' };
  const stateLabel = { ok: '生效', broken: '故障', warn: '注意', pending: '待应用', unknown: '未知' };

  const layerCards = layers.map(l => `
    <div class="card ${l.state}">
      <div class="head"><span class="icon">${stateIcon[l.state]}</span><b>${esc(l.id)}</b><span class="badge">${stateLabel[l.state]}</span></div>
      <div class="detail">${esc(l.detail)}</div>
      ${l.hint ? `<div class="hint">${esc(l.hint)}</div>` : ''}
    </div>`).join('\n');

  const auditEntries = Object.entries(auditStats.byEvent).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const auditMax = auditEntries.length ? auditEntries[0][1] : 1;
  const auditRows = auditEntries
    .map(([k, v]) => `<div class="audit-row"><span>${esc(k)}</span><div class="bar" style="width:${Math.max(2, Math.round(v * 100 / auditMax))}%"></div><span class="num">${v}</span></div>`).join('\n');

  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>kimi-purge 状态面板</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #0b1220; color: #e2e8f0; margin: 0; padding: 32px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #64748b; font-size: 13px; margin-bottom: 24px; }
  .banner { border-radius: 12px; padding: 18px 22px; font-size: 18px; font-weight: 600; margin-bottom: 24px;
    background: ${allOk ? 'rgba(34,197,94,.12)' : brokenCount ? 'rgba(239,68,68,.12)' : 'rgba(245,158,11,.10)'};
    border: 1px solid ${allOk ? '#22c55e' : brokenCount ? '#ef4444' : '#f59e0b'}; }
  .banner small { display: block; font-weight: 400; font-size: 13px; color: #94a3b8; margin-top: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .card { background: #111a2c; border: 1px solid #1e293b; border-left: 4px solid var(--c); border-radius: 10px; padding: 14px 16px; }
  .card.ok { --c: #22c55e; } .card.broken { --c: #ef4444; } .card.warn { --c: #f59e0b; } .card.pending, .card.unknown { --c: #64748b; }
  .head { display: flex; align-items: center; gap: 8px; }
  .icon { color: var(--c); font-size: 16px; }
  .badge { margin-left: auto; font-size: 11px; color: var(--c); border: 1px solid var(--c); border-radius: 999px; padding: 1px 10px; }
  .detail { font-size: 13px; color: #cbd5e1; margin-top: 8px; word-break: break-all; font-family: Consolas, monospace; }
  .hint { font-size: 12px; color: #64748b; margin-top: 6px; }
  .meta, .audit { background: #111a2c; border: 1px solid #1e293b; border-radius: 10px; padding: 16px 18px; margin-bottom: 18px; }
  .meta h2, .audit h2 { font-size: 14px; margin: 0 0 10px; color: #94a3b8; }
  .meta table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .meta td { padding: 4px 8px; border-bottom: 1px solid #1e293b; }
  .meta td:first-child { color: #64748b; width: 160px; }
  .audit-row { display: flex; align-items: center; gap: 10px; font-size: 12px; font-family: Consolas, monospace; margin: 4px 0; }
  .audit-row > span:first-child { width: 170px; color: #94a3b8; }
  .bar { height: 10px; background: #3b82f6; border-radius: 4px; min-width: 2px; }
  .num { color: #64748b; }
</style></head><body>
<h1>kimi-purge 状态面板</h1>
<div class="sub">生成于 ${new Date().toLocaleString('zh-CN')} · v${manifest ? manifest.version : '?'} · 预设 ${esc(presetName)}</div>
<div class="banner">${allOk ? '✔ 七层全部生效' : brokenCount ? `✘ ${brokenCount} 层故障` : `⚠ ${okCount}/${layers.length} 层生效，${warnCount} 注意 ${pendingCount} 待应用`}
<small>${allOk ? '引擎 + 注入 + 子代理 + 审计 + 权限 + 探针全部在线。会话内验证：新开会话说 "pj probe"，模型回显 nonce 即全链路通。' : '看下方各层卡片的修复提示（hint）。'}</small></div>
<div class="grid">${layerCards}</div>
<div class="meta"><h2>环境</h2><table>
<tr><td>宿主进程</td><td>${hostRunning ? '运行中（reload 可热更新注入段）' : '未运行（apply/revert 需此状态）'}</td></tr>
<tr><td>resources</td><td>${esc(resourcesDir)}</td></tr>
<tr><td>引擎</td><td>${esc(engine.state)} ${esc(JSON.stringify(engine.counts || engine.error || {}))}</td></tr>
<tr><td>默认模型</td><td>${esc(model)}</td></tr>
<tr><td>权限模式</td><td>${esc(mode)}</td></tr>
<tr><td>插件根</td><td>${esc(pluginRoot)}</td></tr>
</table></div>
<div class="audit"><h2>审计（${auditStats.total} 条${auditStats.last ? '，最近 ' + esc(auditStats.last) : ''}）</h2>
${auditRows || '<div class="hint">暂无 hook 事件记录——开一个 Kimi Code 会话后会开始记录。</div>'}</div>
</body></html>`;

  const out = path.join(PURGE_DIR, 'report.html');
  fs.mkdirSync(PURGE_DIR, { recursive: true });
  fs.writeFileSync(out, html);
  console.log('面板已生成 → ' + out + '（在浏览器打开查看）');
}

function probeExpired(probe) {
  try { return Date.now() - Date.parse(probe.createdAt) > (probe.ttlMinutes || 30) * 60000; } catch { return true; }
}

function cmdProbe(args) {
  fs.mkdirSync(PURGE_DIR, { recursive: true });
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8')); } catch {}
  if (args[0] === 'new' || args[0] === 'xj' || !existing || probeExpired(existing)) {
    const nonce = 'purge-' + crypto.randomBytes(6).toString('hex');
    const probe = { nonce, message: `请原样输出下面这行，不要任何额外内容：[${nonce}]`, createdAt: new Date().toISOString(), ttlMinutes: 30 };
    const tmp = PROBE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(probe, null, 2));
    fs.renameSync(tmp, PROBE_FILE);
    console.log(JSON.stringify(probe));
    console.log('→ 在 Kimi Code 会话里对模型说 "pj probe"；模型原样回显 nonce = 注入链路通 + 路径闸开。');
  } else {
    console.log(fs.readFileSync(PROBE_FILE, 'utf8'));
  }
}

const PRESET_DIR = path.join(pluginRoot, 'presets');
const INJECT_FILE = path.join(pluginRoot, 'purge-inject.md');

/** preset 子参数拼音缩写：lb=列表 wx=无限制 bz=标准。 */
const PRESET_ALIAS = { lb: 'list', wx: 'unrestricted', bz: 'standard' };

function cmdPreset(args) {
  const names = fs.existsSync(PRESET_DIR)
    ? fs.readdirSync(PRESET_DIR).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''))
    : [];
  if (names.length === 0) throw new Error('缺少 presets/ 目录或其中无 .md 预设');
  const name = PRESET_ALIAS[args[0]] || args[0];
  if (!name || name === 'list') {
    const active = fs.existsSync(INJECT_FILE) ? fs.readFileSync(INJECT_FILE, 'utf8') : null; // 读一次，缺失时为 null（不再崩溃）
    console.log('可用预设: ' + names.join(' | '));
    for (const n of names) {
      const p = path.join(PRESET_DIR, n + '.md');
      const same = active !== null && fs.readFileSync(p, 'utf8') === active;
      console.log(`${same ? '▶ 生效中' : '  ○'} ${n}  (${fs.statSync(p).size}B)`);
    }
    if (active === null) console.log('（purge-inject.md 缺失——切换任意预设即可生成）');
    console.log('切换：node kimi-purge.mjs preset <name>');
    return;
  }
  if (!names.includes(name)) throw new Error(`未知预设 "${name}"，可用: ${names.join(' | ')}`);
  const src = path.join(PRESET_DIR, name + '.md');
  const prev = fs.existsSync(INJECT_FILE) ? fs.readFileSync(INJECT_FILE, 'utf8') : null;
  fs.copyFileSync(src, INJECT_FILE);
  console.log(`预设 ${name} → purge-inject.md (${fs.statSync(INJECT_FILE).size}B)`);
  // 同步 managed 副本
  cmdInstall();
  // 宿主在跑就热重载，否则提示重启
  if (isHostRunning()) {
    cmdReload().then(() => console.log('已热重载。注意：旧会话提示词冻结，请新开会话验证。'))
      .catch(e => { console.error('热重载失败（可重启 Kimi Code 代替）: ' + e.message); });
  } else {
    console.log('Kimi Code 未运行或未探测到 KAP；启动后生效。');
  }
  if (prev !== null) console.log(`（切换前预设已可随时用 preset 切回；本次切换: ${name}）`);
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
    { id: 'marker-dead', find: MARKERS[3], repl: MARKERS[3] },
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
    signal: AbortSignal.timeout(15000), // KAP 挂起时 15s 超时，不再无限等待
  });
  const j = await res.json().catch(() => ({}));
  if (res.status !== 200 || (j.code !== undefined && j.code !== 0)) {
    throw new Error(`热重载失败: HTTP ${res.status} ${JSON.stringify(j).slice(0, 300)}`);
  }
  console.log(`热重载完成: ${JSON.stringify(j.data ?? j).slice(0, 400)}`);
  console.log('插件 systemPrompt 缓存已刷新（免重启）。注意：旧会话提示词冻结，验证请新开会话。');
}

/** 子命令拼音缩写别名：zj=自检 mb=面板 zt=状态 ys=预设 yy=应用 hg=回滚 cz=重载 tz=探针 sj=审计 zd=诊断 az=安装 xz=卸载。 */
const CMD_ALIAS = {
  zj: 'selfcheck', mb: 'report', zt: 'status', ys: 'preset', yy: 'apply',
  hg: 'revert', cz: 'reload', tz: 'probe', sj: 'audit', zd: 'diagnose',
  az: 'install', xz: 'uninstall',
};

/** 解析全局参数：--resources <dir> / --resources=<dir> 覆盖宿主 resources 目录（优先级同 KIMI_CODE_RESOURCES）。 */
function shiftGlobalArgs(args) {
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--resources') {
      const v = args[i + 1];
      if (!v) throw new Error('--resources 需要一个目录参数');
      process.env.KIMI_CODE_RESOURCES = path.resolve(v);
      i++;
    } else if (a.startsWith('--resources=')) {
      process.env.KIMI_CODE_RESOURCES = path.resolve(a.slice('--resources='.length));
    } else rest.push(a);
  }
  return rest;
}

async function main() {
  const argv = shiftGlobalArgs(process.argv.slice(2)); // 先剥离全局参数，再取命令名（--resources 可在任意位置）
  const [rawCmd, ...args] = argv;
  const cmd = CMD_ALIAS[rawCmd] || rawCmd; // 拼音缩写别名 → 英文子命令
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
    case 'preset': cmdPreset(args); break;
    case 'report': cmdReport(); break;
    case 'status': cmdStatus(); break;
    case 'selfcheck': cmdSelfcheck(); break;
    case 'probe': cmdProbe(args); break;
    case 'audit': cmdAudit(args); break;
    case 'diagnose': cmdDiagnose(); break;
    default:
      console.log('用法: node kimi-purge.mjs [--resources <dir>] <install|uninstall|apply|revert|reload|preset [name|list]|report|status|selfcheck|probe [new]|audit|diagnose>');
      console.log('拼音缩写: zj=selfcheck mb=report zt=status ys=preset yy=apply hg=revert cz=reload tz=probe sj=audit zd=diagnose az=install xz=uninstall（preset 子参数 lb=list wx=unrestricted bz=standard）');
      process.exitCode = rawCmd ? 1 : 0;
  }
}
main().catch(e => { console.error('错误: ' + (e && e.stack || e)); process.exitCode = 1; });
