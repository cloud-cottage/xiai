#!/usr/bin/env node
/**
 * tools/display-artifacts/transcode.mjs
 *
 * 离线批处理：把内容寻址 TIFF（data/originals/<sha前两位>/<sha>.tiff）转成
 * 「展示件（WebP，零重采样）」与「缩略图（WebP，长边 ≤256，只缩不放）」，
 * 直传多云对象存储（CloudBase/COS），供前端直出，不经云函数。
 *
 * 口径（Kevin 裁定，硬口径）：
 *   - 展示件：既不放大也不缩小 —— 保留原图宽高、零重采样，只做 TIFF→WebP 容器/编码转换：
 *       magick '<src>[0]' -strip -quality 92 -define webp:method=6 <out>
 *     （无任何 -resize；若源是 16bit/多页，取第 1 页，尺寸不得因此改变）
 *   - 缩略图：缩小件，长边上限 256，只缩不放（原图长边 <256 保持原尺寸）：
 *       magick '<src>[0]' -resize 256x256> -strip -quality 82 <out>
 *     （`>` 后缀即「仅当大于时缩放」，不得改写）
 *
 * 产物键（内容寻址，与入库行 sha256 同键 ⇒ 采纳后自动接上）：
 *   展示件  <display-prefix><sha 前两位>/<sha>.<display-ext>   （默认 xiai/display/<sha2>/<sha>.webp）
 *   缩略图  <thumb-prefix><sha 前两位>/<sha>.webp              （默认 xiai/thumb/<sha2>/<sha>.webp；恒为 webp）
 *   新增可配：--display-prefix（默认 xiai/display/）、--display-ext（png|webp，默认 webp）、
 *   --thumb-prefix（默认 xiai/thumb/）。前端对 `.tiff` 源件行派生的展示键是
 *   `xiai/images/<sha 前两位>/<sha>.png`（src/data/cloudbase.js::cloudBaseObjectKeyOf），
 *   故前端要出图必须用 `--display-prefix xiai/images/ --display-ext png`。
 *   PNG 编码：`-define png:compression-level=9 -strip`，同样零重采样、保留原宽高（无 -resize）。
 *
 * 幂等：上传前先探同键对象（getFileInfo → HEAD 拿 content-length）；
 *   已存在且字节数一致 ⇒ skipped（不重复上传）；已存在但字节数不同 ⇒ 默认 conflict（不覆盖），
 *   加 --overwrite ⇒ 直接覆盖上传（status=ok，行上记 overwrote:true，覆盖后再重探字节复核）。
 * 续跑：进度 JSONL 逐行追加（envId / sha / status / native_w,h / thumb_w,h / 字节 / 耗时 / 错误摘要），
 *   默认文件按「环境 + 展示前缀 + 扩展名」隔离：
 *     默认形态（xiai/display/ + .webp）⇒ progress-<envId>.jsonl（沿用旧名，历史断点不丢）；
 *     其它形态 ⇒ progress-<envId>-<前缀 slug>-<扩展名>.jsonl。
 *   换环境 / 换展示键形态必须各自独立进度文件，否则已 ok 的行会把另一形态整批误跳过；
 *   行上另记 display_prefix / display_ext / thumb_prefix，读回时与本次形态不符的行一律不算进度。
 *   启动时读回，status ∈ {ok, skipped} 的 sha 直接跳过；failed / conflict 会被重新检查。
 *   旧单文件 progress.jsonl 只属于默认环境 + 默认键形态，仅作其基线只读合入；其它一律不读、本脚本永不写它。
 *
 * 用法见同目录 README.md。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const pExecFile = promisify(execFile);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const require = createRequire(path.join(REPO_ROOT, 'package.json'));

const DEFAULT_MANIFEST = '/Users/kevin/bistro/feicui/exports/seal_import_seal_20261010_01/images_manifest.jsonl';
const DEFAULT_ORIGINALS = path.join(REPO_ROOT, 'data', 'originals');
// 旧单文件进度（历史产物）：只属于默认环境 DEFAULT_ENV —— 只作基线读入，本脚本永不写它
const LEGACY_PROGRESS = path.join(SCRIPT_DIR, 'progress.jsonl');
const DEFAULT_ENV = 'liwu-d8gek6jjdab1d087c';
const DEFAULT_BATCH = 500;
// 产物键形态默认值（= 历史布局）。前端对 `.tiff` 源件行派生的展示键是
// xiai/images/<sha2>/<sha>.png ⇒ 出图给前端要用 --display-prefix xiai/images/ --display-ext png
const DEFAULT_DISPLAY_PREFIX = 'xiai/display/';
const DEFAULT_THUMB_PREFIX = 'xiai/thumb/';
const DEFAULT_DISPLAY_EXT = 'webp';   // webp（q92 零重采样）| png（png:compression-level=9 零重采样）
const DISPLAY_EXTS = ['webp', 'png'];
const DEFAULT_CONCURRENCY = 4;
// CloudBase 批量存储 API 硬限：单次最多 50 个 fileID，超限报 INVALID_PARAM——
//   "getFileInfo 失败（重试 2 次）: Cannot operate more than 50 files one time
//    更多错误信息请访问：https://docs.cloudbase.net/error-code/basic/INVALID_PARAM"
// （getTempFileURL 同源同限）。探测/取临时 URL 一律在 Cloud.probe / Cloud.tempUrls 内
// 自行按 ≤PROBE_CHUNK_MAX 分批；调用方 --probe-chunk 只能把批调小，传多大都压回 50。
const PROBE_CHUNK_MAX = 50;
const DEFAULT_PROBE_CHUNK = PROBE_CHUNK_MAX;
const RETRIES = 2;              // 每张失败重试 2 次
const MAGICK_TIMEOUT_MS = 180_000;
const CRED_MARGIN_MS = 10 * 60 * 1000;   // 临时密钥剩余不足 10 分钟就先刷新
const THUMB_MAX = 256;          // 缩略图长边上限（展示件无上限、零重采样）

/** 前缀 slug：`xiai/images/` → `xiai-images`（进进度文件名，保证不同形态不同文件） */
function prefixSlug(p) {
  return String(p).replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'prefix';
}

/**
 * 默认进度文件路径：按「环境 + 展示前缀 + 扩展名」隔离 ——
 *   默认键形态（xiai/display/ + .webp）⇒ progress-<envId>.jsonl（沿用旧名，历史断点不丢）；
 *   其它形态 ⇒ progress-<envId>-<前缀 slug>-<扩展名>.jsonl（不与已跑过的 webp/display 批互跳）。
 */
