#!/usr/bin/env python3
"""xiai 影像「静态化」离线产物生成（P0）· 展示件 + 缩略图

做什么
------
对 `data/originals/**/*.tiff`（内容寻址：`<sha256[:2]>/<sha256>.tiff`）**离线**生成两类 WebP：

  · 展示件 display：长边 ≤ 1600、WebP 有损 q=0.92（libwebp 0–100 标度 ⇒ quality=92）
  · 缩略图 thumb  ：长边 ≤ 256、同上

产物按**源 sha256 内容寻址命名**，落位（与线上对象键 1:1 对齐）：

  <out>/display/<sha[:2]>/<sha>.webp
  <out>/thumb/<sha[:2]>/<sha>.webp

纪律
----
① **幂等**：目标已存在且是真 WebP（RIFF/WEBP 魔数）⇒ 直接跳过，不重算（可续跑）；
② **绝不写 `data/originals/`**（只读输入；产物只落在 `--out`）；
③ 并发 ≤ 8（`--workers`，上限被硬夹到 8）；
④ 打印进度（每 200 件 / 每 15 秒）＋ 末尾失败清单（并写 `<out>/report.json`）；
⑤ 编码口径对齐 `server/app/codec.py::bitmap_to_webp`（mode 归一 → WEBP 有损 → method=4 →
   魔数自证），**唯一差异＝质量标度**（见下 ★）。

★ 质量标度说明（如实登记，不改业务代码）
    `codec.DISPLAY_WEBP_QUALITY = 0.92` 被直接传进 Pillow `quality=`，而 Pillow/libwebp 的
    `quality` 是 **0–100 整数标度** ⇒ 实测 `quality=0.92` 的产物字节数与 `quality=0` 同档
    （512² 渐变测试图：0.92 → 6038B / 0 → 5208B / 92 → 25690B）。
    本脚本按**规范字面口径「質量 0.92」**取 `quality=92`（＝0.92×100）；如需逐字节复刻线上
    服务的现有产出，加 `--quality 0.92` 即可。

用法
----
    server/.venv/bin/python scripts/migration/build_display_artifacts.py \
        --src data/originals --out scripts/migration/out/artifacts --workers 8
    ... --limit 5          # 冒烟
    ... --only thumb       # 只补缩略图
    ... --force            # 忽略已有产物重算
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

# ── 口径（真源对齐：server/app/codec.py；尺寸取自派单件）─────────────────────────
DISPLAY_LONG_EDGE = 1600
THUMB_LONG_EDGE = 256
WEBP_QUALITY = 92          # ★ 见文件头「质量标度说明」
WEBP_METHOD = 4            # codec.bitmap_to_webp 同值
WEBP_MAGIC = b"RIFF"
WEBP_MAGIC2 = b"WEBP"
HEX = set("0123456789abcdef")
MAX_WORKERS = 8            # 派单硬约束：并发 ≤ 8
PROGRESS_EVERY_N = 200
PROGRESS_EVERY_S = 15.0


def scale_to_long_edge(img: Image.Image, long_edge: int) -> Image.Image:
    """长边 ≤ long_edge（不放大；LANCZOS）—— 与 main._scale_to_long_edge 同法。"""
    width, height = img.size
    longest = max(width, height)
    if longest <= long_edge:
        return img
    ratio = long_edge / float(longest)
    return img.resize((max(1, round(width * ratio)), max(1, round(height * ratio))), Image.LANCZOS)


def to_webp(img: Image.Image, quality: float) -> bytes:
    """展示件 / 缩略图编码（与 codec.bitmap_to_webp 同路径；quality 标度见文件头 ★）。"""
    buf = io.BytesIO()
    src = img if img.mode in ("RGB", "RGBA") else img.convert("RGBA" if "A" in img.getbands() else "RGB")
    src.save(buf, format="WEBP", quality=float(quality), lossless=False, method=WEBP_METHOD)
    out = buf.getvalue()
    if len(out) < 12 or out[0:4] != WEBP_MAGIC or out[8:12] != WEBP_MAGIC2:
        raise ValueError("not a real WebP (magic mismatch)")
    return out


def is_webp(path: Path) -> bool:
    """目标产物自证：存在、非空、魔数是 RIFF/WEBP（否则视为未生成，重算）。"""
    try:
        with path.open("rb") as fh:
            head = fh.read(12)
        return len(head) == 12 and head[0:4] == WEBP_MAGIC and head[8:12] == WEBP_MAGIC2 and path.stat().st_size > 0
    except OSError:
        return False


def atomic_write(path: Path, data: bytes) -> None:
    """同目录临时文件 + os.replace（同文件系统内原子；不落半件）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def process_one(src: Path, out_root: Path, quality: float, force: bool, only: str = "both") -> dict:
    """单个 TIFF ⇒ (display, thumb) 两件产物。返回逐件读数（供汇总 / 失败清单）。"""
    rel = src.name
    sha = src.stem.lower()
    started = time.perf_counter()
    if len(sha) != 64 or any(c not in HEX for c in sha):
        return {"ok": False, "rel": rel, "error": "文件名不是 64 位 sha256", "ms": 0}
    disp_path = out_root / "display" / sha[:2] / f"{sha}.webp"
    thumb_path = out_root / "thumb" / sha[:2] / f"{sha}.webp"

    want_disp = only in ("both", "display")
    want_thumb = only in ("both", "thumb")
    disp_done = (not want_disp) or ((not force) and is_webp(disp_path))
    thumb_done = (not want_thumb) or ((not force) and is_webp(thumb_path))
    if disp_done and thumb_done:
        return {
            "ok": True, "sha256": sha, "skipped": True, "rel": rel,
            "display_bytes": disp_path.stat().st_size, "thumb_bytes": thumb_path.stat().st_size,
            "src_bytes": src.stat().st_size, "ms": round((time.perf_counter() - started) * 1000, 1),
        }

    try:
        data = src.read_bytes()
        img = Image.open(io.BytesIO(data))
        img.load()                      # 强制解码：截断 / 损坏在此暴露
        src_size = img.size
        display_bytes = None
        thumb_bytes = None
        if not disp_done:
            display_bytes = to_webp(scale_to_long_edge(img, DISPLAY_LONG_EDGE), quality)
            atomic_write(disp_path, display_bytes)
        if not thumb_done:
            thumb_bytes = to_webp(scale_to_long_edge(img, THUMB_LONG_EDGE), quality)
            atomic_write(thumb_path, thumb_bytes)
        return {
            "ok": True, "sha256": sha, "skipped": False, "rel": rel,
            "display_bytes": len(display_bytes) if display_bytes is not None else disp_path.stat().st_size,
            "thumb_bytes": len(thumb_bytes) if thumb_bytes is not None else thumb_path.stat().st_size,
            "src_bytes": len(data), "src_size": list(src_size),
            "ms": round((time.perf_counter() - started) * 1000, 1),
        }
    except Exception as exc:  # noqa: BLE001 —— 单件失败不中断整批，入失败清单
        return {
            "ok": False, "sha256": sha, "rel": rel, "src_bytes": src.stat().st_size if src.exists() else 0,
            "error": f"{type(exc).__name__}: {exc}",
            "ms": round((time.perf_counter() - started) * 1000, 1),
        }


