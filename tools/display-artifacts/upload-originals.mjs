#!/usr/bin/env node
/**
 * tools/display-artifacts/upload-originals.mjs
 *
 * 把内容寻址 TIFF 原图（data/originals/<sha 前两位>/<sha>.tiff，6,357 张 / 约 1.2 GB）
 * **原样字节**上传到 COS 内容寻址键：
 *
 *     xiai/images/<sha 前两位>/<sha>.tiff
 *
 * 与规范 §3.61.6 的 `image_storage_key`（`<sha256[:2]>/<sha256>.tiff`）及
 * src/services/imageAuthority.js#artifactObjectKeyOf（`ARTIFACT_OBJECT_KEY_PREFIX` =
 * `xiai/images`、`ARTIFACT_OBJECT_KEY_EXT` = `tiff`）**逐字一致** ——
 * 影像入册 op 会回读该对象字节、现算 sha256 与声明值逐字比对，键不对/字节不在桶里 ⇒ 入册必失败。
 *
 * 与同目录 transcode.mjs 的分工：transcode 只产展示件（xiai/display）与缩略图（xiai/thumb）；
 * 本脚本只搬原图 TIFF 本身（xiai/images），不转码、不改字节、不动展示件。
 *
 * 上传前本地自证：文件名 sha 与文件**实际内容 sha256** 逐字相等 ⇒ 才允许上传；
 *   不等 ⇒ 记 `badfile`（不上传、报告里逐条列出）。
 * 幂等：先探同键对象（getFileInfo → size）；已存在且字节数一致 ⇒ `skipped`；
 *   已存在但字节数不同 ⇒ `conflict`（**不覆盖**，退出码 2）。
 * 续跑：进度 JSONL（progress-originals.jsonl）逐行追加（sha / status / bytes / ms / 错误摘要），
 *   启动时读回，status ∈ {ok, skipped} 的 sha 直接跳过；failed / conflict / badfile 会被重新检查。
 * 对账三读数（跑完必打）：磁盘 TIFF 总数 / 成功处理唯一 sha 数 / 对象存在数；
 *   再抽 12 张回读：断言对象字节数 == 本地字节数，且回读字节现算 sha256 == 键里的 sha。
 *
 * 凭据：~/.config/.cloudbase/auth.json 的 credential.tmpSecretId/tmpSecretKey/**tmpToken**
 *   （必须作 sessionToken 注入，缺它一律 SIGN_PARAM_INVALID）；过期跑一次 `tcb env list` 刷新重读（60s 内只刷一次）。
 *
 * 用法见同目录 README.md。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const pExecFile = promisify(execFile);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const require = createRequire(path.join(REPO_ROOT, 'package.json'));

const DEFAULT_ORIGINALS = path.join(REPO_ROOT, 'data', 'originals');
const DEFAULT_PROGRESS = path.join(SCRIPT_DIR, 'progress-originals.jsonl');
const DEFAULT_ENV = 'liwu-d8gek6jjdab1d087c';
const KEY_PREFIX = 'xiai/images';   // 与 imageAuthority.js ARTIFACT_OBJECT_KEY_PREFIX 逐字一致
const KEY_EXT = 'tiff';             // 与 ARTIFACT_OBJECT_KEY_EXT 逐字一致
const DEFAULT_BATCH = 500;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PROBE_CHUNK = 50;    // ★ getFileInfo/getTempFileURL 单次上限恰 50（超过报 INVALID_PARAM
                                   //   "Cannot operate more than 50 files one time"，实测）
const PROBE_CHUNK_MAX = 50;
const RETRIES = 2;                  // 每个动作失败重试 2 次（共 3 次尝试）
const CRED_MARGIN_MS = 10 * 60 * 1000;   // 临时密钥剩余不足 10 分钟就先刷新
const READBACK_N = 12;              // 回读抽样张数
const SHA_RE = /^[0-9a-f]{64}$/;

const HELP = `用法: node tools/display-artifacts/upload-originals.mjs [选项]

  --originals <dir>     内容寻址 TIFF 根目录（默认 data/originals）
  --progress <path>     进度 JSONL（默认 tools/display-artifacts/progress-originals.jsonl）
  --env <envId>         目标 CloudBase 环境（默认 ${DEFAULT_ENV}）
  --limit <n>           只处理前 n 张（按 sha 升序；小量试跑用）
  --batch <n>           单批张数（默认 ${DEFAULT_BATCH}：自证哈希 → 探测 → 上传 → 落进度）
  --concurrency <n>     并发（默认 ${DEFAULT_CONCURRENCY}）
  --probe-chunk <n>     探测/取临时 URL 的单次条目数（默认 ${DEFAULT_PROBE_CHUNK}）
  --dry-run             只算 sha 与字节：不探测、不上传、不写进度
  -h, --help            本帮助

退出码：0 全部成功；1 有 failed / badfile 或回读断言失败；2 有 conflict（同键不同字节，未覆盖）。`;

function die(msg) {
  console.error(`[error] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const o = {
    originals: DEFAULT_ORIGINALS,
    progress: DEFAULT_PROGRESS,
    env: DEFAULT_ENV,
    limit: 0,
    batch: DEFAULT_BATCH,
    concurrency: DEFAULT_CONCURRENCY,
    probeChunk: DEFAULT_PROBE_CHUNK,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) die(`选项 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--originals': o.originals = take(); break;
      case '--progress': o.progress = take(); break;
      case '--env': o.env = take(); break;
      case '--limit': o.limit = Number(take()); break;
      case '--batch': o.batch = Number(take()); break;
      case '--concurrency': o.concurrency = Number(take()); break;
      case '--probe-chunk': o.probeChunk = Number(take()); break;
      case '--dry-run': o.dryRun = true; break;
      case '--help': case '-h': o.help = true; break;
      default: die(`未知参数: ${a}（用 --help 看用法）`);
    }
  }
  for (const [k, v] of [['limit', o.limit], ['batch', o.batch], ['concurrency', o.concurrency], ['probeChunk', o.probeChunk]]) {
    if (!Number.isFinite(v) || v < 0 || (k !== 'limit' && v < 1)) die(`--${k} 取值非法: ${v}`);
  }
  if (o.probeChunk > PROBE_CHUNK_MAX) {
    console.warn(`[warn] --probe-chunk ${o.probeChunk} 超过平台上限 ${PROBE_CHUNK_MAX}，已按 ${PROBE_CHUNK_MAX} 执行（超过报 INVALID_PARAM: Cannot operate more than 50 files one time）`);
    o.probeChunk = PROBE_CHUNK_MAX;
  }
  return o;
}

/* ------------------------------------------------------------------ 工具函数 */

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function withRetry(fn, times = RETRIES, label = 'op') {
  let lastErr;
  for (let attempt = 0; attempt <= times; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt < times) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  const msg = lastErr && lastErr.message ? lastErr.message : String(lastErr);
  const err = new Error(`${label} 失败（重试 ${times} 次）: ${msg}`);
  err.cause = lastErr;
  throw err;
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function short(sha) { return `${sha.slice(0, 12)}…`; }

/** 内容寻址对象键：`xiai/images/<sha 前两位>/<sha>.tiff`（唯一构造点） */
function keyOf(sha) { return `${KEY_PREFIX}/${sha.slice(0, 2)}/${sha}.${KEY_EXT}`; }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function fmtMs(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`; }

/* ------------------------------------------------------------ 凭据 / SDK */

const AUTH_PATH = path.join(os.homedir(), '.config', '.cloudbase', 'auth.json');
const TCB_BIN = fs.existsSync('/usr/local/bin/tcb') ? '/usr/local/bin/tcb' : 'tcb';

function readCredential() {
  if (!fs.existsSync(AUTH_PATH)) die(`找不到凭据文件 ${AUTH_PATH}`);
  const raw = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
  const c = raw.credential || raw;
  if (!c.tmpSecretId || !c.tmpSecretKey || !c.tmpToken) die(`${AUTH_PATH} 缺少 tmpSecretId/tmpSecretKey/tmpToken`);
  return c;
}

function credFresh(c) {
  return Number(c.tmpExpired || 0) - Date.now() > CRED_MARGIN_MS;
}

async function refreshCredential(reason) {
  console.log(`[auth] 刷新临时凭据（${reason}）：跑一次 tcb env list 后重读 ${AUTH_PATH}`);
  try {
    await pExecFile(TCB_BIN, ['env', 'list'], { timeout: 120_000, maxBuffer: 8 << 20 });
  } catch (e) {
    console.warn(`[auth] tcb env list 失败: ${e.message}`);
  }
  return readCredential();
}

function isAuthError(e) {
  const s = `${(e && e.message) || ''} ${(e && e.code) || ''}`;
  return /secret id|SIGN_PARAM|SignatureDoesNotMatch|expired|401|AccessDenied/i.test(s);
}

class Cloud {
  constructor(env) {
    this.env = env;
    this.sdk = require('@cloudbase/node-sdk');
    this.credential = readCredential();
    this.lastRefresh = 0;
    this.app = null;
    this.prefix = null; // cloud://<env>.<bucket>/
    this.probeChunk = DEFAULT_PROBE_CHUNK;
  }

  async init(reason = '启动') {
    if (!credFresh(this.credential)) this.credential = await refreshCredential(`${reason}：临时密钥已过期/临期`);
    this.app = this.sdk.init({
      secretId: this.credential.tmpSecretId,
      secretKey: this.credential.tmpSecretKey,
      sessionToken: this.credential.tmpToken, // 临时密钥必须带 sessionToken，否则 SIGN_PARAM_INVALID
      env: this.env,
    });
    // 用一次 getUploadMetadata 拿到该环境的 fileID 前缀（cloud://env.bucket/），探测要靠它
    const probePath = `${KEY_PREFIX}/.prefix-probe`;
    const meta = await this.app.getUploadMetadata({ cloudPath: probePath });
    const fileId = meta && meta.data && meta.data.fileId;
    if (!fileId || !fileId.endsWith(probePath)) throw new Error(`getUploadMetadata 未返回合法 fileId: ${JSON.stringify(fileId)}`);
    this.prefix = fileId.slice(0, fileId.length - probePath.length);
    console.log(`[auth] env=${this.env} fileID 前缀=${this.prefix}`);
  }

  /** 出错时若像凭据问题就刷新一次（60s 内只刷一次），返回 true 表示已可重试 */
  async maybeRefresh(e) {
    if (!isAuthError(e)) return false;
    const now = Date.now();
    if (now - this.lastRefresh < 60_000) return false;
    this.lastRefresh = now;
    this.credential = await refreshCredential(`请求报错: ${(e && e.message) || e}`);
    await this.init('凭据刷新后');
    return true;
  }

  fileID(key) { return this.prefix + key; }

  /** 批量探测：返回 Map(key -> {code, size})，key 为对象键 */
  async probe(keys) {
    const out = new Map();
    const items = keys.map(key => ({ key, id: this.fileID(key) }));
    for (const part of chunk(items, this.probeChunk)) {
      let res;
      try {
        res = await withRetry(() => this.app.getFileInfo({ fileList: part.map(p => p.id) }), RETRIES, 'getFileInfo');
      } catch (e) {
        if (await this.maybeRefresh(e)) {
          res = await withRetry(() => this.app.getFileInfo({ fileList: part.map(p => p.id) }), RETRIES, 'getFileInfo(刷新后)');
        } else {
          throw e;
        }
      }
      const list = (res && res.fileList) || [];
      const byId = new Map();
      for (const it of list) if (it && it.fileID) byId.set(it.fileID, it);
      part.forEach((p, i) => {
        const it = byId.get(p.id) || list[i];
        out.set(p.key, it ? { code: it.code, size: it.size } : { code: 'NO_ITEM' });
      });
    }
    return out;
  }

  async upload(key, buf) {
    const doIt = () => this.app.uploadFile({ cloudPath: key, fileContent: buf });
    try {
      return await withRetry(doIt, RETRIES, `upload ${key}`);
    } catch (e) {
      if (await this.maybeRefresh(e)) return await withRetry(doIt, RETRIES, `upload ${key}(刷新后)`);
      throw e;
    }
  }

  /** 取临时下载 URL（回读抽样用），返回 Map(key -> {code, url}) */
  async tempUrls(keys) {
    const out = new Map();
    const items = keys.map(key => ({ key, id: this.fileID(key) }));
    for (const part of chunk(items, this.probeChunk)) {
      let res;
      try {
        res = await withRetry(() => this.app.getTempFileURL({ fileList: part.map(p => p.id) }), RETRIES, 'getTempFileURL');
      } catch (e) {
        if (await this.maybeRefresh(e)) {
          res = await withRetry(() => this.app.getTempFileURL({ fileList: part.map(p => p.id) }), RETRIES, 'getTempFileURL(刷新后)');
        } else {
          throw e;
        }
      }
      const list = (res && res.fileList) || [];
      const byId = new Map();
      for (const it of list) if (it && it.fileID) byId.set(it.fileID, it);
      part.forEach((p, i) => {
        const it = byId.get(p.id) || list[i];
        out.set(p.key, it ? { code: it.code, url: it.download_url } : { code: 'NO_ITEM' });
      });
    }
    return out;
  }
}

/* ------------------------------------------------------------ 磁盘 / 进度 */

function scanOriginals(dir) {
  if (!fs.existsSync(dir)) die(`originals 目录不存在: ${dir}`);
  const map = new Map();          // sha -> 绝对路径
  const invalid = [];             // 文件名不是 64 位小写 hex 的 .tiff
  const dirMismatch = [];         // 子目录名 != sha 前两位（键仍按 sha 前两位构造）
  let tiffFiles = 0;
  let otherFiles = 0;
  let dup = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) {
      if (ent.name.endsWith('.tiff')) invalid.push(`(根)/${ent.name}`);
      else otherFiles++;
      continue;
    }
    for (const f of fs.readdirSync(path.join(dir, ent.name))) {
      const full = path.join(dir, ent.name, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      if (!f.endsWith('.' + KEY_EXT)) { otherFiles++; continue; }
      tiffFiles++;
      const sha = f.slice(0, -('.' + KEY_EXT).length);
      if (!SHA_RE.test(sha)) { invalid.push(`${ent.name}/${f}`); continue; }
      if (ent.name !== sha.slice(0, 2)) dirMismatch.push(`${ent.name}/${f}`);
      if (map.has(sha)) { dup++; continue; }
      map.set(sha, full);
    }
  }
  return { map, tiffFiles, invalid, dirMismatch, otherFiles, dup };
}

function loadProgress(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return { map, lines: 0, broken: 0 };
  let broken = 0;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      if (j && j.sha) map.set(j.sha, j);
    } catch { broken++; }
  }
  return { map, lines: lines.length, broken };
}

function appendProgress(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}

/* ------------------------------------------------------------ 自证哈希 */

/**
 * 读文件 → 现算 sha256（不保留 buffer：批次内只留 4 路并发的瞬时内存）。
 * 返回 { bytes, actual }；读失败抛错（调用方按 failed 记）。
 */
async function hashFile(file) {
  return await withRetry(async () => {
    const buf = fs.readFileSync(file);
    return { bytes: buf.length, actual: sha256(buf) };
  }, RETRIES, `hash ${path.basename(file)}`);
}

/* ------------------------------------------------------------ 回读抽样 */

/**
 * 抽样回读：下载对象字节到 $TMPDIR，断言
 *   ① 对象字节数 == 本地字节数；
 *   ② 回读字节现算 sha256 == 键里的 sha（内容寻址逐字命中）。
 */
async function readbackSample(cloud, shas, disk, tmpRoot, progressMap) {
  const results = [];
  for (const sha of shas) {
    const key = keyOf(sha);
    const file = disk.get(sha);
    const item = { sha, key, pass: true, notes: [] };
    try {
      const localBytes = fs.statSync(file).size;
      const urls = await cloud.tempUrls([key]);
      const info = urls.get(key);
      if (!info || info.code !== 'SUCCESS' || !info.url) {
        item.pass = false;
        item.notes.push(`回读失败 code=${info ? info.code : 'NO_ITEM'}`);
      } else {
        const resp = await fetch(info.url);
        if (!resp.ok) {
          item.pass = false;
          item.notes.push(`HTTP ${resp.status}`);
        } else {
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length !== localBytes) {
            item.pass = false;
            item.notes.push(`字节数不符 remote=${buf.length} local=${localBytes}`);
          } else {
            const actual = sha256(buf);
            if (actual !== sha) {
              item.pass = false;
              item.notes.push(`sha256 不符 actual=${actual} != 键内 sha`);
            } else {
              item.notes.push(`bytes=${buf.length}==本地；sha256==键内 sha`);
            }
          }
          const rec = progressMap.get(sha);
          if (rec && typeof rec.bytes === 'number' && rec.bytes !== buf.length) {
            item.pass = false;
            item.notes.push(`与进度记录字节不符 remote=${buf.length} progress=${rec.bytes}`);
          }
        }
      }
      void tmpRoot; // 字节直接在内存校验，不落盘（$TMPDIR 目录仅作占位清理）
    } catch (e) {
      item.pass = false;
      item.notes.push(`异常: ${e.message}`);
    }
    results.push(item);
  }
  return results;
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }

  const scan = scanOriginals(path.resolve(opts.originals));
  const disk = scan.map;
  const progressFile = path.resolve(opts.progress);
  const progressState = loadProgress(progressFile);
  const progressMap = progressState.map;

  // 按 sha 升序 ⇒ 同一 --limit 每次取到同一批文件（复跑可比）
  const all = [...disk.keys()].sort();
  let list = all;
  if (opts.limit > 0) list = list.slice(0, opts.limit);

  const TERMINAL = new Set(['ok', 'skipped']); // 续跑只跳过成功态；failed/conflict/badfile 重新检查
  const resumeSkip = list.filter(sha => TERMINAL.has((progressMap.get(sha) || {}).status));
  const work = list.filter(sha => !TERMINAL.has((progressMap.get(sha) || {}).status));

  console.log(`[config] env=${opts.env} dryRun=${opts.dryRun} limit=${opts.limit || 'ALL'} batch=${opts.batch} concurrency=${opts.concurrency} probeChunk=${opts.probeChunk}`);
  console.log(`[config] originals=${path.resolve(opts.originals)} progress=${progressFile}`);
  console.log(`[scan] 磁盘 .tiff 文件=${scan.tiffFiles} 内容寻址可用 sha=${disk.size} 重复 sha=${scan.dup} 非法文件名=${scan.invalid.length} 子目录与 sha 前两位不符=${scan.dirMismatch.length} 非 .tiff 文件=${scan.otherFiles}`);
  for (const x of scan.invalid.slice(0, 20)) console.log(`  [scan] 非法文件名: ${x}`);
  if (scan.invalid.length > 20) console.log(`  [scan] … 另 ${scan.invalid.length - 20} 个非法文件名`);
  for (const x of scan.dirMismatch.slice(0, 10)) console.log(`  [scan] 子目录与 sha 前两位不符（键仍按 sha 前两位构造）: ${x}`);
  if (progressState.broken > 0) console.log(`[warn] 进度文件有 ${progressState.broken} 行解析失败`);
  console.log(`[plan] 本批候选=${list.length}（磁盘 ${all.length}） 续跑跳过=${resumeSkip.length} 待处理=${work.length}`);
  if (opts.dryRun) console.log('[plan] DRY-RUN：只算 sha 与字节，不探测、不上传、不写进度文件');

  const keyOfSha = keyOf;
  const stats = { hashed: 0, uploaded: 0, exists: 0, conflict: 0, failed: 0, badfile: 0, hashFail: 0 };
  const failureNotes = [];
  const badfileNotes = [];
  const conflictShas = [];
  const doneThisRun = new Set();
  const verbose = work.length <= 100;
  let printed = 0;

  /* =================== DRY-RUN：只算 sha 与字节 =================== */
  if (opts.dryRun) {
    const results = await pool(work, opts.concurrency, async (sha) => {
      const t0 = Date.now();
      try {
        const { bytes, actual } = await hashFile(disk.get(sha));
        return { sha, bytes, actual, match: actual === sha, ms: Date.now() - t0 };
      } catch (e) {
        return { sha, error: e.message, ms: Date.now() - t0 };
      }
    });
    let computed = 0, bad = 0, hashFail = 0;
    for (const r of results) {
      if (r.error) {
        hashFail++;
        failureNotes.push(`${short(r.sha)} 读文件失败: ${r.error}`);
        if (verbose) console.log(`  [${++printed}/${work.length}] ${short(r.sha)} hash_fail err=${r.error}`);
        continue;
      }
      if (!r.match) {
        bad++;
        badfileNotes.push(`${keyOfSha(r.sha)} 文件名 sha != 内容 sha256（actual=${r.actual} bytes=${r.bytes}）`);
        if (verbose) console.log(`  [${++printed}/${work.length}] ${short(r.sha)} badfile bytes=${r.bytes} actual=${r.actual}`);
        continue;
      }
      computed++;
      if (verbose) console.log(`  [${++printed}/${work.length}] ${short(r.sha)} computed bytes=${r.bytes} sha_ok=true ${fmtMs(r.ms)}`);
    }
    console.log('');
    console.log('================ 对账三读数 ================');
    console.log(`[读数1] 磁盘 TIFF 总数 = ${scan.tiffFiles}（内容寻址可用 sha = ${disk.size}，非法文件名 = ${scan.invalid.length}）`);
    console.log(`[读数2] 成功处理唯一 sha 数 = ${computed}（dry-run：仅自证哈希成功；badfile=${bad} hash_fail=${hashFail}；未上传、未落进度文件）`);
    console.log(`[读数3] 对象存在数 = 未探测（dry-run 不探测不上传；真跑时按磁盘 ${disk.size} 个键全量 getFileInfo 给出）`);
    console.log('-------------------------------------------');
    console.log(`[统计] dry-run 自证哈希=${computed} 张；badfile=${bad}；读文件失败=${hashFail}；进度文件未写（${progressFile}）`);
    if (badfileNotes.length > 0) {
      console.log(`[badfile] ${badfileNotes.length} 张文件名 sha 与内容 sha256 不等，不上传：`);
      for (const n of badfileNotes) console.log(`  - ${n}`);
    }
    if (failureNotes.length > 0) {
      console.log(`[failed] ${failureNotes.length} 条：`);
      for (const n of failureNotes) console.log(`  - ${n}`);
    }
    console.log('[回读] dry-run 未上传，跳过回读抽样');
    return bad > 0 || hashFail > 0 ? 1 : 0;
  }

  /* =================== 真跑：自证 → 探测 → 上传 =================== */
  const cloud = new Cloud(opts.env);
  try {
    await cloud.init('启动');
  } catch (e) {
    if (await cloud.maybeRefresh(e)) await cloud.init('凭据刷新后');
    else throw e;
  }
  cloud.probeChunk = opts.probeChunk;

  const chunks = chunk(work, opts.batch);
  let processed = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const batch = chunks[ci];
    const tBatch = Date.now();

    // ① 本地自证：读文件 + 现算 sha256，与文件名 sha 逐字比对（不保留 buffer）
    const hashed = await pool(batch, opts.concurrency, async (sha) => {
      const t0 = Date.now();
      try {
        const { bytes, actual } = await hashFile(disk.get(sha));
        return { sha, bytes, actual, match: actual === sha, ms: Date.now() - t0 };
      } catch (e) {
        return { sha, error: e.message, ms: Date.now() - t0 };
      }
    });

    const good = [];
    for (const h of hashed) {
      if (h.error) {
        stats.failed++; stats.hashFail++;
        failureNotes.push(`${short(h.sha)} 读文件失败: ${h.error}`);
        const rec = {
          sha: h.sha, at: new Date().toISOString(), status: 'failed', bytes: null,
          key: keyOfSha(h.sha), ms: h.ms, error: `read: ${h.error}`,
        };
        appendProgress(progressFile, rec); progressMap.set(h.sha, rec); doneThisRun.add(h.sha);
        continue;
      }
      if (!h.match) {
        stats.badfile++;
        badfileNotes.push(`${keyOfSha(h.sha)} 文件名 sha != 内容 sha256（actual=${h.actual} bytes=${h.bytes}）`);
        const rec = {
          sha: h.sha, at: new Date().toISOString(), status: 'badfile', bytes: h.bytes,
          key: keyOfSha(h.sha), ms: h.ms, actual: h.actual,
          error: `filename sha != content sha256 (actual=${h.actual})`,
        };
        appendProgress(progressFile, rec); progressMap.set(h.sha, rec); doneThisRun.add(h.sha);
        if (verbose) console.log(`  [${++printed}/${work.length}] ${short(h.sha)} badfile bytes=${h.bytes} actual=${h.actual}`);
        continue;
      }
      stats.hashed++;
      good.push(h);
    }

    // ② 一趟探测拿本批键的存在性与字节数
    let probeMap = null;
    if (good.length > 0) {
      try {
        probeMap = await cloud.probe(good.map(g => keyOfSha(g.sha)));
      } catch (e) {
        for (const g of good) {
          stats.failed++;
          failureNotes.push(`${short(g.sha)} 探测失败: ${e.message}`);
          const rec = {
            sha: g.sha, at: new Date().toISOString(), status: 'failed', bytes: g.bytes,
            key: keyOfSha(g.sha), ms: g.ms, error: `probe: ${e.message}`,
          };
          appendProgress(progressFile, rec); progressMap.set(g.sha, rec); doneThisRun.add(g.sha);
        }
        console.log(`[batch ${ci + 1}/${chunks.length}] 探测失败，本批 ${batch.length} 张记 failed: ${e.message}`);
        continue;
      }
    }

    // ③ 逐张裁决 + 上传（并发 opts.concurrency）
    if (good.length > 0) {
      await pool(good, opts.concurrency, async (g) => {
        const sha = g.sha;
        const key = keyOfSha(sha);
        const t0 = Date.now();
        let status = null;
        let err = null;
        const info = probeMap.get(key);

        if (!info) {
          status = 'failed'; err = '探测无返回';
        } else if (info.code === 'SUCCESS') {
          if (typeof info.size !== 'number') {
            status = 'failed'; err = '探测返回 SUCCESS 但无字节数';
          } else if (info.size === g.bytes) {
            status = 'skipped';          // 已存在且字节数一致 ⇒ 不动
            stats.exists++;
          } else {
            status = 'conflict';         // 同键不同字节 ⇒ 不覆盖
            stats.conflict++;
            err = `对象已存在但字节数不同 remote=${info.size} local=${g.bytes}`;
          }
        } else if (info.code === 'STORAGE_FILE_NONEXIST') {
          try {
            // 上传前二次自证：重读文件、现算 sha256，与键内 sha 逐字比对后才上传
            const buf = fs.readFileSync(disk.get(sha));
            if (buf.length !== g.bytes) throw new Error(`文件字节数在自证后变化 ${g.bytes} -> ${buf.length}`);
            const actual2 = sha256(buf);
            if (actual2 !== sha) throw new Error(`上传前自证失败 actual=${actual2}`);
            await cloud.upload(key, buf);
            status = 'ok';
            stats.uploaded++;
          } catch (e) {
            status = 'failed'; err = `上传失败: ${e.message}`;
          }
        } else {
          status = 'failed'; err = `探测异常 code=${info.code}`;
        }

        if (status === 'failed') { stats.failed++; failureNotes.push(`${short(sha)} ${err}`); }
        if (status === 'conflict') conflictShas.push(sha);

        const rec = {
          sha, at: new Date().toISOString(), status, bytes: g.bytes,
          key, ms: Date.now() - t0,
        };
        if (err) rec.error = err;
        appendProgress(progressFile, rec);
        progressMap.set(sha, rec);
        doneThisRun.add(sha);

        if (verbose) {
          console.log(`  [${++printed}/${work.length}] ${short(sha)} ${status} bytes=${g.bytes} key=${key} ${fmtMs(rec.ms)}${err ? ' err=' + err : ''}`);
        }
        return rec;
      });
    }

    processed += batch.length;
    console.log(`[batch ${ci + 1}/${chunks.length}] 本批 ${batch.length} 张（自证哈希 ${hashed.length}、可上传候选 ${good.length}），用时 ${fmtMs(Date.now() - tBatch)}，累计处理 ${processed}/${work.length}`);
  }

  /* =================== 对账读数 3 的底座：全量探测磁盘所有键 =================== */
  const allShas = [...disk.keys()].sort();
  const codeDist = {};
  const existsMap = new Map();   // sha -> 远端字节数
  let probeAllOk = true;
  const tProbe = Date.now();
  try {
    const probeAll = await cloud.probe(allShas.map(keyOfSha));
    for (const sha of allShas) {
      const info = probeAll.get(keyOfSha(sha));
      const code = info ? info.code : 'NO_ITEM';
      codeDist[code] = (codeDist[code] || 0) + 1;
      if (code === 'SUCCESS') existsMap.set(sha, info.size);
    }
    console.log(`[probe] 全量探测 ${allShas.length} 个对象键（${KEY_PREFIX}/…），用时 ${fmtMs(Date.now() - tProbe)}，code 分布=${JSON.stringify(codeDist)}`);
  } catch (e) {
    probeAllOk = false;
    console.log(`[probe] 全量探测失败 ⇒ 读数3 / 对象核对 / 回读抽样全部不可用（本 run 判失败，退出码 1）: ${e.message}`);
  }

  /* =================== 对账三读数 =================== */
  // 重新读回进度，保证统计口径来自磁盘
  const finalProgress = loadProgress(progressFile).map;
  const counts = { ok: 0, skipped: 0, conflict: 0, failed: 0, badfile: 0, none: 0 };
  const successShas = [];
  for (const sha of list) {
    const rec = finalProgress.get(sha);
    const st = rec ? rec.status : 'none';
    counts[st] = (counts[st] || 0) + 1;
    if (st === 'ok' || st === 'skipped') successShas.push(sha);
  }
  const uniqueSuccess = new Set(successShas);
  const s = uniqueSuccess.size;

  // 本 run 处理明细（幂等复跑的证据：全部命中进度、0 哈希 0 探测 0 上传）
  const resumeSkipSet = new Set(resumeSkip);
  const disp = { resumeSkip: 0, ok: 0, skipped: 0, conflict: 0, failed: 0, badfile: 0, none: 0 };
  for (const sha of list) {
    if (resumeSkipSet.has(sha)) { disp.resumeSkip++; continue; }
    if (doneThisRun.has(sha)) {
      const st = (finalProgress.get(sha) || {}).status || 'failed';
      disp[st] = (disp[st] || 0) + 1;
    } else {
      disp.none++;
    }
  }

  console.log('');
  console.log('================ 对账三读数 ================');
  console.log(`[读数1] 磁盘 TIFF 总数 = ${scan.tiffFiles}（内容寻址可用 sha = ${disk.size}，非法文件名 = ${scan.invalid.length}，重复 sha = ${scan.dup}）`);
  console.log(`[读数2] 成功处理唯一 sha 数 = ${s}（ok=${counts.ok || 0} skipped=${counts.skipped || 0}；conflict=${counts.conflict || 0} failed=${counts.failed || 0} badfile=${counts.badfile || 0} none=${counts.none || 0}，本批候选 ${list.length}）`);
  if (probeAllOk) {
    console.log(`[读数3] 对象存在数 = ${existsMap.size} / 磁盘 ${disk.size} 键（全量探测 code 分布=${JSON.stringify(codeDist)}）`);
  } else {
    console.log(`[读数3] 对象存在数 = 未知（全量探测失败；期望 ≤ 磁盘 ${disk.size} 键）`);
  }
  console.log('-------------------------------------------');
  console.log(`[本 run 处理明细] 幂等跳过=${disp.resumeSkip}（进度命中 status∈{ok,skipped}，未哈希/未探测/未上传） 新处理=${(disp.ok || 0) + (disp.skipped || 0) + (disp.conflict || 0) + (disp.failed || 0) + (disp.badfile || 0)}（ok=${disp.ok || 0} 已存在同字节=${disp.skipped || 0} conflict=${disp.conflict || 0} failed=${disp.failed || 0} badfile=${disp.badfile || 0}） 未处理=${disp.none || 0}`);
  console.log(`[统计] 自证哈希成功=${stats.hashed} 张；对象级：新上传=${stats.uploaded} 已存在同字节=${stats.exists} conflict=${stats.conflict}；图片级 failed=${stats.failed}（含读文件失败 ${stats.hashFail}） badfile=${stats.badfile}`);
  console.log(`[统计] 本 run 处理唯一 sha=${doneThisRun.size}；进度文件=${progressFile}（累计 ${loadProgress(progressFile).lines} 行）`);

  /* =================== 对象核对（候选键逐条：终读探测 + 本地 stat） =================== */
  {
    const rows = [];
    let existsSame = 0, missing = 0, sizeDiff = 0, noStat = 0;
    for (const sha of list) {
      const key = keyOfSha(sha);
      const remote = existsMap.get(sha);
      let localBytes = null;
      try { localBytes = fs.statSync(disk.get(sha)).size; } catch { noStat++; }
      if (remote === undefined) { missing++; rows.push({ key, note: `缺失（本地 ${localBytes}B）` }); }
      else if (localBytes === null) { rows.push({ key, note: `远端 ${remote}B（本地 stat 失败）` }); }
      else if (remote === localBytes) { existsSame++; rows.push({ key, note: `exists 同字节 ${remote}B ⇒ skipped` }); }
      else { sizeDiff++; rows.push({ key, note: `conflict 远端 ${remote}B != 本地 ${localBytes}B（未覆盖）` }); }
    }
    console.log(`[对象核对] 本批候选 ${list.length} 键（读数3 终读探测 + 本地 stat）：exists 同字节=${existsSame}（skipped） 新上传=${stats.uploaded} conflict=${sizeDiff} 缺失=${missing} stat失败=${noStat}`);
    if (!probeAllOk) console.log('  [对象核对] 注意：全量探测失败 ⇒ 上面的「缺失」不可信，本 run 已按失败判退出码 1');
    if (list.length <= 50 && probeAllOk) {
      for (const r of rows) console.log(`  - ${r.key} ${r.note}`);
    }
  }

  if (conflictShas.length > 0) {
    console.log(`[conflict] ${conflictShas.length} 个 sha 同键但字节数不同，未覆盖，需派单方裁定：`);
    for (const sha of conflictShas) console.log(`  - ${sha} key=${keyOfSha(sha)}`);
  }
  if (badfileNotes.length > 0) {
    console.log(`[badfile] ${badfileNotes.length} 张文件名 sha 与内容 sha256 不等，不上传：`);
    for (const n of badfileNotes) console.log(`  - ${n}`);
  }
  if (failureNotes.length > 0) {
    console.log(`[failed] ${failureNotes.length} 条：`);
    for (const n of failureNotes.slice(0, 50)) console.log(`  - ${n}`);
    if (failureNotes.length > 50) console.log(`  … 另 ${failureNotes.length - 50} 条见进度文件`);
  }

  /* =================== 抽 12 张回读 =================== */
  let readbackFail = 0;
  const candidates = allShas.filter(sha => existsMap.has(sha));
  if (!probeAllOk) {
    console.log('[回读] 全量探测失败，无法抽样回读（本 run 已判失败）');
  } else if (candidates.length === 0) {
    console.log('[回读] 桶内无已存在对象，跳过回读抽样');
  } else {
    const take = Math.min(READBACK_N, candidates.length);
    const samples = [];
    for (let i = 0; i < take; i++) samples.push(candidates[Math.floor((i * candidates.length) / take)]);
    console.log(`[回读] 桶内已存在 ${candidates.length} 个原图对象，抽 ${samples.length} 张回读（断言：对象字节数 == 本地字节数；回读字节现算 sha256 == 键里的 sha）`);
    const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'xiai-uo-'));
    try {
      const rb = await readbackSample(cloud, samples, disk, tmpRoot, finalProgress);
      rb.forEach((it, i) => {
        console.log(`  [回读 ${i + 1}/${rb.length}] ${it.key} ${it.pass ? 'PASS' : 'FAIL'}  ${it.notes.join('; ')}`);
        if (!it.pass) readbackFail++;
      });
      console.log(`[回读] ${rb.length - readbackFail}/${rb.length} PASS`);
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  if (!probeAllOk) return 1;
  if (readbackFail > 0) return 1;
  if ((counts.failed || 0) > 0 || (counts.badfile || 0) > 0 || (counts.none || 0) > 0) return 1;
  if ((counts.conflict || 0) > 0) return 2;
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error('[fatal]', e && e.stack ? e.stack : e);
    process.exit(1);
  });
