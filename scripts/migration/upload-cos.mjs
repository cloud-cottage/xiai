#!/usr/bin/env node
/**
 * xiai 影像产物 → CloudBase 对象存储 通用上传器（P0 步骤②）
 *
 * 用法
 * ----
 *   node scripts/migration/upload-cos.mjs --src <本地目录> --prefix xiai/display/ [选项]
 *
 * 选项
 * ----
 *   --src <dir>          要上传的本地目录（递归；cloudPath ＝ <prefix><相对路径>）
 *   --prefix <p>         对象前缀（须以 / 结尾），如 xiai/display/、xiai/thumb/、xiai/originals/
 *   --env <envId>        云环境（默认 liwu-cny1313-d1gb2fukyb7cb19bb）
 *   --concurrency N      并发（默认 8，**硬上限 8**）
 *   --sample N           只随机抽 N 件上传（验收抽样用；配 --seed 定序）
 *   --seed <n>           抽样随机种子（默认 20261109）
 *   --limit N            只取前 N 件（按路径排序）
 *   --yes                真正写云；**不加本参数＝dry-run**（与 liwu 迁移脚本同一约定）
 *   --mbps <n>           dry-run 预估用的上行带宽（默认 10 MB/s）
 *
 * 凭据（不落盘、不打印）
 *   取 `~/.config/.cloudbase/auth.json` 的 `credential.tmpSecretId / tmpSecretKey / tmpToken`
 *   （临时凭据，`tmpExpired` 过期则报错退出，提示重新 `tcb login`）。
 *
 * 幂等 / 断点续传
 *   ① 上传前先列远端清单（`storage.walkCloudDir(prefix)`），**同 size 一律跳过**；
 *   ② 传完再列一次远端做对账（件数 + size 逐件比对），对不上 ⇒ 非零退出；
 *   ③ 进度落 `scripts/migration/.state/upload-<prefix>.json`（每 25 件落一次），
 *      中断后**直接重跑**即可续传 —— 远端清单就是断点真源。
 *
 * 末尾读数：`上传 N / 跳过 M / 失败 K ＋ 总字节`。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import CloudBase from '@cloudbase/manager-node';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV = 'liwu-cny1313-d1gb2fukyb7cb19bb';

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : fallback;
};
const has = (name) => argv.includes(name);

const SRC = flag('--src');
const PREFIX = flag('--prefix');
const ENV_ID = flag('--env', DEFAULT_ENV);
const YES = has('--yes');
const DRY = !YES;
const LIMIT = Math.max(0, Number(flag('--limit', 0)) || 0);
const SAMPLE = Math.max(0, Number(flag('--sample', 0)) || 0);
const SEED = Number(flag('--seed', 20261109)) || 20261109;
const MBPS = Math.max(1, Number(flag('--mbps', 10)) || 10);
const CONCURRENCY = Math.max(1, Math.min(8, Number(flag('--concurrency', 8)) || 8)); // 硬上限 8
const STATE_FILE = path.join(HERE, '.state', `upload-${(PREFIX || 'unset').replace(/[^a-z0-9]+/gi, '_')}.json`);

if (!SRC || !PREFIX) {
  console.error('用法: node upload-cos.mjs --src <本地目录> --prefix <xiai/xxx/> [--yes] [--sample N] …');
  process.exit(2);
}
if (!PREFIX.endsWith('/')) {
  console.error(`[FATAL] --prefix 须以 / 结尾：${PREFIX}`);
  process.exit(2);
}

// ── 凭据（只读 auth.json；**任何情况下不打印密钥**）──────────────────────────
function readCredential() {
  const file = path.join(os.homedir(), '.config/.cloudbase/auth.json');
  const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = auth.credential || auth;
  const need = ['tmpSecretId', 'tmpSecretKey', 'tmpToken'];
  for (const k of need) if (!c[k]) throw new Error(`auth.json 缺少 ${k}，请重新 tcb login`);
  const leftMs = (c.tmpExpired || 0) - Date.now();
  if (leftMs <= 0) throw new Error('CloudBase 临时凭据已过期，请重新 tcb login 后重跑');
  if (leftMs < 10 * 60 * 1000) console.warn(`⚠️ 临时凭据仅剩 ${Math.round(leftMs / 60000)} 分钟，建议先 tcb login`);
  return c;
}

const human = (n) => {
  let v = n;
  for (const unit of ['B', 'KiB', 'MiB', 'GiB']) {
    if (v < 1024 || unit === 'GiB') return unit === 'B' ? `${Math.round(v)} B` : `${v.toFixed(1)} ${unit}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} GiB`;
};
const group = (n) => n.toLocaleString('en-US');

// ── 本地清单 ────────────────────────────────────────────────────────────────
function walkLocal(dir) {
  const root = path.resolve(dir);
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        out.push({ abs, rel, size: fs.statSync(abs).size });
      }
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** 确定性洗牌（抽样用：同 seed ⇒ 同一批，便于复核） */
function seededSample(items, n, seed) {
  const arr = items.slice();
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

// ── 并发池（≤8）─────────────────────────────────────────────────────────────
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function withRetry(fn, label, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  console.warn(`  ✗ ${label}: ${String(lastErr && lastErr.message ? lastErr.message : lastErr).slice(0, 200)}`);
  throw lastErr;
}

function saveState(extra) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        { prefix: PREFIX, src: path.resolve(SRC), env: ENV_ID, updatedAt: new Date().toISOString(), ...extra },
        null,
        2,
      ),
    );
  } catch {
    /* 状态文件失败不影响主流程 */
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  const cred = readCredential();
  const app = new CloudBase({
    secretId: cred.tmpSecretId,
    secretKey: cred.tmpSecretKey,
    token: cred.tmpToken,
    envId: ENV_ID,
  });

  console.log(`[cfg] env=${ENV_ID} prefix=${PREFIX} concurrency=${CONCURRENCY} mode=${DRY ? 'dry-run' : 'WRITE'}`);
  console.log(`[cfg] src=${path.resolve(SRC)}`);

  const full = walkLocal(SRC);
  const localTotal = full.length;
  const fullBytes = full.reduce((s, f) => s + f.size, 0);
  let local = full;
  if (LIMIT > 0) local = local.slice(0, LIMIT);
  if (SAMPLE > 0) local = seededSample(local, SAMPLE, SEED);
  if (local.length === 0) {
    console.error(`[FATAL] 本地目录没有文件：${SRC}`);
    process.exit(2);
  }

  // 远端清单（幂等真源）
  const remoteList = await app.storage.walkCloudDir(PREFIX, '');
  const remote = new Map();
  for (const item of remoteList) remote.set(String(item.Key), { size: Number(item.Size), etag: item.ETag });

  const plan = [];
  let skip = 0;
  let skipBytes = 0;
  for (const f of local) {
    const key = `${PREFIX}${f.rel}`;
    const hit = remote.get(key);
    if (hit && hit.size === f.size) {
      skip += 1;
      skipBytes += f.size;
      continue;
    }
    plan.push({ ...f, key, reason: hit ? `size ${hit.size}→${f.size}` : 'missing' });
  }
  const uploadBytes = plan.reduce((s, f) => s + f.size, 0);

  const reqSeconds = (plan.length / CONCURRENCY) * 0.2;
  const netSeconds = uploadBytes / (MBPS * 1024 * 1024);
  const estLow = Math.round(Math.max(reqSeconds, netSeconds) + Math.min(reqSeconds, netSeconds));
  const estHigh = Math.round(Math.max(reqSeconds, netSeconds) * 1.5 + Math.min(reqSeconds, netSeconds));

  const localBytes = local.reduce((s, f) => s + f.size, 0);
  const isFull = local.length === localTotal;
  const sampledNote = isFull ? `全量 ${group(localTotal)} 件 / ${human(fullBytes)}` : `自全量 ${group(localTotal)} 件 / ${human(fullBytes)} 中抽样或截断`;
  console.log(`[plan] 本次候选 ${group(local.length)} 件 / ${human(localBytes)}（${sampledNote}）`);
  console.log(`[plan] 远端已有 ${group(remote.size)} 件（前缀 ${PREFIX}）`);
  console.log(`[plan] 将上传 ${group(plan.length)} 件 / ${human(uploadBytes)}；跳过 ${group(skip)} 件（同 size）；失败 0`);
  if (plan.length) {
    console.log(
      `[plan] 预估耗时 ≈ ${estLow}s ~ ${estHigh}s` +
        `（按 ${MBPS} MB/s 上行 ＋ 每件 ~0.2s 接口开销 / 并发 ${CONCURRENCY}；实际以带宽为准）`,
    );
  }

  if (DRY) {
    saveState({ phase: 'dry-run', planned: plan.length, skipped: skip, uploadedBytes: uploadBytes });
    console.log('[dry-run] 未写云（加 --yes 才真正上传）。');
    return 0;
  }

  // ── 真上传（并发 ≤8；失败入清单，不中断整批）────────────────────────────
  const failures = [];
  let uploaded = 0;
  let uploadedBytes = 0;
  const t0 = Date.now();
  await pool(plan, CONCURRENCY, async (f) => {
    try {
      await withRetry(() => app.storage.uploadFile({ localPath: f.abs, cloudPath: f.key }), f.key);
      uploaded += 1;
      uploadedBytes += f.size;
      if (uploaded % 25 === 0) saveState({ phase: 'uploading', uploaded, planned: plan.length, uploadedBytes });
      if (uploaded % 200 === 0 || uploaded === plan.length) {
        const el = (Date.now() - t0) / 1000;
        const rate = uploaded / (el || 1);
        const eta = (plan.length - uploaded) / (rate || 1);
        console.log(
          `[progress] ${uploaded}/${plan.length} (${Math.floor((uploaded * 100) / plan.length)}%) ` +
            `失败=${failures.length} 已传=${human(uploadedBytes)} 耗时=${el.toFixed(0)}s ETA=${eta.toFixed(0)}s`,
        );
      }
    } catch (err) {
      failures.push({ key: f.key, rel: f.rel, size: f.size, error: String(err && err.message ? err.message : err) });
    }
  });

  // ── 对账（再列一次远端：件数 + size 逐件比对）────────────────────────────
  console.log('[verify] 重新列远端清单对账 …');
  const afterList = await app.storage.walkCloudDir(PREFIX, '');
  const after = new Map();
  for (const item of afterList) after.set(String(item.Key), Number(item.Size));
  const mismatch = [];
  for (const f of plan) {
    const size = after.get(f.key);
    if (size !== f.size) mismatch.push({ key: f.key, expect: f.size, actual: size ?? null });
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  saveState({ phase: 'done', uploaded, skipped: skip, failed: failures.length, uploadedBytes, mismatch: mismatch.length });

  console.log('='.repeat(72));
  console.log(
    `[done] 上传 ${group(uploaded)} / 跳过 ${group(skip)} / 失败 ${group(failures.length)}` +
      `｜总字节 ${group(uploadedBytes)}（${human(uploadedBytes)}）｜耗时 ${elapsed}s`,
  );
  console.log(`[done] 对账：计划 ${group(plan.length)} 件，远端不符 ${group(mismatch.length)} 件；前缀合计 ${group(after.size)} 件`);
  if (failures.length) {
    console.log(`[done] 失败清单（${failures.length}）：`);
    for (const f of failures.slice(0, 50)) console.log(`    - ${f.key}: ${f.error}`);
    if (failures.length > 50) console.log(`    … 另有 ${failures.length - 50} 件`);
  }
  if (mismatch.length) {
    console.log(`[done] 对账不符清单（${mismatch.length}）：`);
    for (const m of mismatch.slice(0, 20)) console.log(`    - ${m.key}: expect=${m.expect} actual=${m.actual}`);
  }
  return failures.length || mismatch.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[FATAL] ${String(err && err.stack ? err.stack : err).slice(0, 1200)}`);
    process.exit(1);
  });