function progressFileFor(envId, displayPrefix = DEFAULT_DISPLAY_PREFIX, displayExt = DEFAULT_DISPLAY_EXT) {
  const safe = String(envId).replace(/[^A-Za-z0-9._-]+/g, '_');
  if (displayPrefix === DEFAULT_DISPLAY_PREFIX && displayExt === DEFAULT_DISPLAY_EXT) {
    return path.join(SCRIPT_DIR, `progress-${safe}.jsonl`);
  }
  return path.join(SCRIPT_DIR, `progress-${safe}-${prefixSlug(displayPrefix)}-${displayExt}.jsonl`);
}

const HELP = `用法: node tools/display-artifacts/transcode.mjs [选项]

  --manifest <path>     images_manifest.jsonl（默认 ${DEFAULT_MANIFEST}）
  --originals <dir>     内容寻址 TIFF 根目录（默认 data/originals）
  --progress <path>     进度 JSONL（默认按「环境 + 展示前缀 + 扩展名」隔离：
                        tools/display-artifacts/progress-<envId>[-<前缀 slug>-<ext>].jsonl；
                        显式指定则照旧用该路径。换环境 / 换展示键形态必须用独立进度文件）
  --env <envId>         目标 CloudBase 环境（默认 ${DEFAULT_ENV}）
  --display-prefix <p>  展示件对象键前缀（默认 ${DEFAULT_DISPLAY_PREFIX}；前端 .tiff 源件行
                        派生键要传 xiai/images/）
  --display-ext <png|webp>  展示件编码/扩展名（默认 ${DEFAULT_DISPLAY_EXT}：q92 零重采样；
                        png：-define png:compression-level=9 -strip，同样零重采样、保留原宽高）
  --thumb-prefix <p>    缩略图对象键前缀（默认 ${DEFAULT_THUMB_PREFIX}；缩略图恒为 .webp）
  --limit <n>           只处理前 n 张（小量试跑用）
  --batch <n>           单批张数（默认 ${DEFAULT_BATCH}：转码 → 探测 → 上传 → 落进度）
  --concurrency <n>     子进程并发（默认 ${DEFAULT_CONCURRENCY}）
  --probe-chunk <n>     探测/取临时 URL 的单次条目数（默认 ${DEFAULT_PROBE_CHUNK}；硬上限 ${PROBE_CHUNK_MAX}，传更大只会被压回 ${PROBE_CHUNK_MAX}）
  --overwrite           同键已存在但字节数不同 ⇒ 直接覆盖上传（status=ok，行上记 overwrote:true，
                        覆盖后重探字节复核）；默认不传 ⇒ 维持 conflict（不覆盖、退出码 2）
  --dry-run             只解码与算尺寸，不探测、不上传、不写进度
  --include-orphans     连 manifest 外的孤儿 TIFF 一并处理（默认跳过并在报告里列出）
  -h, --help            本帮助

退出码：0 全部成功；1 有 failed、回读断言失败或覆盖后重探字节不等；
        2 有 conflict（同键不同字节，未覆盖；--overwrite 时不产生 conflict）。`;

function die(msg) {
  console.error(`[error] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const o = {
    manifest: DEFAULT_MANIFEST,
    originals: DEFAULT_ORIGINALS,
    progress: null,            // null ⇒ 用按环境隔离的默认路径 progressFileFor(env)
    progressExplicit: false,   // 显式 --progress ⇒ 照旧读写指定路径（向后兼容）
    env: DEFAULT_ENV,
    displayPrefix: DEFAULT_DISPLAY_PREFIX,
    displayExt: DEFAULT_DISPLAY_EXT,
    thumbPrefix: DEFAULT_THUMB_PREFIX,
    limit: 0,
    batch: DEFAULT_BATCH,
    concurrency: DEFAULT_CONCURRENCY,
    probeChunk: DEFAULT_PROBE_CHUNK,
    overwrite: false,
    dryRun: false,
    includeOrphans: false,
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
      case '--manifest': o.manifest = take(); break;
      case '--originals': o.originals = take(); break;
      case '--progress': o.progress = take(); o.progressExplicit = true; break;
      case '--env': o.env = take(); break;
      case '--display-prefix': o.displayPrefix = take(); break;
      case '--display-ext': o.displayExt = String(take()).toLowerCase(); break;
      case '--thumb-prefix': o.thumbPrefix = take(); break;
      case '--limit': o.limit = Number(take()); break;
      case '--batch': o.batch = Number(take()); break;
      case '--concurrency': o.concurrency = Number(take()); break;
      case '--probe-chunk': o.probeChunk = Number(take()); break;
      case '--overwrite': o.overwrite = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--include-orphans': o.includeOrphans = true; break;
      case '--help': case '-h': o.help = true; break;
      default: die(`未知参数: ${a}（用 --help 看用法）`);
    }
  }
  for (const [k, v] of [['limit', o.limit], ['batch', o.batch], ['concurrency', o.concurrency], ['probeChunk', o.probeChunk]]) {
    if (!Number.isFinite(v) || v < 0 || (k !== 'limit' && v < 1)) die(`--${k} 取值非法: ${v}`);
  }
  // 对象键形态：前缀必须是相对键前缀（不许绝对路径 / 穿越），自动补尾部 '/'
  const normPrefix = (raw, name) => {
    const p = String(raw == null ? '' : raw).trim();
    if (!p) die(`--${name} 不能为空`);
    if (p.startsWith('/')) die(`--${name} 必须是相对对象键前缀，不得以 / 开头: ${raw}`);
    if (p.split('/').includes('..')) die(`--${name} 不得含 ..: ${raw}`);
    return p.endsWith('/') ? p : `${p}/`;
  };
  o.displayPrefix = normPrefix(o.displayPrefix, 'display-prefix');
  o.thumbPrefix = normPrefix(o.thumbPrefix, 'thumb-prefix');
  if (!DISPLAY_EXTS.includes(o.displayExt)) {
    die(`--display-ext 取值非法: ${o.displayExt}（只支持 ${DISPLAY_EXTS.join(' | ')}）`);
  }
  return o;
}

/** 展示件对象键：`<display-prefix><sha 前两位>/<sha>.<display-ext>` */
function displayKeyOf(sha, o) {
  return `${o.displayPrefix}${sha.slice(0, 2)}/${sha}.${o.displayExt}`;
}
/** 缩略图对象键：`<thumb-prefix><sha 前两位>/<sha>.webp`（缩略图恒 webp） */
function thumbKeyOf(sha, o) {
  return `${o.thumbPrefix}${sha.slice(0, 2)}/${sha}.webp`;
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

/* ------------------------------------------------------------ 凭据 / SDK */

const AUTH_PATH = path.join(os.homedir(), '.config', '.cloudbase', 'auth.json');
const TCB_BIN = fs.existsSync('/usr/local/bin/tcb') ? '/usr/local/bin/tcb' : 'tcb';
const MAGICK_BIN = process.env.MAGICK_BIN
  || (fs.existsSync('/opt/homebrew/bin/magick') ? '/opt/homebrew/bin/magick' : 'magick');

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
    const probePath = 'xiai/display/.prefix-probe';
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
    // 平台硬限：getFileInfo 单次最多 50 个 fileID，超限报 INVALID_PARAM
    // （"Cannot operate more than 50 files one time"）。这里自己算 Math.min(remaining, 50)，
    // 不依赖调用方传参：--probe-chunk 只能把批调小，传更大也只用到 PROBE_CHUNK_MAX。
    const chunkMax = Math.max(1, Math.min(PROBE_CHUNK_MAX, Number(this.probeChunk) || PROBE_CHUNK_MAX));
    for (let i = 0; i < items.length;) {
      const part = items.slice(i, i + Math.min(items.length - i, chunkMax));
      i += part.length;
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
    // getTempFileURL 同受「单次最多 50 个 fileID」平台硬限（同 INVALID_PARAM 报错），
    // 同样自己按 Math.min(remaining, 50) 分批，不依赖调用方传参。
    const chunkMax = Math.max(1, Math.min(PROBE_CHUNK_MAX, Number(this.probeChunk) || PROBE_CHUNK_MAX));
    for (let i = 0; i < items.length;) {
      const part = items.slice(i, i + Math.min(items.length - i, chunkMax));
      i += part.length;
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

/* ------------------------------------------------------------ manifest / 磁盘 */

function loadManifest(file) {
  if (!fs.existsSync(file)) die(`manifest 不存在: ${file}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim().length > 0);
  const rows = [];
  const seen = new Set();
  let dup = 0;
  let bad = 0;
  for (const line of lines) {
    let j;
    try { j = JSON.parse(line); } catch { bad++; continue; }
    const sha = j.sha256;
    if (!sha || !/^[0-9a-f]{64}$/.test(sha)) { bad++; continue; }
    if (seen.has(sha)) { dup++; continue; }
    seen.add(sha);
    rows.push({ sha, width: j.width ?? null, height: j.height ?? null, kind: j.kind ?? null, seqid: j.seqid ?? null });
  }
  return { lineCount: lines.length, rows, dup, bad };
}

