/**
 * kimi-purge patch-engine 测试（node --test）。
 * 用合成 asar + 合成 controller 源覆盖全部补丁锚点，不依赖真实宿主文件：
 *   1. patchController 全命中 + 字节等长 + ok 校验（含 P10a–d 第二套脱敏失活、P12a–c 死代码清理）
 *   2. patchController 幂等（二次运行全 count=0）
 *   3. parseAsar / findControllerEntry 对合成 asar 的定位
 *   4. applyEngine 全流程（tmp 目录）：补丁落盘、字节数不变、meta 写入、二次 apply already、revert 哈希一致
 *   5. PATCHES 表完整性（锚点/替换体非空、等长约束）
 *   6. P1 复合锚点漂移时 fallback 生效（checkSensitive:!0 全翻转 + marker 仍就位）
 *   7. countMarkers(buffer) 与 markersInAsar(path) 结果一致
 * 运行：node --test tests/   （或 npm test）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  patchController, parseAsar, findControllerEntry,
  applyEngine, revertEngine, countMarkers, markersInAsar, MARKERS,
  PATCHES, P1_FIND, P3_HEAD, P3_TAIL, BACKUP_NAME, META_NAME,
} from '../scripts/patch-engine.mjs';

/** 合成 controller 源：包含 P1 复合字面量、2 处 P1b、$p 脱敏函数、全部提示词层锚点。 */
function makeCtrlSrc() {
  const p3fn = 'function $p(e){let t=e.replaceAll(/sk-[A-Za-z0-9_-]{12,}\\b/g,`[x]`);return t.slice(0,4e3)}';
  const parts = [
    'const uLe={guardMode:`absolute-outside-allowed`,checkSensitive:!0};',
    'const pA={guardMode:`absolute-outside-allowed`,x:1};',
    'const pB={guardMode:`absolute-outside-allowed`,x:2};',
    p3fn,
    ...PATCHES.filter(p => p.id !== 'P1b').map(p => p.find),
  ];
  return '// synthetic controller for tests\n' + parts.join('\n;\n') + '\n';
}

/** 合成最小 asar（按实测头布局：@0=4，@4=头块长，@8=jsonSize+4，@12=jsonSize，JSON@16，数据区=8+@4）。 */
function makeAsar() {
  const pkgBuf = Buffer.from(JSON.stringify({ name: 'kimi-code-app', version: '9.9.9-test' }), 'utf8');
  const ctrlBuf = Buffer.from(makeCtrlSrc(), 'utf8');
  const header = {
    files: {
      'package.json': { offset: '0', size: pkgBuf.length },
      out: { files: { 'controller-test.cjs': { offset: String(pkgBuf.length), size: ctrlBuf.length } } },
    },
  };
  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const headerBlockSize = 8 + jsonBuf.length;
  const buf = Buffer.alloc(16 + jsonBuf.length + pkgBuf.length + ctrlBuf.length);
  buf.writeUInt32LE(4, 0);
  buf.writeUInt32LE(headerBlockSize, 4);
  buf.writeUInt32LE(jsonBuf.length + 4, 8);
  buf.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(buf, 16);
  pkgBuf.copy(buf, 16 + jsonBuf.length);
  ctrlBuf.copy(buf, 16 + jsonBuf.length + pkgBuf.length);
  return { buf, ctrl: ctrlBuf };
}

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

test('patchController：全命中 + 字节等长 + ok', () => {
  const src = makeCtrlSrc();
  const { patched, applied, ok } = patchController(src);
  assert.equal(Buffer.byteLength(patched, 'utf8'), Buffer.byteLength(src, 'utf8'), '字节等长');
  assert.ok(ok, 'ok 校验: ' + JSON.stringify(applied));
  const byId = Object.fromEntries(applied.map(p => [p.id, p.count]));
  assert.equal(byId['P1'], 1);
  assert.equal(byId['P1b'], 2);
  assert.equal(byId['P3'], 1);
  for (const p of PATCHES) if (p.id !== 'P1b') assert.equal(byId[p.id], 1, p.id);
  assert.ok(!patched.includes('absolute-outside-allowed'));
  assert.ok(!patched.includes('[base64-like'), 'base64-like 截断分支已失活');
  assert.ok(!patched.includes('PATH_OUTSIDE_WORKSPACE'), 'PATH_OUTSIDE_WORKSPACE 已清理');
  assert.ok(!patched.includes('PATH_SENSITIVE'), 'PATH_SENSITIVE 已清理');
  assert.ok(patched.includes('kimi-purge-dead'), 'P12 marker 就位');
  for (const m of MARKERS) assert.ok(patched.includes(m), 'marker ' + m);
});

