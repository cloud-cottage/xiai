#!/usr/bin/env node
/**
 * tools/repair-convert92-display.mjs
 * ============================================================================
 * 生产数据修复 · **只为 `converted_by=feicui-convert92` 这批（91 行）补展示件与缩略图**
 *
 * 背景：这 91 行 `xiai_images` 的**存储件**已被 PNG→TIFF 转码（行上 `sha256` /
 * `storage_key` / `mime` 已指向 `.tiff`），但前端对 `.tiff` 源件行只按**当前** `sha256`
 * 机械派生两个键去取图：
 *     `xiai/images/<sha2>/<sha>.png`   展示件
 *     `xiai/thumb/<sha2>/<sha>.webp`   缩略图（长边 ≤256）
 * 这两个对象对 91 行**全都不存在** ⇒ 页面「印面圖片暫缺」。
 * 本脚本【只新增对象】，把原图的字节补回展示键、并补缩略图。**不删、不改行、不改 <sha>.tiff**。
 *
 * 写集（**仅此两类键，绝不覆盖已有对象**）：
 *   xiai/images/<新 sha2>/<新 sha>.png      ← 展示件：原图是 PNG ⇒ 原字节**原样直传**（零重编码）；
 *                                            原图是 webp/jpg ⇒ 解码编**真 PNG**（png level 9、零重采样）
 *   xiai/thumb/<新 sha2>/<新 sha>.webp      ← magick '<展示件>[0]' -resize '256x256>' -strip -quality 82
 *
 * **实测偏差（本批 91 行）**：`original_storage_key` 并非全是 PNG —— png 30 / webp 46 / jpg 15。
 *   键名是 `.png`，所以**不能**把 webp/jpg 字节塞进去（键名撒谎，且卡片封面是把签名链接直接塞
 *   `<img src>`、由桶按扩展名回 `Content-Type` 解码，赌不得嗅探）⇒ 非 PNG 原图一律转真 PNG。
 *
 * 三不碰：
 *   · **不删任何对象**（本脚本没有任何删除 API）；
 *   · **不改任何数据库行**（只 `collection().where().get()` 读，无任何写调用）；
 *   · 不改 `src/**` / `cloudfunctions/**` / `scripts/**` / `docs/**`，不 git。
 *   本地只写本脚本与进度 JSONL（`--progress` 可改路径）；中间文件落 `$TMPDIR`，跑完即删。
 *
 * 幂等：**逐键判定**（不是逐行）—— 目标键已存在 ⇒ 该键跳过（绝不覆盖）；
 *   已存在但字节数与本地不等 ⇒ `conflict`（不覆盖，逐条报出）。两键都在 ⇒ 整行 `skipped`。
 *
 * 续跑：进度 JSONL 逐行追加，`status ∈ {ok, skipped}` 的行启动时跳过（`failed` / `conflict` 重查）。
 *
 * 用法：
 *   node tools/repair-convert92-display.mjs --dry-run --limit 3   # 只打印将写键与字节数，不写
 *   node tools/repair-convert92-display.mjs                       # 全量 91 行
 *   node tools/repair-convert92-display.mjs --verify-only         # 只做回读验收（不写）
 *
 * 退出码：0 全部到位；1 有 failed；2 有 conflict（同键不同字节，未覆盖）。
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
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const require = createRequire(path.join(REPO_ROOT, 'package.json'));

const AUTH_PATH = path.join(os.homedir(), '.config', '.cloudbase', 'auth.json');
const TCB_BIN = fs.existsSync('/usr/local/bin/tcb') ? '/usr/local/bin/tcb' : 'tcb';
const MAGICK_BIN = process.env.MAGICK_BIN
  || (fs.existsSync('/opt/homebrew/bin/magick') ? '/opt/homebrew/bin/magick' : 'magick');

const DEFAULT_ENV = 'liwu-cny1313-d1gb2fukyb7cb19bb';
const COLLECTION = 'xiai_images';
const DEFAULT_MARKER = 'feicui-convert92';
const DEFAULT_PROGRESS = path.join(SCRIPT_DIR, 'repair-convert92-display.progress.jsonl');
const PROBE_CHUNK_MAX = 50;          // getFileInfo / getTempFileURL 单次硬上限 50
const THUMB_MAX = 256;               // 缩略图长边（只缩不放）
const RETRIES = 2;
const MAGICK_TIMEOUT_MS = 180_000;
const CRED_MARGIN_MS = 10 * 60 * 1000;

function die(msg) { console.error(`[error] ${msg}`); process.exit(1); }

const HELP = `用法: node tools/repair-convert92-display.mjs [选项]

  --env <envId>       目标 CloudBase 环境（默认 ${DEFAULT_ENV}）
  --marker <s>        行筛选标记字段值 converted_by（默认 ${DEFAULT_MARKER}）
  --limit <n>         只处理前 n 行（dry-run 小量试跑用；0=全部）
  --batch <n>         单批行数（默认 20；每批先探测再处理）
  --concurrency <n>   并发（默认 3）
  --progress <path>   进度 JSONL（默认 tools/repair-convert92-display.progress.jsonl）
  --dry-run           只下载原图 + 生成缩略图并打印「将写键 / 字节数」，不上传、不写进度
  --verify-only       只做回读验收（全量探测 + 随机抽 5 行字节比对），不写任何对象
  --sample <n>        回读随机抽样行数（默认 5）
  -h, --help          本帮助
`;

function parseArgs(argv) {
  const o = {
    env: DEFAULT_ENV, marker: DEFAULT_MARKER, limit: 0, batch: 20, concurrency: 3,
    progress: DEFAULT_PROGRESS, dryRun: false, verifyOnly: false, sample: 5, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => { const v = argv[++i]; if (v === undefined) die(`选项 ${a} 缺少取值`); return v; };
    switch (a) {
      case '--env': o.env = take(); break;
      case '--marker': o.marker = take(); break;
      case '--limit': o.limit = Number(take()); break;
      case '--batch': o.batch = Number(take()); break;
      case '--concurrency': o.concurrency = Number(take()); break;
      case '--progress': o.progress = take(); break;
      case '--sample': o.sample = Number(take()); break;
      case '--dry-run': o.dryRun = true; break;
      case '--verify-only': o.verifyOnly = true; break;
      case '--help': case '-h': o.help = true; break;
      default: die(`未知参数: ${a}（用 --help 看用法）`);
    }
  }
  for (const k of ['limit', 'batch', 'concurrency', 'sample']) {
    if (!Number.isFinite(o[k]) || o[k] < (k === 'limit' ? 0 : 1)) die(`--${k} 取值非法: ${o[k]}`);
  }
  o.progress = path.resolve(o.progress);
  return o;
}

/* ------------------------------------------------------------ 键 / 工具 */