function scanOriginals(dir) {
  const map = new Map(); // sha -> 相对路径
  if (!fs.existsSync(dir)) die(`originals 目录不存在: ${dir}`);
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, ent.name))) {
      if (!f.endsWith('.tiff')) continue;
      const sha = f.slice(0, -'.tiff'.length);
      if (/^[0-9a-f]{64}$/.test(sha)) map.set(sha, path.join(dir, ent.name, f));
    }
  }
  return map;
}

/** 行上记录的键形态是否与本次一致（老行无这些字段 ⇒ 不据此排除；有则必须逐字相等） */
function rowShapeMatches(j, shape) {
  if (!shape) return true;
  if (j.display_prefix != null && j.display_prefix !== shape.displayPrefix) return false;
  if (j.display_ext != null && j.display_ext !== shape.displayExt) return false;
  if (j.thumb_prefix != null && j.thumb_prefix !== shape.thumbPrefix) return false;
  return true;
}

function loadProgress(file, envId = null, shape = null) {
  const map = new Map();
  if (!fs.existsSync(file)) return { map, lines: 0, broken: 0, foreign: 0, shapeForeign: 0 };
  let broken = 0;
  let foreign = 0;
  let shapeForeign = 0;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      if (!j || !j.sha) { broken++; continue; }
      // 环境隔离：带 envId 且与本环境不符的行一律不算本环境进度
      // （老行无 envId 字段 ⇒ 历史产物，照旧接受；新行都带 envId）
      if (envId && j.envId && j.envId !== envId) { foreign++; continue; }
      // 键形态隔离：行上记了展示前缀/扩展名（或缩略图前缀）而与本次不符 ⇒ 不算本次进度
      // （显式 --progress 共用一个文件时也不会把 webp/display 那批 ok 当成 png/images 已完成）
      if (!rowShapeMatches(j, shape)) { shapeForeign++; continue; }
      map.set(j.sha, j);
    } catch { broken++; }
  }
  return { map, lines: lines.length, broken, foreign, shapeForeign };
}

/**
 * 合并读取本环境进度：
 *   - 以本环境文件（progress-<envId>.jsonl，或显式 --progress 指定的路径）为准；
 *   - 旧单文件 LEGACY_PROGRESS 只属于默认环境：仅在「跑默认环境 且 未显式 --progress」时
 *     作基线只读合入（保住历史断点），随后被本环境文件的同 sha 行覆盖；
 *   - 跑其它环境一律不读旧单文件 —— 不得把另一环境的 ok 当成本环境已完成。
 */
function loadMergedProgress(file, envId, legacyFile, useLegacyBaseline, shape = null) {
  const map = new Map();
  let broken = 0;
  let foreign = 0;
  let shapeForeign = 0;
  let legacyLines = 0;
  if (useLegacyBaseline) {
    const st = loadProgress(legacyFile, envId, shape);
    for (const [k, v] of st.map) map.set(k, v);
    legacyLines = st.lines;
    broken += st.broken;
    foreign += st.foreign;
    shapeForeign += st.shapeForeign;
  }
  const st = loadProgress(file, envId, shape);
  for (const [k, v] of st.map) map.set(k, v);
  broken += st.broken;
  foreign += st.foreign;
  shapeForeign += st.shapeForeign;
  return { map, lines: st.lines, broken, foreign, shapeForeign, legacyLines };
}

/* ------------------------------------------------------------ 转码（一遍出两个对象） */

