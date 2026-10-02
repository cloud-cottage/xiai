#!/usr/bin/env python
"""xiai-api · P2 往返保真取证（**真跑**，不是设计稿）

用法（用服务自己的 venv 跑）：
    cd xiai/server && ./.venv/bin/python tools/roundtrip_probe.py \
        --base-url http://127.0.0.1:5191 \
        --out-dir ../qa-recheck/kong-P2-20260923/evidence

取证面（逐条对应规范判据）：
  ① 往返保真（AC-139 / AC-166）：构造测试位图（纯色块 / 灰阶梯度 / 饱和彩色块 / 边界 1px 线）
     → 存储件（TIFF ＋ Deflate / AVIF）→ 展示件（有损 WebP 0.92）→ 逐像素 / 抽样比对；
     TIFF ＋ Deflate **无损** ⇒ 期望逐像素相等（等值即证「保留原色、不丢通道、无色偏」）；
     WebP / AVIF **有损** ⇒ 登记差异口径（最大 / 均值 / 每通道均值 / PSNR），
     **不得据「有损 ⇒ 不逐像素相等」判负**（AC-166 反向误判封堵）。
  ② 容器口径（AC-127）：独立 IFD 解析（第二把尺子只作交叉核对）读 tag 256/257/258/259/262/
     273/277/279/284/338 ＋ zlib 解 strip ⇒ 验 `Compression = 8` / RGB 8-bit / chunky / 不透明省 Alpha。
  ③ 失败形态（AC-157 / AC-184）：空 / 垃圾 / 文本 / 伪 RIFF / 截断 TIFF / 非源面容器 / 超输入上限 /
     缺参 / 非法值 / 未知字段 / 产物超限 / 内部异常 —— 逐例给 HTTP 码 ＋ 结构化 `{ok:false,reason,message}`，
     并逐例检查：响应体内**无图片占位字节**、reason 落在**既有冻结字面值集合**内、message **无简体**。
  ④ 幂等（AC-167 / AC-185）：同源两次 ⇒ 产物指纹一致；换源 ⇒ 指纹变化（探针对照）。
  ⑤ mime 如实（AC-141 / AC-154 / AC-180 ④）：产物字节落盘，交**产品真值函数**判定（node 侧调用），
     与服务侧判定并列读数。
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

import httpx
from PIL import Image, ImageChops, ImageStat

REPO = Path(__file__).resolve().parents[2]          # xiai/
XIAI_SRC = REPO / "src"

FROZEN_REASONS = {
    "UNRECOGNIZED_IMAGE", "NOT_IMAGE", "EMPTY_CONTENT", "TOO_LARGE", "ARTIFACT_TOO_LARGE",
    "MISSING_REQUIRED", "INVALID_FIELD", "INVALID_VALUE", "STORAGE_UNAVAILABLE", "FORBIDDEN",
    "NOT_FOUND",
}


# ── 工具 ──────────────────────────────────────────────────────────────────────
def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def hex_head(b: bytes, n: int = 16) -> str:
    return b[:n].hex(" ")


def make_bitmap(side: int = 512) -> Image.Image:
    """四类测试内容各占一象限：纯色块 / 灰阶梯度 / 饱和彩色块 / 边界 1px 线（AC-166 ①）。"""
    img = Image.new("RGB", (side, side), (255, 255, 255))
    px = img.load()
    half = side // 2
    # 象限 A：纯色块（红）
    for y in range(0, half):
        for x in range(0, half):
            px[x, y] = (200, 30, 40)
    # 象限 B：灰阶梯度（0→255 横向）
    for y in range(0, half):
        for x in range(half, side):
            v = round(255 * (x - half) / max(1, half - 1))
            px[x, y] = (v, v, v)
    # 象限 C：饱和彩色块（4×4 网格；RGB 三通道各自扫动）
    cell = max(1, half // 4)
    for gy in range(4):
        for gx in range(4):
            colour = (round(255 * gx / 3), round(255 * gy / 3), 255 - round(255 * (gx + gy) / 6))
            for y in range(half + gy * cell, min(side, half + (gy + 1) * cell)):
                for x in range(0 + gx * cell, min(half, (gx + 1) * cell)):
                    px[x, y] = colour
    # 象限 D：边界 1px 线（黑白交替 1px 竖线 ＋ 1px 横线；检验重采样 / 通道对齐）
    for y in range(half, side):
        for x in range(half, side):
            on_line = ((x - half) % 2 == 0) or ((y - half) % 2 == 0)
            px[x, y] = (0, 0, 0) if on_line else (255, 255, 255)
    return img


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def compare(a: Image.Image, b: Image.Image) -> dict:
    """逐像素比对读数（含每通道均值 ⇒ 色偏检测）。"""
    if a.size != b.size:
        return {"size_differ": [list(a.size), list(b.size)]}
    ca, cb = a.convert("RGB"), b.convert("RGB")
    diff = ImageChops.difference(ca, cb)
    stat = ImageStat.Stat(diff)
    mean = stat.mean                       # 每通道均值
    extrema = diff.getextrema()            # 每通道最大
    mse = sum(m * m for m in mean) / 3.0
    return {
        "size": list(ca.size),
        "channels": {"a": len(ca.getbands()), "b": len(cb.getbands())},
        "max_abs_diff_per_channel": [int(e[1]) for e in extrema],
        "mean_abs_diff_per_channel": [round(m, 6) for m in mean],
        "bitmap_equal": diff.getbbox() is None,
        "psnr_db": None if mse == 0 else round(10 * math.log10((255.0 ** 2) / mse), 4),
    }


# ── TIFF 容器独立解析（交叉核对；第二把尺子的读数不作判定依据）─────────────────
def parse_tiff_ifd(data: bytes) -> dict:
    """独立最小 IFD 解析：只读容器事实，不做任何判定。"""
    if len(data) < 8:
        return {"error": "too_short"}
    order = data[0:2]
    if order not in (b"II", b"MM"):
        return {"error": "bad_order", "magic": order.hex(" ")}
    endian = "<" if order == b"II" else ">"
    magic = struct.unpack(endian + "H", data[2:4])[0]
    ifd_off = struct.unpack(endian + "I", data[4:8])[0]
    out = {"byte_order": order.decode(), "magic": magic, "first_ifd_offset": ifd_off, "tags": {}}
    if magic != 42 or ifd_off + 2 > len(data):
        out["error"] = "bad_magic_or_ifd"
        return out
    count = struct.unpack(endian + "H", data[ifd_off : ifd_off + 2])[0]
    out["entry_count"] = count
    sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8}
    for i in range(count):
        base = ifd_off + 2 + i * 12
        if base + 12 > len(data):
            out["error"] = "ifd_truncated"
            break
        tag, typ, cnt = struct.unpack(endian + "HHI", data[base : base + 8])
        if typ not in sizes:
            continue
        total = sizes[typ] * cnt
        raw = data[base + 8 : base + 8 + 4] if total <= 4 else data[
            struct.unpack(endian + "I", data[base + 8 : base + 12])[0] :
            struct.unpack(endian + "I", data[base + 8 : base + 12])[0] + total
        ]
        fmt = {1: "B", 3: "H", 4: "I"}.get(typ)
        if not fmt:
            continue
        vals = list(struct.unpack(endian + fmt * cnt, raw[: sizes[typ] * cnt])) if len(raw) >= sizes[typ] * cnt else None
        out["tags"][tag] = {"type": typ, "count": cnt, "values": vals[:8] if vals else None}
    return out


def tiff_strip_zlib_ok(data: bytes) -> dict:
    """按字节复核 Compression = 8（Deflate / zlib 流）自证：逐 strip 试解。"""
    info = parse_tiff_ifd(data)
    offs = (info.get("tags", {}).get(273) or {}).get("values") or []
    cnts = (info.get("tags", {}).get(279) or {}).get("values") or []
    results = []
    for off, cnt in zip(offs, cnts):
        try:
            raw = zlib.decompress(data[off : off + cnt])
            results.append({"offset": off, "byte_count": cnt, "zlib_ok": True, "raw_bytes": len(raw)})
        except Exception as exc:  # noqa: BLE001
            results.append({"offset": off, "byte_count": cnt, "zlib_ok": False, "error": str(exc)})
    return {"strips": results, "all_zlib_ok": bool(results) and all(r["zlib_ok"] for r in results)}


def product_truth_mime(paths: list[Path]) -> dict:
    """**产品真值函数**判定（node 侧只读调用；一把尺子 ＝ §1.3 第 9 / 10 条）。

    参数全部内联进脚本（不依赖 argv 位置），避免把读数取错支。
    """
    script = (
        "const im = await import(" + json.dumps(str(XIAI_SRC / "utils" / "image.js")) + ");"
        "const am = await import(" + json.dumps(str(XIAI_SRC / "data" / "assetmeta.js")) + ");"
        "const fs = await import('node:fs');"
        "const out = {};"
        "for (const p of " + json.dumps([str(p) for p in paths]) + ") {"
        "  const b = new Uint8Array(fs.readFileSync(p));"
        "  out[p] = { sniffBytesMime: im.sniffBytesMime(b), sniffMime: am.sniffMime(b), bytes: b.length };"
        "}"
        "console.log(JSON.stringify(out));"
    )
    res = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True, text=True, cwd=str(REPO), check=False,
    )
    if res.returncode != 0:
        return {"error": res.stderr.strip()[-400:]}
    return json.loads(res.stdout)


def s2t_readings(texts: list[str]) -> dict:
    """产品繁体检测器读数（`s2t = src/utils/traditional.js::toTraditionalText`）。"""
    script = (
        "const tr = await import(" + json.dumps(str(XIAI_SRC / "utils" / "traditional.js")) + ");"
        "const s2t = tr.toTraditionalText;"
        "const out = {};"
        "for (const t of " + json.dumps(texts) + ") out[t] = { s2t: s2t(t), identical: s2t(t) === t };"
        "console.log(JSON.stringify(out));"
    )
    res = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True, text=True, cwd=str(REPO), check=False,
    )
    if res.returncode != 0:
        return {"__error__": res.stderr.strip()[-400:]}
    return json.loads(res.stdout)


# ── 主流程 ────────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:5191")
    ap.add_argument("--out-dir", default=str(REPO / "qa-recheck" / "kong-P2-20260923" / "evidence"))
    ap.add_argument("--side", type=int, default=512)
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    base = args.base_url.rstrip("/")
    # 进程内只读引用服务实现（用于「产物侧上限」分支直调与「能否当图片解析」的魔数判断）
    sys.path.insert(0, str(REPO / "server"))
    from app import codec as codec_mod  # noqa: PLC0415
    ev: dict = {"base_url": base, "out_dir": str(out_dir), "sections": {}}
    lines: list[str] = []

    def say(line: str = "") -> None:
        lines.append(line)
        print(line, flush=True)

    say(f"== xiai-api P2 往返取证 == base={base}")

    # ── 0. 健康检查 ──
    with httpx.Client(timeout=60.0) as c:
        say_health = c.get(f"{base}/api/health")
        health = say_health.json()
        ev["sections"]["health"] = {"status": say_health.status_code, "body": health,
                                    "content_type": say_health.headers.get("content-type")}
        say(f"[0] health: {say_health.status_code} name={health.get('name')} quality={health.get('display', {}).get('quality')}")

        # ── 1. 往返保真（**逐支隔离**：单支失败不中断整轮；先记 HTTP 面读数再决定能否解析图片）──
        src_img = make_bitmap(args.side)
        src_png = png_bytes(src_img)
        (out_dir / "source_bitmap.png").write_bytes(src_png)
        say("")
        say(f"[1] 往返保真 · 源位图 {src_img.size} {len(src_png)} B sha256={sha256(src_png)[:16]}")

        def head_facts(b: bytes) -> dict:
            return {"bytes": len(b), "head16_hex": hex_head(b, 16), "sha256": sha256(b)}

        branches: dict = {}
        storages: dict = {}

        def do_branch(name: str, path: str, params: dict, payload: bytes, expect_mime: str):
            """单支一次调用：**先记状态码 / Content-Type / 前 16 字节 / 长度 / 耗时**，
            只有 Content-Type 是图片且魔数对得上才让上游去解析字节。"""
            t0 = time.time()
            try:
                r = c.post(f"{base}{path}", params=params or None, content=payload,
                           headers={"content-type": "application/octet-stream"})
                body = r.content
                ct = r.headers.get("content-type", "")
                server_sniff = codec_mod.sniff_mime(body)
                is_image_ct = ct.split(";")[0] in ("image/tiff", "image/avif", "image/webp")
                parsed = None if is_image_ct else _try_json(body)
                entry = {
                    "branch": name,
                    "request": {"method": "POST", "path": path, "params": params, "body_bytes": len(payload)},
                    "status": r.status_code, "content_type": ct,
                    "elapsed_ms": round((time.time() - t0) * 1000, 1),
                    "server_headers": {k.lower(): v for k, v in r.headers.items()
                                       if k.lower().startswith("x-xiai")},
                    "magic_by_server_sniffer": server_sniff,
                    "magic_matches_expected": server_sniff == expect_mime,
                    "verdict": "PASS" if (r.status_code == 200 and server_sniff == expect_mime) else "FAIL",
                    **head_facts(body),
                }
                if parsed is not None:
                    entry["structured_failure"] = parsed
                    entry["body_prefix300"] = body[:300].decode("utf-8", "replace")
                    entry["defect_candidate"] = True
                return entry, body
            except Exception as exc:  # noqa: BLE001 —— 传输层 / 探针异常 ⇒ 记 NOT TESTED，不中断整轮
                return ({"branch": name, "verdict": "NOT TESTED",
                         "error": f"{type(exc).__name__}: {exc}"}, b"")

        # 支路 1/4、2/4：源位图 ⇒ 存储件（TIFF ＋ Deflate / AVIF）
        for container, expect in (("tiff", codec_mod.TIFF_MIME), ("avif", codec_mod.AVIF_MIME)):
            entry, art = do_branch(f"encode_{container}", "/api/image/encode",
                                   {"container": container, "kind": "face"}, src_png, expect)
            branches[f"encode_{container}"] = entry
            if art:
                (out_dir / f"storage_{container}.bin").write_bytes(art)
                storages[container] = art
            say(f"    [支路 encode_{container}] status={entry.get('status')} ct={entry.get('content_type')}"
                f" bytes={entry.get('bytes')} magic={entry.get('magic_by_server_sniffer')!r}"
                f" 期望={expect!r} ⇒ {entry['verdict']}"
                + (f" · 结构化失败体={entry.get('structured_failure')}" if entry.get("structured_failure") else ""))

        # 支路 3/4、4/4：存储件 ⇒ 展示件（有损 WebP 0.92）
        for container in ("tiff", "avif"):
            art = storages.get(container, b"")
            if not art:
                branches[f"decode_{container}_to_webp"] = {
                    "branch": f"decode_{container}_to_webp", "verdict": "NOT TESTED",
                    "reason": f"上游 encode_{container} 未产出可解析的存储件"}
                say(f"    [支路 decode_{container}_to_webp] NOT TESTED（上游无产物）")
                continue
            entry, webp = do_branch(f"decode_{container}_to_webp", "/api/image/decode",
                                    {"kind": "face"}, art, codec_mod.WEBP_MIME)
            branches[f"decode_{container}_to_webp"] = entry
            if webp:
                (out_dir / f"display_{container}.webp").write_bytes(webp)
            # 像素面读数（仅在两侧都能解析时给；容器事实面读数独立于像素面）
            facts: dict = {}
            try:
                art_img = Image.open(io.BytesIO(art))
                art_img.load()
                facts["storage_mode"] = art_img.mode
                facts["storage_size"] = list(art_img.size)
                # 源 ⇒ 存储件：TIFF ＋ Deflate 无损 ⇒ 要求逐像素相等；AVIF 有损 ⇒ 如实给差异
                cmp_st = compare(src_img, art_img)
                facts["source_to_storage"] = cmp_st
                facts["pixel_identical"] = bool(cmp_st.get("bitmap_equal"))
                facts["lossless"] = entry["branch"] == "decode_tiff_to_webp" and facts["pixel_identical"]
                if container == "tiff":
                    facts["ifd"] = parse_tiff_ifd(art)
                    facts["zlib_check"] = tiff_strip_zlib_ok(art)
                if webp:
                    webp_img = Image.open(io.BytesIO(webp))
                    webp_img.load()
                    facts["display_mode"] = webp_img.mode
                    facts["source_to_display"] = compare(src_img, webp_img)
                    facts["storage_to_display"] = compare(art_img, webp_img)
            except Exception as exc:  # noqa: BLE001
                facts["pixel_face_error"] = f"{type(exc).__name__}: {exc}"
            branches[f"decode_{container}_to_webp"].update(facts)
            say(f"    [支路 decode_{container}_to_webp] status={entry.get('status')}"
                f" ct={entry.get('content_type')} bytes={entry.get('bytes')}"
                f" magic={entry.get('magic_by_server_sniffer')!r} ⇒ {entry['verdict']}")
            if "pixel_identical" in facts:
                say(f"        源→存储 pixel_identical={facts['pixel_identical']}"
                    f" maxΔ={facts['source_to_storage'].get('max_abs_diff_per_channel')}"
                    f" · 源→展示 maxΔ={facts.get('source_to_display', {}).get('max_abs_diff_per_channel')}"
                    f" 均值Δ={facts.get('source_to_display', {}).get('mean_abs_diff_per_channel')}"
                    f" PSNR={facts.get('source_to_display', {}).get('psnr_db')}")
        # 汇总
        counts = {"PASS": 0, "FAIL": 0, "NOT TESTED": 0}
        for b in branches.values():
            counts[b.get("verdict", "NOT TESTED")] = counts.get(b.get("verdict", "NOT TESTED"), 0) + 1
        ev["sections"]["roundtrip"] = {
            "source_bitmap": {"size": list(src_img.size), **head_facts(src_png)},
            "branches": branches,
            "summary": counts,
        }
        say(f"    汇总：PASS={counts['PASS']} FAIL={counts['FAIL']} NOT TESTED={counts['NOT TESTED']}")

        # ── 2. 幂等（AC-167 / AC-185）──
        say("")
        say("[2] 幂等（同源两次 ⇒ 指纹一致；换源 ⇒ 指纹变化）")
        idem: dict = {}
        other_png = png_bytes(make_bitmap(256))
        for container in ("tiff", "avif"):
            hashes, sizes = [], []
            for _ in range(2):
                r = c.post(f"{base}/api/image/encode", params={"container": container},
                           content=src_png, headers={"content-type": "application/octet-stream"})
                hashes.append(sha256(r.content))
                sizes.append(len(r.content))
            d_hashes = []
            art_bytes = (out_dir / f"storage_{container}.bin").read_bytes()
            for _ in range(2):
                r = c.post(f"{base}/api/image/decode", content=art_bytes,
                           headers={"content-type": "application/octet-stream"})
                d_hashes.append(sha256(r.content))
            other = c.post(f"{base}/api/image/encode", params={"container": container},
                           content=other_png, headers={"content-type": "application/octet-stream"})
            idem[container] = {
                "encode_hashes": hashes, "encode_bytes": sizes,
                "encode_idempotent": len(set(hashes)) == 1,
                "decode_hashes": d_hashes, "decode_idempotent": len(set(d_hashes)) == 1,
                "other_source_sha256": sha256(other.content),
                "probe_distinguishes": sha256(other.content) not in hashes,
            }
            say(f"    {container}: encode 两次一致={idem[container]['encode_idempotent']}"
                f" decode 两次一致={idem[container]['decode_idempotent']}"
                f" 换源可区分={idem[container]['probe_distinguishes']}")
        ev["sections"]["idempotency"] = idem

        # ── 3. 结构化失败 ──
        say("")
        say("[3] 失败形态（结构化 / 零伪数据 / 零回落直出）")
        good_tiff = (out_dir / "storage_tiff.bin").read_bytes()
        bomb = io.BytesIO()
        Image.new("RGB", (8, 8), (1, 2, 3)).save(bomb, format="PNG")
        cases: list[tuple[str, str, str, dict, bytes]] = [
            ("decode_empty", "POST", "/api/image/decode", {}, b""),
            ("decode_garbage12", "POST", "/api/image/decode", {}, bytes(range(12))),
            ("decode_text", "POST", "/api/image/decode", {}, "這不是圖片".encode()),
            ("decode_fake_riff_wave", "POST", "/api/image/decode", {},
             b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 24),
            ("decode_truncated_tiff", "POST", "/api/image/decode", {}, good_tiff[:24]),
            ("decode_png_not_source", "POST", "/api/image/decode", {}, src_png),
            ("decode_over_source_limit", "POST", "/api/image/decode", {}, good_tiff + b"\x00" * (5 * 1024 * 1024)),
            ("decode_unknown_field", "POST", "/api/image/decode", {"format": "webp"}, good_tiff),
            ("decode_bad_kind", "POST", "/api/image/decode", {"kind": "seal"}, good_tiff),
            ("encode_missing_container", "POST", "/api/image/encode", {}, src_png),
            ("encode_bad_container", "POST", "/api/image/encode", {"container": "webp"}, src_png),
            ("encode_unknown_field", "POST", "/api/image/encode", {"container": "tiff", "out": "x"}, src_png),
            ("encode_bad_quality", "POST", "/api/image/encode", {"container": "avif", "quality": "7"}, src_png),
            ("encode_bomb_png", "POST", "/api/image/encode", {"container": "tiff"}, _bomb_png()),
            ("get_unknown_path", "GET", "/api/nope", {}, b""),
            ("post_on_health", "POST", "/api/health", {}, b""),
        ]
        failures: dict = {}
        for name, method, path, params, payload in cases:
            r = c.request(method, f"{base}{path}", params=params, content=payload,
                          headers={"content-type": "application/octet-stream"})
            body = r.content
            try:
                parsed = r.json()
            except Exception:  # noqa: BLE001
                parsed = None
            ct = r.headers.get("content-type", "")
            structured = isinstance(parsed, dict) and parsed.get("ok") is False and bool(parsed.get("reason"))
            reason_ok = structured and parsed["reason"] in FROZEN_REASONS
            message = (parsed or {}).get("message", "")
            leaked = [tok for tok in ("/api/", "image/tiff", "image/webp", "Compression", "IFD", "iff", "5191")
                      if tok in message]
            entry = {
                "method": method, "path": path, "params": params,
                "status": r.status_code, "content_type": ct,
                "body_prefix": body[:160].decode("utf-8", "replace"),
                "body_bytes": len(body), "json": parsed,
                "structured": structured, "reason_in_frozen_set": reason_ok,
                "placeholder_image_bytes": r.headers.get("content-type", "").startswith("image/"),
                "message_leaks_internal_identifier": leaked,
            }
            failures[name] = entry
            say(f"    {name}: {r.status_code} {ct.split(';')[0]} reason={(parsed or {}).get('reason')}"
                f" 结构化={structured} 冻结={reason_ok} 占位字节={entry['placeholder_image_bytes']}")
        ev["sections"]["failures"] = failures

        # ── 4. 产物侧上限：有界降质重编记录 ＋ 压不进才拒 ──
        say("")
        say("[4] 产物侧上限（J-9：先有界降质重编，压不进才拒；与输入侧 TOO_LARGE 两套）")
        reencode: dict = {}
        # 4a 触发一轮降采样后成功：1400² 噪声 ⇒ TIFF ＋ Deflate ≈ 4.68 MB > 4 MiB（输入仍 ≤ 1 MB）
        noise = Image.effect_noise((1400, 1400), 100).convert("L")
        nj = jpeg_within_limit(noise)
        (out_dir / "noise_input.jpg").write_bytes(nj)
        r = c.post(f"{base}/api/image/encode", params={"container": "tiff", "kind": "face"},
                   content=nj, headers={"content-type": "application/octet-stream"})
        reencode["degrade_retry"] = {
            "input_bytes": len(nj), "status": r.status_code,
            "headers": {k: v for k, v in r.headers.items() if k.lower().startswith("x-xiai")},
            "out_bytes": len(r.content) if r.status_code == 200 else None,
            "sha256": sha256(r.content) if r.status_code == 200 else None,
            "json": None if r.status_code == 200 else _try_json(r.content),
        }
        if r.status_code == 200:
            (out_dir / "noise_downscaled.bin").write_bytes(r.content)
        say(f"    4a 降质重编：输入 {len(nj)} B ⇒ {r.status_code} "
            f"rounds={r.headers.get('x-xiai-reencode-rounds')} "
            f"size={r.headers.get('x-xiai-source-size')}→{r.headers.get('x-xiai-out-size')} "
            f"out={len(r.content)} B")

        # 4b 输入侧闸先行：同一支路喂 > 1 MB 的样本 ⇒ 必须是 TOO_LARGE（**不得**与 ARTIFACT_TOO_LARGE 混用）
        bjb = jpeg_within_limit(Image.effect_noise((2600, 2600), 100).convert("L"), limit=1 << 30)
        r2 = c.post(f"{base}/api/image/encode", params={"container": "tiff"},
                    content=bjb, headers={"content-type": "application/octet-stream"})
        reencode["overflow_attempt_http"] = {
            "input_bytes": len(bjb), "status": r2.status_code,
            "json": _try_json(r2.content),
            "headers": {k: v for k, v in r2.headers.items() if k.lower().startswith("x-xiai")},
            "expectation": "输入侧 > 1 MB ⇒ TOO_LARGE（输入侧字面值；不得出现 ARTIFACT_TOO_LARGE）",
        }
        say(f"    4b 输入侧闸（HTTP）：输入 {len(bjb)} B ⇒ {r2.status_code} {_try_json(r2.content)}")
        # 解析式：3 轮 ÷2 ⇒ 最长边 ÷8 ⇒ 原始体量 ÷64；要在第 3 轮后仍 > 4 MiB
        # 需 W0·H0·3 > 4 MiB × 64 ⇒ W0 = H0 > √(4 MiB×64/3) ≈ 9,460 px，而该尺寸的
        # 噪声类样本无法压进输入侧 1 MB ⇒ **HTTP 面 ARTIFACT_TOO_LARGE 实测不可达**（如实登记）。
        reencode["reachability_note"] = {
            "formula": "artifact_bytes(TIFF,RGB) = W*H*3 (Deflate 对噪声近不可压)；3 轮后 W=W0/8",
            "threshold_px": math.ceil(math.sqrt(4 * 1024 * 1024 * 64 / 3)),
            "input_limit_bytes": 1_048_576,
            "verdict": "HTTP 面不可达（输入闸 1 MB ＋ 有界重编联立）——见 4c 进程内直调取证",
        }

        # 4c 进程内直调：**把产物上限常量临时压小**（只在探针进程内改内存，不动产品数值）
        #     ⇒ 用有界样本覆盖「有界重编用满仍压不进 ⇒ ARTIFACT_TOO_LARGE」分支
        say("    4c 进程内直调 codec.encode_storage（把产物上限临时压到 8 KiB）⇒ 覆盖 ARTIFACT_TOO_LARGE")
        from app.errors import ARTIFACT_TOO_LARGE as _ATL  # noqa: PLC0415
        stub = png_bytes(Image.effect_noise((1024, 1024), 100).convert("RGB"))
        saved_limit = codec_mod.STORED_MAX_BYTES
        codec_mod.STORED_MAX_BYTES = 8192
        try:
            codec_mod.encode_storage(stub, "tiff")
            inproc = {"raised": False}
        except codec_mod.XiaiError as exc:  # type: ignore[attr-defined]
            inproc = {"raised": True, "reason": exc.reason, "status": exc.status,
                      "message": exc.message, "reason_is_frozen": exc.reason == _ATL}
        finally:
            codec_mod.STORED_MAX_BYTES = saved_limit
        inproc["input_png_bytes"] = len(stub)
        inproc["stored_max_bytes_restored"] = codec_mod.STORED_MAX_BYTES
        reencode["artifact_guard_direct_call"] = inproc
        say(f"      直调读数：raised={inproc.get('raised')} reason={inproc.get('reason')} "
            f"status={inproc.get('status')} 冻结值={inproc.get('reason_is_frozen')} "
            f"（上限已复原={inproc.get('stored_max_bytes_restored')}）")
        ev["sections"]["artifact_limit"] = reencode

        # ── 5. mime 如实（产品真值函数并列读数）──
        say("")
        say("[5] mime 如实：产物字节 × 产品真值函数（node 侧只读调用）")
        paths = sorted(out_dir.glob("*.bin")) + sorted(out_dir.glob("*.webp")) + [
            out_dir / "source_bitmap.png", out_dir / "noise_input.jpg"]
        truth = product_truth_mime([p for p in paths if p.exists()])
        br = ev["sections"]["roundtrip"]["branches"]
        mime_section = {
            "product_truth_functions": truth,
            "server_headers": {
                "encode_tiff_out": br.get("encode_tiff", {}).get("server_headers", {}).get("x-xiai-out-mime"),
                "encode_avif_out": br.get("encode_avif", {}).get("server_headers", {}).get("x-xiai-out-mime"),
                "decode_tiff_to_webp_out": br.get("decode_tiff_to_webp", {}).get("server_headers", {}).get("x-xiai-out-mime"),
                "decode_avif_to_webp_out": br.get("decode_avif_to_webp", {}).get("server_headers", {}).get("x-xiai-out-mime"),
            },
            "agreement": {
                "storage_tiff.bin": {"server": "image/tiff",
                                     "product": (truth.get(str(out_dir / "storage_tiff.bin")) or {}).get("sniffBytesMime")},
                "storage_avif.bin": {"server": "image/avif",
                                     "product": (truth.get(str(out_dir / "storage_avif.bin")) or {}).get("sniffBytesMime")},
                "display_tiff.webp": {"server": "image/webp",
                                      "product": (truth.get(str(out_dir / "display_tiff.webp")) or {}).get("sniffBytesMime")},
                "source_bitmap.png": {"server": "image/png",
                                      "product": (truth.get(str(out_dir / "source_bitmap.png")) or {}).get("sniffBytesMime")},
                "product_truth_functions_recognise_tiff":
                    (truth.get(str(out_dir / "storage_tiff.bin")) or {}).get("sniffBytesMime", ""),
            },
        }
        for p in paths:
            if p.exists() and str(p) in truth:
                say(f"    {p.name}: sniffBytesMime={truth[str(p)]['sniffBytesMime']!r} "
                    f"sniffMime={truth[str(p)]['sniffMime']!r}")
        ev["sections"]["mime"] = mime_section

        # ── 6. message 繁体读数（产品检测器）──
        say("")
        say("[6] 失败 message 繁体读数（s2t(x) === x）")
        messages = sorted({(v["json"] or {}).get("message", "") for v in failures.values()} - {""})
        s2t = s2t_readings(messages)
        ev["sections"]["message_s2t"] = s2t
        if "__error__" in s2t:
            say(f"    ★ 检测器调用失败（读数无效）：{s2t['__error__']}")
        else:
            for m, rd in s2t.items():
                say(f"    identical={rd.get('identical')} · {m}")

        # ── 7. 零副作用读数（读路径不回写；服务自己不写任何盘）──
        say("")
        say("[7] 零副作用：服务目录下无新增文件 / 无缓存目录")
        server_dir = REPO / "server"
        listing = sorted(p.name for p in server_dir.iterdir())
        ev["sections"]["side_effects"] = {"server_dir_listing": listing,
                                          "note": "服务不写任何文件；证据文件全部由本探针写"}
        say(f"    server/: {listing}")

    # 落盘
    (out_dir / "evidence.json").write_text(json.dumps(ev, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "probe-run.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    say("")
    say(f"== 取证完成 ⇒ {out_dir/'evidence.json'} / probe-run.txt ==")
    return 0


def _try_json(b: bytes):
    try:
        return json.loads(b)
    except Exception:  # noqa: BLE001
        return b[:160].decode("utf-8", "replace")


def jpeg_within_limit(img: Image.Image, limit: int = 1_048_576) -> bytes:
    """把位图压成 **输入侧上限内** 的 JPEG（逐档降质；用于触发产物侧上限的样本）。"""
    for q in (95, 90, 85, 80, 70, 60, 50, 40, 30):
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=q)
        if len(buf.getvalue()) <= limit:
            return buf.getvalue()
    return buf.getvalue()


def _bomb_png() -> bytes:
    """声明尺寸极大的 PNG（解压炸弹）⇒ 触发 Pillow 的 bomb 保护 ⇒ 走全局兜底（结构化 500）。"""
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", 60000, 60000, 8, 2, 0, 0, 0)
    chunks = sig + _png_chunk("IHDR", ihdr_data) + _png_chunk("IDAT", zlib.compress(b"\x00" * 64)) \
        + _png_chunk("IEND", b"")
    return chunks


def _png_chunk(tag: str, data: bytes) -> bytes:
    tag_bytes = tag.encode() if isinstance(tag, str) else tag
    return struct.pack(">I", len(data)) + tag_bytes + data + struct.pack(
        ">I", zlib.crc32(tag_bytes + data) & 0xFFFFFFFF)


if __name__ == "__main__":
    sys.exit(main())