/** 前端 `cloudBaseObjectKeyOf` 对 `.tiff` 源件行的派生展示键（逐字一致，不得自创） */
const displayKeyOf = (sha) => `xiai/images/${sha.slice(0, 2)}/${sha}.png`;
const thumbKeyOf = (sha) => `xiai/thumb/${sha.slice(0, 2)}/${sha}.webp`;
const short = (s) => `${String(s).slice(0, 12)}…`;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

async function withRetry(fn, times = RETRIES, label = 'op') {
  let lastErr;
  for (let attempt = 0; attempt <= times; attempt++) {
    try { return await fn(attempt); } catch (e) {
      lastErr = e;
      if (attempt < times) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
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

/* ------------------------------------------------------------ 凭据 / SDK */

function readCredential() {
  if (!fs.existsSync(AUTH_PATH)) die(`找不到凭据文件 ${AUTH_PATH}`);
  const raw = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
  const c = raw.credential || raw;
  if (!c.tmpSecretId || !c.tmpSecretKey || !c.tmpToken) die(`${AUTH_PATH} 缺少 tmpSecretId/tmpSecretKey/tmpToken`);
  return c;
}

const credFresh = (c) => Number(c.tmpExpired || 0) - Date.now() > CRED_MARGIN_MS;

async function refreshCredential(reason) {
  console.log(`[auth] 刷新临时凭据（${reason}）：跑一次 tcb env list 后重读`);
  try { await pExecFile(TCB_BIN, ['env', 'list'], { timeout: 120_000, maxBuffer: 8 << 20 }); }
  catch (e) { console.warn(`[auth] tcb env list 失败: ${e.message}`); }
  return readCredential();
}

function isAuthError(e) {
  return /secret id|SIGN_PARAM|SignatureDoesNotMatch|expired|401|AccessDenied/i.test(`${(e && e.message) || ''} ${(e && e.code) || ''}`);
}

class Cloud {
  constructor(env) {
    this.env = env;
    this.sdk = require('@cloudbase/node-sdk');
    this.credential = readCredential();
    this.lastRefresh = 0;
    this.app = null;
    this.prefix = null;
    this.probeChunk = PROBE_CHUNK_MAX;
  }

  async init(reason = '启动') {
    if (!credFresh(this.credential)) this.credential = await refreshCredential(`${reason}：临时密钥已过期/临期`);
    this.app = this.sdk.init({
      secretId: this.credential.tmpSecretId,
      secretKey: this.credential.tmpSecretKey,
      sessionToken: this.credential.tmpToken,   // 临时密钥必须带 sessionToken，否则 SIGN_PARAM_INVALID
      env: this.env,
    });
    const probePath = 'xiai/.prefix-probe';
    const meta = await this.app.getUploadMetadata({ cloudPath: probePath });
    const fileId = meta && meta.data && meta.data.fileId;
    if (!fileId || !fileId.endsWith(probePath)) throw new Error(`getUploadMetadata 未返回合法 fileId: ${JSON.stringify(fileId)}`);
    this.prefix = fileId.slice(0, fileId.length - probePath.length);
    console.log(`[auth] env=${this.env} fileID 前缀=${this.prefix}`);
  }

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

  /** 批量探测：Map(key -> {code,size})；每次 ≤50 个 fileID（平台硬限） */
  async probe(keys) {
    const out = new Map();
    const items = keys.map((key) => ({ key, id: this.fileID(key) }));
    const chunkMax = Math.max(1, Math.min(PROBE_CHUNK_MAX, Number(this.probeChunk) || PROBE_CHUNK_MAX));
    const probeChunk = async (part) => {
      let res;
      const run = () => withRetry(() => this.app.getFileInfo({ fileList: part.map((p) => p.id) }), RETRIES, 'getFileInfo');
      try { res = await run(); }
      catch (e) { if (await this.maybeRefresh(e)) res = await run(); else throw e; }
      const list = (res && res.fileList) || [];
      const byId = new Map();
      for (const it of list) if (it && it.fileID) byId.set(it.fileID, it);
      part.forEach((p, i) => {
        const it = byId.get(p.id) || list[i];
        out.set(p.key, it ? { code: it.code, size: it.size, contentType: it.contentType } : { code: 'NO_ITEM' });
      });
    };
    for (const part of chunk(items, chunkMax)) await probeChunk(part);
    /* 瞬时错误（如 FETCH_FILE_INFO_ERROR / NO_ITEM）不等于「对象不存在」：
       对象存在与否的终态判据只有 SUCCESS / STORAGE_FILE_NONEXIST。
       非终态码再探两轮（间隔 1.5s / 4s），避免把瞬时错误误判成缺图或误判成可上传。 */
    const TERMINAL = new Set(['SUCCESS', 'STORAGE_FILE_NONEXIST']);
    for (const wait of [1500, 4000]) {
      const retryKeys = [...out.entries()].filter(([, v]) => !TERMINAL.has(v.code)).map(([k]) => k);
      if (retryKeys.length === 0) break;
      await new Promise((r) => setTimeout(r, wait));
      for (const part of chunk(retryKeys.map((key) => ({ key, id: this.fileID(key) })), chunkMax)) await probeChunk(part);
    }
    return out;
  }

  async download(key) {
    const run = async () => {
      const r = await this.app.downloadFile({ fileID: this.fileID(key) });
      const buf = Buffer.isBuffer(r.fileContent) ? r.fileContent : Buffer.from(r.fileContent);
      if (!buf || buf.length === 0) throw new Error('downloadFile 返回空字节');
      return buf;
    };
    try { return await withRetry(run, RETRIES, `download ${key}`); }
    catch (e) { if (await this.maybeRefresh(e)) return await withRetry(run, RETRIES, `download ${key}(刷新后)`); throw e; }
  }

  async upload(key, buf) {
    const run = () => this.app.uploadFile({ cloudPath: key, fileContent: buf });
    try { return await withRetry(run, RETRIES, `upload ${key}`); }
    catch (e) { if (await this.maybeRefresh(e)) return await withRetry(run, RETRIES, `upload ${key}(刷新后)`); throw e; }
  }

  /** 只读：取这批行（唯一的数据库接触面，零写入） */
  async loadRows(marker) {
    const db = this.app.database();
    const res = await db.collection(COLLECTION).where({ converted_by: marker }).limit(1000).get();
    return (res && res.data) || [];
  }
}

/* ------------------------------------------------------------ 行 → 计划 */

const ORIG_EXTS = ['png', 'webp', 'jpg', 'jpeg'];

function planOf(row) {
  const sha = String(row.sha256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`行 ${row.id || row._id} 的 sha256 非法: ${row.sha256}`);
  const origKey = String(row.original_storage_key || '').trim();
  const origExt = (origKey.split('.').pop() || '').toLowerCase();
  if (!ORIG_EXTS.includes(origExt)) throw new Error(`行 ${row.id || row._id} 的 original_storage_key 扩展名不在白名单(${ORIG_EXTS}): ${row.original_storage_key}`);
  if (String(row.storage_key || '') !== `xiai/images/${sha.slice(0, 2)}/${sha}.tiff`) {
    throw new Error(`行 ${row.id || row._id} 的 storage_key 与 sha256 不符: ${row.storage_key}`);
  }
  return {
    rowId: row.id || row._id,
    sha,
    origKey,
    origExt,
    origSha: String(row.original_sha256 || '').trim(),
    displayKey: displayKeyOf(sha),
    thumbKey: thumbKeyOf(sha),
  };
}

/** 缩略图：长边 ≤256，只缩不放（`>` = 仅当大于时缩放）；尺寸断言对**原图**（origPath）做 */
async function makeThumb(srcPath, outPath, origPath = srcPath) {
  await pExecFile(MAGICK_BIN, [`${srcPath}[0]`, '-resize', `${THUMB_MAX}x${THUMB_MAX}>`, '-strip', '-quality', '82', outPath],
    { timeout: MAGICK_TIMEOUT_MS, maxBuffer: 4 << 20 });
  const id = await pExecFile(MAGICK_BIN, ['identify', '-format', '%m %w %h\n', `${origPath}[0]`, outPath],
    { timeout: MAGICK_TIMEOUT_MS, maxBuffer: 1 << 20 });
  const lines = id.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 2) throw new Error(`identify 期望 2 行，实得 ${lines.length}: ${JSON.stringify(id.stdout)}`);
  const parse = (l) => { const [fmt, w, h] = l.split(/\s+/); return { fmt, w: Number(w), h: Number(h) }; };
  const [src, thumb] = lines.map(parse);
  if (thumb.fmt !== 'WEBP') throw new Error(`缩略图格式=${thumb.fmt}，期望 WEBP`);
  const expectLong = Math.min(Math.max(src.w, src.h), THUMB_MAX);
  if (Math.max(thumb.w, thumb.h) !== expectLong) {
    throw new Error(`缩略图长边=${Math.max(thumb.w, thumb.h)}，期望 min(${Math.max(src.w, src.h)},256)=${expectLong}`);
  }
  return { srcW: src.w, srcH: src.h, thumbW: thumb.w, thumbH: thumb.h, thumbBytes: fs.statSync(outPath).size };
}

function appendProgress(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

function loadProgress(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j && j.sha) map.set(j.sha, j);
    } catch { /* 坏行忽略 */ }
  }
  return map;
}