async function transcode(row, originalsMap, tmpRoot, opts) {
  const sha = row.sha;
  const src = originalsMap.get(sha);
  if (!src) {
    const e = new Error('manifest 里的 sha 在 originals 下找不到对应 TIFF');
    e.permanent = true;
    throw e;
  }
  const dir = path.join(tmpRoot, sha);
  fs.mkdirSync(dir, { recursive: true });
  const dispExt = opts.displayExt;                       // 'webp' | 'png'
  const dispPath = path.join(dir, `native.${dispExt}`);
  const thumbPath = path.join(dir, 'thumb.webp');
  const srcArg = `${src}[0]`; // 多页取第 1 页；16bit 不改变尺寸

  // 展示件：零重采样，只做容器/编码转换（不带 -resize、无上限、不改宽高）
  if (dispExt === 'png') {
    // PNG：最大压缩 + 去元数据，**仍零重采样**（无 -resize，保留原宽高）
    await pExecFile(MAGICK_BIN, [srcArg, '-define', 'png:compression-level=9', '-strip', dispPath],
      { timeout: MAGICK_TIMEOUT_MS, maxBuffer: 4 << 20 });
  } else {
    await pExecFile(MAGICK_BIN, [srcArg, '-strip', '-quality', '92', '-define', 'webp:method=6', dispPath],
      { timeout: MAGICK_TIMEOUT_MS, maxBuffer: 4 << 20 });
  }
  // 缩略图：长边 ≤256，只缩不放（`>` 后缀 = 仅当大于时缩放）；恒为 webp
  await pExecFile(MAGICK_BIN, [srcArg, '-resize', `${THUMB_MAX}x${THUMB_MAX}>`, '-strip', '-quality', '82', thumbPath],
    { timeout: MAGICK_TIMEOUT_MS, maxBuffer: 4 << 20 });

  const id = await pExecFile(MAGICK_BIN, ['identify', '-format', '%m %w %h\\n', srcArg, dispPath, thumbPath],
    { timeout: MAGICK_TIMEOUT_MS, maxBuffer: 4 << 20 });
  const linesOut = id.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  if (linesOut.length !== 3) throw new Error(`identify 期望 3 行，实得 ${linesOut.length}: ${JSON.stringify(id.stdout)}`);
  const parse = (l) => {
    const [fmt, w, h] = l.split(/\s+/);
    return { fmt, w: Number(w), h: Number(h) };
  };
  const [srcInfo, dispInfo, thumbInfo] = linesOut.map(parse);
  if (![srcInfo, dispInfo, thumbInfo].every(x => Number.isFinite(x.w) && Number.isFinite(x.h) && x.w > 0 && x.h > 0)) {
    throw new Error(`identify 尺寸异常: ${JSON.stringify(linesOut)}`);
  }
  const expectDispFmt = dispExt.toUpperCase(); // 'WEBP' | 'PNG'
  if (dispInfo.fmt !== expectDispFmt || thumbInfo.fmt !== 'WEBP') {
    throw new Error(`产物格式异常（期望展示件=${expectDispFmt} 缩略图=WEBP）: ${JSON.stringify(linesOut)}`);
  }

  // 展示件断言：宽高必须与源 TIFF 第 1 页逐字相等（零重采样）
  if (dispInfo.w !== srcInfo.w || dispInfo.h !== srcInfo.h) {
    throw new Error(`展示件尺寸与源不一致: src=${srcInfo.w}x${srcInfo.h} display=${dispInfo.w}x${dispInfo.h}`);
  }
  // 缩略图断言：长边 == min(原长边, 256)
  const srcLong = Math.max(srcInfo.w, srcInfo.h);
  const expectLong = Math.min(srcLong, THUMB_MAX);
  const thumbLong = Math.max(thumbInfo.w, thumbInfo.h);
  if (thumbLong !== expectLong) {
    throw new Error(`缩略图长边异常: got=${thumbLong} expect=${expectLong} (src=${srcInfo.w}x${srcInfo.h})`);
  }

  return {
    srcW: srcInfo.w,
    srcH: srcInfo.h,
    nativeW: dispInfo.w,
    nativeH: dispInfo.h,
    thumbW: thumbInfo.w,
    thumbH: thumbInfo.h,
    dispPath,
    thumbPath,
    dispBytes: fs.statSync(dispPath).size,
    thumbBytes: fs.statSync(thumbPath).size,
    manifestMismatch: (row.width != null && row.height != null) && (row.width !== srcInfo.w || row.height !== srcInfo.h),
  };
}

/* ------------------------------------------------------------ 进度 */

function appendProgress(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}

/* ------------------------------------------------------------ 回读抽样 */