def human_bytes(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if abs(n) < 1024 or unit == "GiB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} GiB"


def main() -> int:
    ap = argparse.ArgumentParser(description="xiai 静态化：TIFF ⇒ display/thumb WebP（内容寻址、幂等、并发≤8）")
    here = Path(__file__).resolve()
    repo = here.parents[2]
    ap.add_argument("--src", default=str(repo / "data" / "originals"), help="原件根（只读）")
    ap.add_argument("--out", default=str(here.parent / "out" / "artifacts"), help="产物根（临时/可续跑）")
    ap.add_argument("--workers", type=int, default=8, help="并发（硬上限 8）")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 个（冒烟用；0＝全量）")
    ap.add_argument("--only", choices=["both", "display", "thumb"], default="both", help="只补哪一类")
    ap.add_argument("--quality", type=float, default=WEBP_QUALITY, help="WebP quality（0–100 标度）")
    ap.add_argument("--force", action="store_true", help="忽略已有产物重算")
    ap.add_argument("--report", default="", help="报告路径（默认 <out>/report.json）")
    args = ap.parse_args()

    workers = max(1, min(MAX_WORKERS, args.workers))     # ③ 硬夹到 ≤8
    src_root = Path(args.src).expanduser().resolve()
    out_root = Path(args.out).expanduser().resolve()
    report_path = Path(args.report).expanduser().resolve() if args.report else out_root / "report.json"

    if not src_root.is_dir():
        print(f"[FATAL] 源目录不存在：{src_root}", file=sys.stderr)
        return 2

    files = sorted(p for p in src_root.rglob("*") if p.is_file() and p.suffix.lower() in (".tiff", ".tif"))
    total = len(files)
    if args.limit > 0:
        files = files[: args.limit]
    if not files:
        print(f"[FATAL] 没有找到 TIFF：{src_root}", file=sys.stderr)
        return 2

    # 总量读数（输入侧体量，供报告）
    src_total_bytes = sum(p.stat().st_size for p in files)
    print(
        f"[start] src={src_root}\n"
        f"[start] out={out_root}\n"
        f"[start] files={len(files)}/{total} src_bytes={human_bytes(src_total_bytes)} "
        f"workers={workers} quality={args.quality} only={args.only}",
        flush=True,
    )

    t0 = time.time()
    done = generated = skipped = failed = 0
    disp_bytes = thumb_bytes = 0
    failures: list[dict] = []
    last_print = t0

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(process_one, p, out_root, args.quality, args.force, args.only): p for p in files
        }
        for fut in as_completed(futures):
            rec = fut.result()
            done += 1
            if rec.get("ok"):
                if rec.get("skipped"):
                    skipped += 1
                else:
                    generated += 1
                disp_bytes += int(rec.get("display_bytes") or 0)
                thumb_bytes += int(rec.get("thumb_bytes") or 0)
            else:
                failed += 1
                failures.append(rec)
                print(f"[FAIL] {rec.get('rel')}: {rec.get('error')}", flush=True)
            now = time.time()
            if done % PROGRESS_EVERY_N == 0 or (now - last_print) >= PROGRESS_EVERY_S or done == len(files):
                last_print = now
                elapsed = now - t0
                rate = done / elapsed if elapsed > 0 else 0.0
                eta = (len(files) - done) / rate if rate > 0 else 0.0
                print(
                    f"[progress] {done}/{len(files)} ({done * 100 // len(files)}%) "
                    f"生成={generated} 跳过={skipped} 失败={failed} "
                    f"耗时={elapsed:.0f}s 速率={rate:.1f}件/s ETA={eta:.0f}s "
                    f"产物 display={human_bytes(disp_bytes)} thumb={human_bytes(thumb_bytes)}",
                    flush=True,
                )

    elapsed = round(time.time() - t0, 3)
    report = {
        "ok": failed == 0,
        "src": str(src_root),
        "out": str(out_root),
        "params": {
            "display_long_edge": DISPLAY_LONG_EDGE,
            "thumb_long_edge": THUMB_LONG_EDGE,
            "webp_quality": args.quality,
            "webp_quality_note": "Pillow/libwebp 0–100 标度；规范字面 0.92 ⇒ 92（见脚本文件头 ★）",
            "webp_method": WEBP_METHOD,
            "workers": workers,
            "only": args.only,
            "force": bool(args.force),
        },
        "files_total": total,
        "files_processed": len(files),
        "src_bytes": src_total_bytes,
        "generated": generated,
        "skipped": skipped,
        "failed": failed,
        "display_bytes": disp_bytes,
        "thumb_bytes": thumb_bytes,
        "elapsed_s": elapsed,
        "failures": failures,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print("=" * 72)
    print(f"[done] 处理={len(files)} 生成={generated} 跳过={skipped} 失败={failed} 耗时={elapsed}s")
    print(f"[done] 展示件 display 合计 {human_bytes(disp_bytes)}｜缩略图 thumb 合计 {human_bytes(thumb_bytes)}")
    print(f"[done] 报告 {report_path}")
    if failures:
        print(f"[done] 失败清单（{len(failures)} 件）：")
        for rec in failures[:50]:
            print(f"    - {rec.get('rel')}: {rec.get('error')}")
        if len(failures) > 50:
            print(f"    … 另有 {len(failures) - 50} 件，见报告 failures")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