/* ------------------------------------------------------------ 单行处理 */

/**
 * 单行处理。返回 {status, rec}
 *   status: ok（有上传）| skipped（两键都已存在且字节一致）| conflict | failed
 *
 * 展示件口径（**实测：91 行的 original 并非全是 PNG** —— png 30 / webp 46 / jpg 15）：
 *   · 原对象是 **PNG** ⇒ 原字节**原样直传**（零重编码，字节数与 original 逐字相等）；
 *   · 原对象是 **webp/jpg** ⇒ 解码后编成**真 PNG**（`png:compression-level=9 -strip`，零重采样、
 *     宽高逐字等于原图）。**不把 webp/jpg 字节塞进 `.png` 键** —— 那会让键名撒谎、
 *     且卡片封面是把对象签名链接直接塞进 `<img src>` 的，靠 Content-Type 解码，不能赌嗅探。
 */
async function repairOne(plan, cloud, tmpRoot, opts, probeMap) {
  const t0 = Date.now();
  const rec = {
    rowId: plan.rowId, sha: plan.sha, original_sha256: plan.origSha,
    original_key: plan.origKey, original_ext: plan.origExt,
    display_key: plan.displayKey, thumb_key: plan.thumbKey,
    objects: {}, display_bytes: null, thumb_bytes: null,
    src_w: null, src_h: null, thumb_w: null, thumb_h: null, ms: 0,
  };
  const dispInfo = probeMap.get(plan.displayKey);
  const thumbInfo = probeMap.get(plan.thumbKey);
  const dispExists = !!(dispInfo && dispInfo.code === 'SUCCESS');
  const thumbExists = !!(thumbInfo && thumbInfo.code === 'SUCCESS');

  // 1) 下载 original（原字节）
  const orig = await cloud.download(plan.origKey);
  if (plan.origSha && sha256(orig) !== plan.origSha) {
    throw new Error(`original 现算 sha256≠行上 original_sha256（actual=${short(sha256(orig))}）`);
  }
  rec.original_bytes = orig.length;

  const dir = fs.mkdtempSync(path.join(tmpRoot, 'row-'));
  const origPath = path.join(dir, `orig.${plan.origExt}`);
  fs.writeFileSync(origPath, orig);

  // 2) 展示件字节：PNG 原样；webp/jpg 编成真 PNG（零重采样）
  let dispBuf;
  let dispMode;
  if (plan.origExt === 'png') {
    if (orig.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('original 声明 .png 但 magic 不符');
    dispBuf = orig;
    dispMode = 'verbatim';
  } else {
    const pngPath = path.join(dir, 'display.png');
    await pExecFile(MAGICK_BIN, [`${origPath}[0]`, '-define', 'png:compression-level=9', '-strip', pngPath],
      { timeout: MAGICK_TIMEOUT_MS, maxBuffer: 4 << 20 });
    dispBuf = fs.readFileSync(pngPath);
    dispMode = `rendered-from-${plan.origExt}`;
  }
  rec.display_mode = dispMode;
  rec.display_bytes = dispBuf.length;

  // 3) 尺寸断言（展示件宽高必须逐字等于原图）+ 缩略图（长边 ≤256，只缩不放）
  const dispPath = path.join(dir, 'display-check.png');
  fs.writeFileSync(dispPath, dispBuf);
  const thumbPath = path.join(dir, 'thumb.webp');
  const dims = await makeThumb(dispPath, thumbPath, origPath);
  rec.src_w = dims.srcW; rec.src_h = dims.srcH;
  rec.thumb_w = dims.thumbW; rec.thumb_h = dims.thumbH;
  rec.thumb_bytes = dims.thumbBytes;

  if (opts.dryRun) {
    rec.objects = { display: dispExists ? 'exists' : 'would_upload', thumb: thumbExists ? 'exists' : 'would_upload' };
    const status = (!dispExists || !thumbExists) ? 'ok' : 'skipped';
    fs.rmSync(dir, { recursive: true, force: true });
    return { status, rec: { ...rec, ms: Date.now() - t0, dry_run: true } };
  }

  // 4) 展示件：不存在则上传；已存在只核字节（**绝不覆盖**）
  let dispState;
  if (dispExists) {
    if (dispInfo.size === dispBuf.length) dispState = 'exists';
    else { dispState = 'conflict'; rec.error = `display 已存在但字节不同 remote=${dispInfo.size} local=${dispBuf.length}（不覆盖）`; }
  } else {
    await cloud.upload(plan.displayKey, dispBuf);
    dispState = 'uploaded';
  }
  rec.objects.display = dispState;

  // 5) 缩略图：同上
  let thumbState;
  if (thumbExists) {
    if (thumbInfo.size === dims.thumbBytes) thumbState = 'exists';
    else { thumbState = 'conflict'; rec.error = `${rec.error ? `${rec.error}; ` : ''}thumb 已存在但字节不同 remote=${thumbInfo.size} local=${dims.thumbBytes}（不覆盖）`; }
  } else {
    await cloud.upload(plan.thumbKey, fs.readFileSync(thumbPath));
    thumbState = 'uploaded';
  }
  rec.objects.thumb = thumbState;

  let status;
  if (dispState === 'conflict' || thumbState === 'conflict') status = 'conflict';
  else if (dispState === 'uploaded' || thumbState === 'uploaded') status = 'ok';
  else status = 'skipped';

  fs.rmSync(dir, { recursive: true, force: true });
  rec.ms = Date.now() - t0;
  return { status, rec };
}

/* ------------------------------------------------------------ 回读验收 */

async function readback(cloud, rows, opts) {
  const plans = rows.map(planOf);
  const stat = { disp: 0, thumb: 0, orig: 0 };
  const allKeys = plans.flatMap((p) => [p.displayKey, p.thumbKey]);
  const probeMap = await cloud.probe(allKeys);
  const origProbe = await cloud.probe(plans.map((p) => p.origKey));
  let ok = 0;
  let byteEq = 0;
  const bad = [];
  for (const p of plans) {
    const d = probeMap.get(p.displayKey) || { code: 'NO_ITEM' };
    const t = probeMap.get(p.thumbKey) || { code: 'NO_ITEM' };
    const o = origProbe.get(p.origKey) || { code: 'NO_ITEM' };
    const dOk = d.code === 'SUCCESS';
    const tOk = t.code === 'SUCCESS';
    const oOk = o.code === 'SUCCESS';
    // 键齐 = 两键 SUCCESS；字节相等只对「原图本身就是 PNG（原字节直传）」成立
    const eq = dOk && oOk ? d.size === o.size : false;
    if (dOk) stat.disp++;
    if (tOk) stat.thumb++;
    if (oOk) stat.orig++;
    if (eq) byteEq++;
    if (dOk && tOk) ok++;
    else bad.push(`${p.rowId} ${short(p.sha)} display=${d.code}${d.size != null ? `(${d.size}B)` : ''} thumb=${t.code}${t.size != null ? `(${t.size}B)` : ''} original=${o.code}${o.size != null ? `(${o.size}B)` : ''}`);
  }
  console.log(`[回读·全量] 行=${plans.length} display_存在=${stat.disp} thumb_存在=${stat.thumb} original_存在=${stat.orig} 两键齐=${ok}/${plans.length}（其中 .png字节==original字节=${byteEq}，为「原图即 PNG、原字节直传」的行；其余为 webp/jpg 转真 PNG）`);
  for (const b of bad) console.log(`  - 未达标: ${b}`);

  // 随机抽 5 行：下载逐字节比对 + 缩略图可解码
  const n = Math.min(opts.sample, plans.length);
  const idx = [...plans.keys()];
  for (let i = idx.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const picks = idx.slice(0, n).map((i) => plans[i]);
  console.log(`[回读·抽样 ${n} 行] 断言：展示键内容是**真 PNG**、宽高==原图；原图为 PNG 的行另断言字节/sha256 与 original 逐字相同；缩略图 WEBP 且长边==min(原长边,${THUMB_MAX})`);
  let pass = 0;
  for (const p of picks) {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rb-'));
    try {
      const [a, b, t] = [await cloud.download(p.displayKey), await cloud.download(p.origKey), await cloud.download(p.thumbKey)];
      const same = a.length === b.length && sha256(a) === sha256(b);
      const dispFile = path.join(dir, `disp.png`);
      const srcFile = path.join(dir, `src.${p.origExt}`);
      const thumbFile = path.join(dir, 't.webp');
      fs.writeFileSync(dispFile, a); fs.writeFileSync(srcFile, b); fs.writeFileSync(thumbFile, t);
      const id = await pExecFile(MAGICK_BIN, ['identify', '-format', '%m %w %h\n', dispFile, srcFile, thumbFile],
        { timeout: MAGICK_TIMEOUT_MS, maxBuffer: 1 << 20 });
      const [dl, sl, tl] = id.stdout.trim().split('\n').map((l) => l.trim().split(/\s+/));
      const [dFmt, dw, dh] = [dl[0], Number(dl[1]), Number(dl[2])];
      const [sFmt, sw, sh] = [sl[0], Number(sl[1]), Number(sl[2])];
      const [tFmt, tw, th] = [tl[0], Number(tl[1]), Number(tl[2])];
      const dimsOk = dw === sw && dh === sh;
      const expectLong = Math.min(Math.max(sw, sh), THUMB_MAX);
      const thumbOk = tFmt === 'WEBP' && Math.max(tw, th) === expectLong;
      const byteOk = p.origExt === 'png' ? same : true;   // 非 PNG 原图 ⇒ 真 PNG 编码，字节数不同属预期
      const yes = dFmt === 'PNG' && dimsOk && thumbOk && byteOk;
      if (yes) pass++;
      console.log(`  [回读 ${p.rowId}] ${yes ? 'PASS' : 'FAIL'} 展示=${p.displayKey} ${a.length}B ${dFmt} ${dw}x${dh} | original(${p.origExt})=${b.length}B ${sFmt} ${sw}x${sh} | 字节同=${same} sha256同=${sha256(a) === sha256(b)} | 缩略=${p.thumbKey} ${t.length}B ${tFmt} ${tw}x${th}(长边==min(${Math.max(sw, sh)},256)=${expectLong})`);
    } catch (e) {
      console.log(`  [回读 ${p.rowId}] FAIL 异常: ${e.message}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`[回读·抽样] ${pass}/${n} PASS`);
  return { ok, total: plans.length, bad, samplePass: pass, sampleN: n };
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }

  const cloud = new Cloud(opts.env);
  try { await cloud.init('启动'); } catch (e) { if (await cloud.maybeRefresh(e)) await cloud.init('凭据刷新后'); else throw e; }

  const rawRows = await cloud.loadRows(opts.marker);
  console.log(`[scan] 集合=${COLLECTION} where converted_by='${opts.marker}' ⇒ ${rawRows.length} 行（只读，无任何 DB 写调用）`);
  if (rawRows.length === 0) die('筛选到 0 行，拒绝继续');

  let list = rawRows.map((r) => ({ r, p: planOf(r) }));
  if (opts.limit > 0) list = list.slice(0, opts.limit);
  console.log(`[plan] 候选行=${list.length}${opts.limit > 0 ? `（--limit ${opts.limit}）` : ''} dryRun=${opts.dryRun} verifyOnly=${opts.verifyOnly}`);
  console.log(`[plan] 展示件键=xiai/images/<sha2>/<sha>.png（原图即 PNG ⇒ 原字节直传；webp/jpg ⇒ 解码编真 PNG，零重采样、宽高逐字等于原图） 缩略图键=xiai/thumb/<sha2>/<sha>.webp（长边≤${THUMB_MAX}，只缩不放）`);

  if (opts.verifyOnly) {
    const r = await readback(cloud, rawRows, opts);
    return r.ok === r.total ? 0 : 1;
  }

  const progressMap = opts.dryRun ? new Map() : loadProgress(opts.progress);
  console.log(`[progress] ${opts.progress} 已有 ${progressMap.size} 条${opts.dryRun ? '（dry-run 只读不写）' : ''}`);

  const stats = { ok: 0, skipped: 0, failed: 0, conflict: 0 };
  const failures = [];
  const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'repair92-'));

  const todo = list.filter(({ p }) => {
    const rec = progressMap.get(p.sha);
    return !(rec && (rec.status === 'ok' || rec.status === 'skipped'));
  });
  const resumeSkip = list.length - todo.length;
  console.log(`[plan] 续跑跳过=${resumeSkip} 待处理=${todo.length}`);

  let printed = 0;
  for (const batch of chunk(todo, opts.batch)) {
    const probeMap = await cloud.probe(batch.flatMap(({ p }) => [p.displayKey, p.thumbKey]));
    const results = await pool(batch, opts.concurrency, async ({ r, p }) => {
      try {
        const out = await repairOne(p, cloud, tmpRoot, opts, probeMap);
        return { p, out };
      } catch (e) {
        return { p, out: { status: 'failed', rec: { rowId: p.rowId, sha: p.sha, ms: 0, error: e.message } } };
      }
    });
    for (const { p, out } of results) {
      const { status, rec } = out;
      stats[status] = (stats[status] || 0) + 1;
      if (status === 'failed') failures.push(`${p.rowId} ${short(p.sha)} failed: ${rec.error}`);
      if (status === 'conflict') { stats.conflict++; failures.push(`${p.rowId} ${short(p.sha)} conflict: ${rec.error}`); }
      const recOut = {
        envId: opts.env, at: new Date().toISOString(), status,
        display_prefix: 'xiai/images/', thumb_prefix: 'xiai/thumb/',
        ...rec,
      };
      if (!opts.dryRun) appendProgress(opts.progress, recOut);
      if (opts.dryRun) {
        const dState = rec.objects.display, tState = rec.objects.thumb;
        console.log(`  [dry ${++printed}/${todo.length}] ${p.rowId} ${short(p.sha)} status=${status}`);
        console.log(`      将写 ${p.displayKey}  ${rec.display_bytes} B  (${dState})`);
        console.log(`      将写 ${p.thumbKey}  ${rec.thumb_bytes} B  (${tState})`);
      } else {
        console.log(`  [${++printed}/${todo.length}] ${p.rowId} ${short(p.sha)} ${status} display=${rec.objects.display}${rec.display_bytes != null ? `(${rec.display_bytes}B)` : ''} thumb=${rec.objects.thumb}${rec.thumb_bytes != null ? `(${rec.thumb_bytes}B)` : ''}${rec.thumb_w ? ` ${rec.src_w}x${rec.src_h}→${rec.thumb_w}x${rec.thumb_h}` : ''} ${rec.ms}ms${rec.error ? ` err=${rec.error}` : ''}`);
      }
    }
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (opts.dryRun) {
    console.log('');
    console.log(`[dry-run 汇总] 候选=${list.length} 将写 display=${stats.ok ? '≤' : ''}${stats.ok || 0} 行，其中已存在跳过=${stats.skipped}；失败=${stats.failed}；未上传任何对象、未写进度`);
    return stats.failed > 0 ? 1 : 0;
  }

  /* ---- 收尾三读数（读回进度文件，口径来自磁盘） ---- */
  const finalMap = loadProgress(opts.progress);
  const counts = { ok: 0, skipped: 0, failed: 0, conflict: 0, none: 0 };
  for (const r of rawRows) {
    const sha = String(r.sha256 || '').trim().toLowerCase();
    const rec = finalMap.get(sha);
    const st = rec ? rec.status : 'none';
    counts[st] = (counts[st] || 0) + 1;
  }
  console.log('');
  console.log('================ 三读数 ================');
  console.log(`[读数1] 批量行数 = ${rawRows.length}`);
  console.log(`[读数2] {ok,skipped,failed} = ${JSON.stringify({ ok: counts.ok || 0, skipped: counts.skipped || 0, failed: counts.failed || 0 })}（另 conflict=${counts.conflict || 0} none=${counts.none || 0}）`);
  console.log(`[读数3] 本 run 明细 {ok,skipped,failed} = ${JSON.stringify({ ok: stats.ok || 0, skipped: stats.skipped || 0, failed: stats.failed || 0 })}（conflict=${stats.conflict || 0}；续跑跳过=${resumeSkip}）`);
  if (failures.length) {
    console.log(`[失败清单] ${failures.length} 条：`);
    for (const f of failures) console.log(`  - ${f}`);
  } else {
    console.log('[失败清单] 空');
  }

  /* ---- 回读验收 ---- */
  const rb = await readback(cloud, rawRows, opts);

  if ((counts.failed || 0) > 0 || rb.ok !== rb.total) return 1;
  if ((counts.conflict || 0) > 0) return 2;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error('[fatal]', e && e.stack ? e.stack : e); process.exit(1); });