async function readbackSample(cloud, shas, originalsMap, tmpRoot, opts) {
  const dispExt = opts.displayExt;
  const expectDispFmt = dispExt.toUpperCase();
  const results = [];
  for (const sha of shas) {
    const displayKey = displayKeyOf(sha, opts);
    const thumbKey = thumbKeyOf(sha, opts);
    const src = originalsMap.get(sha);
    const item = { sha, pass: true, notes: [] };
    try {
      const srcId = await pExecFile(MAGICK_BIN, ['identify', '-format', '%w %h', `${src}[0]`],
        { timeout: MAGICK_TIMEOUT_MS, maxBuffer: 1 << 20 });
      const [sw, sh] = srcId.stdout.trim().split(/\s+/).map(Number);
      const srcLong = Math.max(sw, sh);
      const expectThumbLong = Math.min(srcLong, THUMB_MAX);

      const urls = await cloud.tempUrls([displayKey, thumbKey]);
      const dir = path.join(tmpRoot, 'readback', sha);
      fs.mkdirSync(dir, { recursive: true });
      for (const [label, key, expect, ext] of [
        ['display', displayKey, { w: sw, h: sh }, dispExt],
        ['thumb', thumbKey, { long: expectThumbLong }, 'webp'],
      ]) {
        const info = urls.get(key);
        if (!info || info.code !== 'SUCCESS' || !info.url) {
          item.pass = false;
          item.notes.push(`${label} 回读失败 code=${info ? info.code : 'NO_ITEM'}`);
          continue;
        }
        // 刚覆盖的对象数据面收敛未完成时 fetch 会被对端掐断（实测 undici 报 "terminated"），
        // 重试 3 次（间隔 5s / 15s）；仍拿不到字节才判 FAIL。
        let buf = null;
        let dlErr = null;
        for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
          if (attempt > 1) await new Promise(r => setTimeout(r, attempt === 2 ? 5000 : 15000));
          try {
            const resp = await fetch(info.url);
            if (!resp.ok) { dlErr = `HTTP ${resp.status}`; continue; }
            buf = Buffer.from(await resp.arrayBuffer());
          } catch (e) { dlErr = e.message; }
        }
        if (!buf) { item.pass = false; item.notes.push(`${label} 下载失败: ${dlErr}`); continue; }
        const f = path.join(dir, `${label}.${ext}`);
        fs.writeFileSync(f, buf);
        const idOut = await pExecFile(MAGICK_BIN, ['identify', '-format', '%m %w %h', f],
          { timeout: MAGICK_TIMEOUT_MS, maxBuffer: 1 << 20 });
        const [fmt, w, h] = idOut.stdout.trim().split(/\s+/);
        const wantFmt = label === 'display' ? expectDispFmt : 'WEBP';
        if (fmt !== wantFmt) { item.pass = false; item.notes.push(`${label} 格式=${fmt} 期望=${wantFmt}`); }
        const nw = Number(w), nh = Number(h);
        if (label === 'display') {
          if (nw !== expect.w || nh !== expect.h) {
            item.pass = false;
            item.notes.push(`display ${nw}x${nh} != src ${expect.w}x${expect.h}`);
          } else item.notes.push(`display ${nw}x${nh}==src ${expect.w}x${expect.h}`);
        } else {
          const long = Math.max(nw, nh);
          if (long !== expect.long) { item.pass = false; item.notes.push(`thumb long=${long} != ${expect.long}`); }
          else item.notes.push(`thumb ${nw}x${nh} long==min(${srcLong},256)=${expect.long}`);
        }
      }
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

  const manifest = loadManifest(path.resolve(opts.manifest));
  const originalsMap = scanOriginals(path.resolve(opts.originals));
  // 进度文件：按「环境 + 展示前缀 + 扩展名」隔离（默认形态沿用旧名 progress-<envId>.jsonl）；
  // 显式 --progress 照旧用指定路径（向后兼容），形态差异由行级 display_prefix/display_ext 过滤兜底
  const progressFile = opts.progressExplicit ? path.resolve(opts.progress) : progressFileFor(opts.env, opts.displayPrefix, opts.displayExt);
  // 本次键形态（读回时行上记了别的前缀/扩展名 ⇒ 不算本形态进度）
  const shape = { displayPrefix: opts.displayPrefix, displayExt: opts.displayExt, thumbPrefix: opts.thumbPrefix };
  const isDefaultShape = opts.displayPrefix === DEFAULT_DISPLAY_PREFIX && opts.displayExt === DEFAULT_DISPLAY_EXT
    && opts.thumbPrefix === DEFAULT_THUMB_PREFIX;
  // 旧单文件 progress.jsonl 只属于默认环境 + 默认键形态：
  // 仅「跑默认环境 且 未显式 --progress 且 默认键形态」时作基线只读合入
  const useLegacyBaseline = !opts.progressExplicit && opts.env === DEFAULT_ENV && isDefaultShape && fs.existsSync(LEGACY_PROGRESS);

  const manifestShas = new Set(manifest.rows.map(r => r.sha));
  const orphanShas = [...originalsMap.keys()].filter(s => !manifestShas.has(s)).sort();

  let list = manifest.rows.slice();
  if (opts.includeOrphans) {
    list = list.concat(orphanShas.map(sha => ({ sha, width: null, height: null, kind: 'orphan', seqid: null, orphan: true })));
  }
  const totalBeforeLimit = list.length;
  if (opts.limit > 0) list = list.slice(0, opts.limit);

  const progressState = loadMergedProgress(progressFile, opts.env, LEGACY_PROGRESS, useLegacyBaseline, shape);
  const progressMap = progressState.map;
  const TERMINAL = new Set(['ok', 'skipped']); // 续跑只跳过成功态；failed/conflict 重新检查

  console.log(`[config] env=${opts.env} overwrite=${opts.overwrite} dryRun=${opts.dryRun} includeOrphans=${opts.includeOrphans} limit=${opts.limit || 'ALL'} batch=${opts.batch} concurrency=${opts.concurrency}`);
  console.log(`[config] 展示件键=${opts.displayPrefix}<sha2>/<sha>.${opts.displayExt} 缩略图键=${opts.thumbPrefix}<sha2>/<sha>.webp`);
  console.log(`[config] manifest=${path.resolve(opts.manifest)} originals=${path.resolve(opts.originals)} progress=${progressFile}（按环境＋展示前缀＋扩展名隔离${useLegacyBaseline ? `；另以旧档 ${LEGACY_PROGRESS} ${progressState.legacyLines} 行作基线（只属默认环境＋默认键形态，只读）` : '；不读旧档 progress.jsonl'}）`);
  if (progressState.foreign > 0) console.log(`[progress] 忽略异环境行=${progressState.foreign}（envId≠${opts.env}，不计入本环境续跑）`);
  if (progressState.shapeForeign > 0) console.log(`[progress] 忽略异键形态行=${progressState.shapeForeign}（display_prefix/display_ext/thumb_prefix 与本次不符，不计入本次续跑）`);
  if (progressState.broken > 0) console.log(`[progress] 解析失败行=${progressState.broken}`);
  console.log(`[scan] manifest 行数=${manifest.lineCount} 唯一 sha=${manifest.rows.length} 重复=${manifest.dup} 非法行=${manifest.bad}`);
  console.log(`[scan] 磁盘 TIFF=${originalsMap.size} manifest 外孤儿=${orphanShas.length}`);
  if (!opts.includeOrphans && orphanShas.length > 0) {
    console.log(`[scan] 默认跳过孤儿（未入库、不静默丢，sha 列表见报告）: ${orphanShas.join(' ')}`);
  }
  if (manifest.bad > 0) console.log(`[warn] manifest 有 ${manifest.bad} 行解析失败`);

  const missing = list.filter(r => !originalsMap.has(r.sha));
  const pending = list.filter(r => originalsMap.has(r.sha));
  const resumeSkip = pending.filter(r => TERMINAL.has((progressMap.get(r.sha) || {}).status));
  const work = pending.filter(r => !TERMINAL.has((progressMap.get(r.sha) || {}).status));

  console.log(`[plan] 本批候选=${list.length} 缺源文件=${missing.length} 续跑跳过=${resumeSkip.length} 待处理=${work.length}`);
  if (opts.dryRun) console.log('[plan] DRY-RUN：只解码算尺寸，不探测、不上传、不写进度文件');

  // 缺源文件：记 failed（dry-run 只报告不落盘）
  for (const row of missing) {
    const rec = {
      sha: row.sha, envId: opts.env, at: new Date().toISOString(), status: 'failed',
      display_prefix: opts.displayPrefix, display_ext: opts.displayExt, thumb_prefix: opts.thumbPrefix,
      native_w: null, native_h: null, thumb_w: null, thumb_h: null,
      display_bytes: null, thumb_bytes: null, ms: 0, error: 'source TIFF missing on disk',
      orphan: !!row.orphan,
    };
    if (!opts.dryRun) { appendProgress(progressFile, rec); progressMap.set(row.sha, rec); }
  }

  const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'xiai-da-'));
  const stats = { decoded: 0, uploaded: 0, overwrote: 0, exists: 0, conflict: 0, failed: 0, decodeFail: 0 };
  let overwriteMismatch = 0;   // 收尾总复核后仍 != 本地新产物的键数（>0 ⇒ 退出码 1）
  const pendingVerify = [];    // --overwrite 即时探到「元数据未收敛」的键，跑完后统一收尾复核
  const failureNotes = [];
  const conflictShas = [];
  const doneThisRun = new Set();
  const verbose = work.length <= 100;
  let printed = 0;

  const cloud = opts.dryRun ? null : new Cloud(opts.env);
  if (cloud) {
    try {
      await cloud.init('启动');
    } catch (e) {
      if (await cloud.maybeRefresh(e)) await cloud.init('凭据刷新后');
      else throw e;
    }
    cloud.probeChunk = opts.probeChunk;
  }

  const chunks = chunk(work, opts.batch);
  let processed = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const batch = chunks[ci];
    const tBatch = Date.now();
    const results = await pool(batch, opts.concurrency, async (row) => {
      const t0 = Date.now();
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        try {
          const r = await transcode(row, originalsMap, tmpRoot, opts);
          return { row, ok: true, r, ms: Date.now() - t0 };
        } catch (e) {
          if (e.permanent || attempt === RETRIES) {
            return { row, ok: false, error: e.message, ms: Date.now() - t0 };
          }
          await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
        }
      }
    });

    const good = [];
    for (const res of results) {
      if (res.ok) { good.push(res); stats.decoded++; }
      else {
        stats.failed++; stats.decodeFail++;
        failureNotes.push(`${short(res.row.sha)} 转码失败: ${res.error}`);
        const rec = {
          sha: res.row.sha, envId: opts.env, at: new Date().toISOString(), status: 'failed',
          display_prefix: opts.displayPrefix, display_ext: opts.displayExt, thumb_prefix: opts.thumbPrefix,
          native_w: null, native_h: null, thumb_w: null, thumb_h: null,
          display_bytes: null, thumb_bytes: null, ms: res.ms, error: res.error,
          orphan: !!res.row.orphan,
        };
        if (!opts.dryRun) { appendProgress(progressFile, rec); progressMap.set(rec.sha, rec); }
        doneThisRun.add(res.row.sha);
      }
    }

    if (!opts.dryRun && good.length > 0) {
      // 一趟探测拿两族键的存在性与字节数
      let probeMap;
      try {
        const keys = good.flatMap(x => [
          displayKeyOf(x.row.sha, opts),
          thumbKeyOf(x.row.sha, opts),
        ]);
        probeMap = await cloud.probe(keys);
      } catch (e) {
        for (const x of good) {
          stats.failed++;
          failureNotes.push(`${short(x.row.sha)} 探测失败: ${e.message}`);
          const rec = {
            sha: x.row.sha, envId: opts.env, at: new Date().toISOString(), status: 'failed',
            display_prefix: opts.displayPrefix, display_ext: opts.displayExt, thumb_prefix: opts.thumbPrefix,
            native_w: x.r.nativeW, native_h: x.r.nativeH, thumb_w: x.r.thumbW, thumb_h: x.r.thumbH,
            display_bytes: x.r.dispBytes, thumb_bytes: x.r.thumbBytes, ms: x.ms, error: `probe: ${e.message}`,
            orphan: !!x.row.orphan,
          };
          appendProgress(progressFile, rec); progressMap.set(rec.sha, rec);
          doneThisRun.add(x.row.sha);
        }
        continue;
      }

      const settled = await pool(good, opts.concurrency, async (x) => {
        const sha = x.row.sha;
        const displayKey = displayKeyOf(sha, opts);
        const thumbKey = thumbKeyOf(sha, opts);
        const objects = {};
        let status = null;
        let err = null;

        const handle = async (key, localBytes, label) => {
          const info = probeMap.get(key);
          if (!info) { objects[label] = 'error'; err = err || `${label}: 探测无返回`; return; }
          if (info.code === 'SUCCESS') {
            if (info.size === localBytes) { objects[label] = 'exists'; stats.exists++; return; }
            // 同键不同字节：--overwrite ⇒ 不删先、直接覆盖上传；默认 ⇒ conflict（不覆盖、退出码 2）
            if (opts.overwrite) {
              try {
                const buf = fs.readFileSync(label === 'display' ? x.r.dispPath : x.r.thumbPath);
                await cloud.upload(key, buf);
                objects[label] = 'overwrote';
                stats.overwrote++;
              } catch (e) {
                objects[label] = 'error';
                err = err || `${label} 覆盖上传失败: ${e.message}`;
              }
              return;
            }
            objects[label] = 'conflict';
            stats.conflict++;
            return;
          }
          if (info.code === 'STORAGE_FILE_NONEXIST') {
            try {
              const buf = fs.readFileSync(label === 'display' ? x.r.dispPath : x.r.thumbPath);
              await cloud.upload(key, buf);
              objects[label] = 'uploaded';
              stats.uploaded++;
            } catch (e) {
              objects[label] = 'error';
              err = err || `${label} 上传失败: ${e.message}`;
            }
            return;
          }
          objects[label] = 'error';
          err = err || `${label} 探测异常 code=${info.code}`;
        };

        await handle(displayKey, x.r.dispBytes, 'display');
        await handle(thumbKey, x.r.thumbBytes, 'thumb');

        const states = Object.values(objects);
        if (states.includes('error')) status = 'failed';
        else if (states.includes('conflict')) status = 'conflict';
        else if (states.includes('uploaded') || states.includes('overwrote')) status = 'ok';
        else status = 'skipped';

        if (status === 'failed') stats.failed++;
        if (status === 'conflict') conflictShas.push(sha);

        const rec = {
          sha, envId: opts.env, at: new Date().toISOString(), status,
          display_prefix: opts.displayPrefix, display_ext: opts.displayExt, thumb_prefix: opts.thumbPrefix,
          display_key: displayKey, thumb_key: thumbKey,
          native_w: x.r.nativeW, native_h: x.r.nativeH,
          thumb_w: x.r.thumbW, thumb_h: x.r.thumbH,
          display_bytes: x.r.dispBytes, thumb_bytes: x.r.thumbBytes,
          ms: x.ms, objects,
          orphan: !!x.row.orphan,
        };
        if (states.includes('overwrote')) rec.overwrote = true;
        if (err) rec.error = err;
        if (x.r.manifestMismatch) rec.manifest_mismatch = true;
        appendProgress(progressFile, rec);
        progressMap.set(sha, rec);
        doneThisRun.add(sha);

        if (verbose) {
          console.log(`  [${++printed}/${work.length}] ${short(sha)} ${status} native=${rec.native_w}x${rec.native_h} thumb=${rec.thumb_w}x${rec.thumb_h} disp=${rec.display_bytes}B thumb=${rec.thumb_bytes}B ${rec.ms}ms${rec.overwrote ? ' overwrote=true' : ''}${err ? ' err=' + err : ''}`);
        }
        return rec;
      });

      // --overwrite 覆盖后即时重探：已覆盖键应 == 本地新产物字节。
      // 实测 CloudBase getFileInfo 的 size 在覆盖后有元数据收敛延迟（单键数秒~2 分钟内仍返回旧字节数），
      // 故即时探到不等的键不就地判失败，先并入 pendingVerify，回读之后做收尾总复核再定退出码。
      const owCheck = [];
      for (const rec of settled) {
        if (!rec || !rec.overwrote) continue;
        const s = rec.sha;
        if (rec.objects.display === 'overwrote') owCheck.push({ key: displayKeyOf(s, opts), bytes: rec.display_bytes });
        if (rec.objects.thumb === 'overwrote') owCheck.push({ key: thumbKeyOf(s, opts), bytes: rec.thumb_bytes });
      }
      if (owCheck.length > 0) {
        try {
          const m = await cloud.probe(owCheck.map(c => c.key));
          let same = 0;
          for (const c of owCheck) {
            const info = m.get(c.key);
            if (info && info.code === 'SUCCESS' && info.size === c.bytes) same++;
            else pendingVerify.push(c);
          }
          console.log(`[覆盖复核] 本批已覆盖 ${owCheck.length} 键：即时远端字节==本地=${same} 待收敛=${owCheck.length - same}（并入收尾总复核）`);
        } catch (e) {
          console.log(`[覆盖复核] 即时重探失败（${owCheck.length} 键并入收尾总复核）: ${e.message}`);
          pendingVerify.push(...owCheck);
        }
      }
    }

    if (opts.dryRun) {
      for (const x of good) {
        const rec = {
          sha: x.row.sha, at: new Date().toISOString(), status: 'decoded',
          native_w: x.r.nativeW, native_h: x.r.nativeH, thumb_w: x.r.thumbW, thumb_h: x.r.thumbH,
          display_bytes: x.r.dispBytes, thumb_bytes: x.r.thumbBytes, ms: x.ms,
          orphan: !!x.row.orphan, dry_run: true,
        };
        if (x.r.manifestMismatch) rec.manifest_mismatch = true;
        if (verbose) {
          console.log(`  [${++printed}/${work.length}] ${short(x.row.sha)} decoded native=${rec.native_w}x${rec.native_h} thumb=${rec.thumb_w}x${rec.thumb_h} disp=${rec.display_bytes}B thumb=${rec.thumb_bytes}B ${rec.ms}ms`);
        }
        doneThisRun.add(x.row.sha);
      }
    }

    processed += batch.length;
    // 清理本批临时产物，不把 TIFF/中间文件留在仓库里
    for (const x of results) {
      const dir = path.join(tmpRoot, x.row.sha);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    console.log(`[batch ${ci + 1}/${chunks.length}] 本批 ${batch.length} 张，用时 ${((Date.now() - tBatch) / 1000).toFixed(1)}s，累计处理 ${processed}/${work.length}`);
  }

  /* ---------------- 对账三读数 ---------------- */
  // 重新读回进度，保证统计口径来自磁盘
  const finalProgress = loadMergedProgress(progressFile, opts.env, LEGACY_PROGRESS, useLegacyBaseline, shape).map;
  const counts = { ok: 0, skipped: 0, conflict: 0, failed: 0, none: 0 };
  const successShas = [];
  for (const row of list) {
    const rec = finalProgress.get(row.sha);
    const st = rec ? rec.status : 'none';
    counts[st] = (counts[st] || 0) + 1;
    if (st === 'ok' || st === 'skipped') successShas.push(row.sha);
  }
  const uniqueSuccess = new Set(successShas);
  const s = uniqueSuccess.size;

  // 本 run 处理明细（幂等复跑的证据：全部命中进度、0 转码 0 上传）
  const resumeSkipSet = new Set(resumeSkip.map(r => r.sha));
  const disp = { resumeSkip: 0, ok: 0, skipped: 0, conflict: 0, failed: 0, decoded: 0, overwrote: 0, none: 0 };
  for (const row of list) {
    if (resumeSkipSet.has(row.sha)) { disp.resumeSkip++; continue; }
    if (doneThisRun.has(row.sha)) {
      const rec = progressMap.get(row.sha) || {};
      const st = rec.status || 'decoded';
      disp[st] = (disp[st] || 0) + 1;
      if (rec.overwrote) disp.overwrote++;
    } else {
      disp.none++;
    }
  }

  console.log('');
  console.log('================ 对账三读数 ================');
  console.log(`[读数1] manifest 行数 = ${manifest.lineCount}（唯一 sha = ${manifest.rows.length}，重复 = ${manifest.dup}）`);
  if (opts.dryRun) {
    const d = doneThisRun.size;
    console.log(`[读数2] 成功处理唯一 sha 数 = ${d}（dry-run：仅解码成功，未上传、未落进度文件）`);
    console.log(`[读数3] 两族对象应到数 = ${d * 2}（dry-run：按口径推算 display ${d} + thumb ${d}，实际未上传）`);
  } else {
    console.log(`[读数2] 成功处理唯一 sha 数 = ${s}（ok=${counts.ok || 0} skipped=${counts.skipped || 0}；conflict=${counts.conflict || 0} failed=${counts.failed || 0} none=${counts.none || 0}，本批候选 ${list.length}）`);
    console.log(`[读数3] 两族对象应到数 = ${s * 2}（display ${s} + thumb ${s}）`);
  }
  console.log('-------------------------------------------');
  console.log(`[本 run 处理明细] 幂等跳过=${disp.resumeSkip}（命中进度，未转码/未探测/未上传） 新处理=${(disp.ok || 0) + (disp.skipped || 0) + (disp.conflict || 0) + (disp.failed || 0) + (disp.decoded || 0)}（ok=${disp.ok || 0} 对象已存在=${disp.skipped || 0} conflict=${disp.conflict || 0} failed=${disp.failed || 0} decoded=${disp.decoded || 0} overwrote=${disp.overwrote || 0}） 未处理=${disp.none || 0}`);
  console.log(`[统计] 解码成功=${stats.decoded} 张；对象级：已存在同字节=${stats.exists} 新上传=${stats.uploaded} 覆盖上传=${stats.overwrote} conflict=${stats.conflict}；图片级 failed=${stats.failed}（含缺源文件 ${missing.length}）`);
  console.log(`[统计] 本 run 处理唯一 sha=${doneThisRun.size}；进度文件=${progressFile}（本环境本形态累计 ${loadProgress(progressFile, opts.env, shape).lines} 行${useLegacyBaseline ? ` ＋ 旧档基线只读 ${LEGACY_PROGRESS}` : ''}）`);
  if (orphanShas.length > 0) {
    const orphanInBatch = list.filter(r => r.orphan);
    if (opts.includeOrphans) {
      const done = orphanInBatch.filter(r => (
        opts.dryRun ? doneThisRun.has(r.sha) : ['ok', 'skipped'].includes((progressMap.get(r.sha) || {}).status)
      )).length;
      console.log(`[孤儿] manifest 外 ${orphanShas.length} 张，本批纳入 ${orphanInBatch.length} 张【单独计数】（解码/成功 ${done}/${orphanInBatch.length}）：`);
    } else {
      console.log(`[孤儿] manifest 外 ${orphanShas.length} 张（默认跳过，不入库、不静默丢；--include-orphans 才处理）：`);
    }
    for (const sha of orphanShas) console.log(`  - ${sha}.tiff`);
  }
  if (conflictShas.length > 0) {
    console.log(`[conflict] ${conflictShas.length} 个 sha 同键但字节数不同，未覆盖，需派单方裁定：`);
    for (const sha of conflictShas) console.log(`  - ${sha}`);
  }
  if (failureNotes.length > 0) {
    console.log(`[failed] ${failureNotes.length} 条：`);
    for (const n of failureNotes.slice(0, 50)) console.log(`  - ${n}`);
    if (failureNotes.length > 50) console.log(`  … 另 ${failureNotes.length - 50} 条见进度文件`);
  }

  /* ---------------- --overwrite 收尾总复核（先于回读：等元数据收敛，回读才不撞数据面半衰） ---------------- */
  // 覆盖后 getFileInfo 的 size 有元数据收敛延迟（实测单键数秒~2 分钟内仍返回旧字节数）：
  // 各批次即时探到「不等」的键在这里统一退避重探，最多 6 轮（10/20/30/40/50s，累计 ≤150s，收敛即提前返回）；
  // 窗口结束仍不等 ⇒ overwriteMismatch++（退出码 1），不静默放过。
  if (pendingVerify.length > 0) {
    const MAX_ROUNDS = 6;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    try {
      let pending = pendingVerify;
      let m = new Map();
      for (let round = 1; round <= MAX_ROUNDS && pending.length > 0; round++) {
        if (round > 1) await wait(10000 * (round - 1));
        m = await cloud.probe(pending.map(c => c.key));
        const still = pending.filter(c => {
          const info = m.get(c.key);
          return !(info && info.code === 'SUCCESS' && info.size === c.bytes);
        });
        if (round > 1) console.log(`[覆盖收尾复核] 第 ${round} 轮重探 ${pending.length} 键：仍不等 ${still.length}`);
        pending = still;
      }
      const same = pendingVerify.length - pending.length;
      console.log(`[覆盖收尾复核] 待收敛 ${pendingVerify.length} 键 → 最终远端字节==本地新产物=${same} 不等=${pending.length}（最多 ${MAX_ROUNDS} 轮 / 累计 ≤150s）`);
      for (const c of pending) {
        const info = m.get(c.key);
        overwriteMismatch++;
        console.log(`  - 不等: ${c.key} remote=${info ? `${info.size}(${info.code})` : 'NO_ITEM'} local=${c.bytes}`);
      }
    } catch (e) {
      overwriteMismatch += pendingVerify.length;
      console.log(`[覆盖收尾复核] 探测失败（${pendingVerify.length} 键不可核实）: ${e.message}`);
    }
  } else if (opts.overwrite && stats.overwrote > 0) {
    console.log('[覆盖收尾复核] 无待收敛键（覆盖键即时重探全部相等）');
  }

  /* ---------------- 抽 12 张回读 ---------------- */
  let readbackFail = 0;
  if (opts.dryRun) {
    console.log('[回读] dry-run 未上传，跳过回读抽样');
  } else if (uniqueSuccess.size === 0) {
    console.log('[回读] 无成功 sha，跳过回读抽样');
  } else {
    const arr = [...uniqueSuccess];
    const take = Math.min(12, arr.length);
    const samples = [];
    for (let i = 0; i < take; i++) samples.push(arr[Math.floor((i * arr.length) / take)]);
    console.log(`[回读] 抽 ${samples.length} 张回读（断言：可被 magick identify 解码；展示件宽高==源 TIFF 第1页；缩略图长边==min(原长边,256)）`);
    const rb = await readbackSample(cloud, samples, originalsMap, tmpRoot, opts);
    rb.forEach((it, i) => {
      console.log(`  [回读 ${i + 1}/${rb.length}] ${short(it.sha)} ${it.pass ? 'PASS' : 'FAIL'}  ${it.notes.join('; ')}`);
      if (!it.pass) readbackFail++;
    });
    console.log(`[回读] ${rb.length - readbackFail}/${rb.length} PASS`);
  }

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  if (readbackFail > 0) return 1;
  if ((counts.failed || 0) > 0) return 1;
  if (overwriteMismatch > 0) return 1;   // --overwrite 覆盖后重探：远端字节 != 本地新产物
  if ((counts.conflict || 0) > 0) return 2;
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error('[fatal]', e && e.stack ? e.stack : e);
    process.exit(1);
  });