test('patchController：幂等（二次运行全 count=0）', () => {
  const src = makeCtrlSrc();
  const once = patchController(src);
  const twice = patchController(once.patched);
  assert.ok(twice.ok);
  assert.equal(twice.patched, once.patched, '二次运行不应再改动');
  assert.ok(twice.applied.every(p => p.count === 0), JSON.stringify(twice.applied));
});

test('parseAsar / findControllerEntry：合成 asar 定位', () => {
  const { buf, ctrl } = makeAsar();
  const parsed = parseAsar(buf);
  assert.equal(parsed.pkg.name, 'kimi-code-app');
  assert.equal(parsed.pkg.version, '9.9.9-test');
  const e = findControllerEntry(buf);
  assert.equal(e.name, 'controller-test.cjs');
  assert.equal(e.size, ctrl.length);
  assert.equal(buf.slice(e.offset, e.offset + e.size).toString('utf8'), ctrl.toString('utf8'));
});

test('applyEngine/revertEngine：全流程（tmp 目录）', () => {
  const { buf } = makeAsar();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-purge-test-'));
  const asarPath = path.join(dir, 'app.asar');
  fs.writeFileSync(asarPath, buf);
  const origHash = sha(buf);

  const r = applyEngine(dir, { force: true });
  assert.equal(r.ok, true);
  assert.equal(r.hostVersion, '9.9.9-test');
  const patched = fs.readFileSync(asarPath);
  assert.equal(patched.length, buf.length, 'asar 字节数不变');
  const counts = markersInAsar(asarPath);
  for (const m of MARKERS) assert.ok(counts[m] > 0, 'marker ' + m);
  // 备份 + meta
  assert.ok(fs.existsSync(path.join(dir, BACKUP_NAME)), '备份存在');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, META_NAME), 'utf8'));
  assert.equal(meta.hostVersion, '9.9.9-test');
  // 二次 apply → already
  const r2 = applyEngine(dir, { force: true });
  assert.equal(r2.already, true);
  // revert → 哈希与原版一致
  const did = revertEngine(dir, { force: true });
  assert.ok(did.backupRestored);
  assert.equal(sha(fs.readFileSync(asarPath)), origHash, 'revert 后哈希一致');
  assert.ok(!fs.existsSync(path.join(dir, META_NAME)), 'meta 已清理');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('P4–P9 锚点与替换体均非空且替换体不短于必要约束', () => {
  for (const p of PATCHES) {
    assert.ok(p.id && p.find && p.repl, '字段完整: ' + p.id);
    assert.ok(Buffer.byteLength(p.repl, 'utf8') <= Buffer.byteLength(p.find, 'utf8'), '等长约束: ' + p.id);
    assert.ok(!p.repl.includes(p.find), '替换体不含原文: ' + p.id);
  }
});

test('patchController：P1 复合锚点漂移时 fallback 生效', () => {
  // 宿主升级后 P1 复合字面量变了（guardMode 换名），但 checkSensitive:!0 还在 → fallback 全翻转；
  // 保留一处 P1b 锚点保证 kimi-purge-open marker 仍就位。
  const p3fn = 'function $p(e){let t=e.replaceAll(/sk-[A-Za-z0-9_-]{12,}\\b/g,`[x]`);return t.slice(0,4e3)}';
  const parts = [
    'const pA={guardMode:`absolute-outside-allowed`,x:1};',      // P1b → marker 就位
    'const uLe={guardMode:`some-new-mode`,checkSensitive:!0};',  // 漂移的 P1 → fallback
    p3fn,
    ...PATCHES.filter(p => p.id !== 'P1b').map(p => p.find),
  ];
  const src = '// drifted P1 synthetic\n' + parts.join('\n;\n') + '\n';
  const { patched, applied, ok } = patchController(src);
  assert.ok(ok, 'ok 校验: ' + JSON.stringify(applied));
  assert.equal(Buffer.byteLength(patched, 'utf8'), Buffer.byteLength(src, 'utf8'), '字节等长');
  const byId = Object.fromEntries(applied.map(p => [p.id, p.count]));
  assert.equal(byId['P1(fallback)'], 1, 'fallback 命中 1 处');
  assert.ok(!patched.includes('checkSensitive:!0'), '!0 已全部翻转');
  assert.ok(!patched.includes(P1_FIND), '漂移复合锚点不在输出中');
});

test('countMarkers(buffer) 与 markersInAsar(path) 一致', () => {
  const { buf } = makeAsar();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-purge-markers-'));
  const asarPath = path.join(dir, 'app.asar');
  fs.writeFileSync(asarPath, buf);
  assert.deepEqual(countMarkers(buf), markersInAsar(asarPath));
  fs.rmSync(dir, { recursive: true, force: true });
});
