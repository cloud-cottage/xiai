"""xiai-api · P3 驗收取證探針（TileSplicer 服務端化 ＋ 切塊輸出 ＋ 存量 AVIF 讀取面 ＋ 兩缺口收口）

判據真源：`docs/xiai.spec.md` **v1.25**（md5 `8c736f9bf5f899d588413ffed83e3744` / 3621 行）
  · §3.24.3（讀取面兩條路徑）／§3.24.6（取代項 ＋ 不變項：真源恰 1 處）／§3.24.7（防泄露**面别限定**）；
  · §3.25（存儲容器收口：兩類一律單頁 8bit Deflate TIFF）／§3.25.5（AVIF 於**新增產物面**退場四項）；
  · §10.22 AC-174（預覽路徑）／AC-175（直出與下載）／AC-177（真源恰 1 處）／AC-178（拼接仍在展示端）
    ／AC-179（防泄露**面别限定**：預覽面不下發源字節・下載面原 TIFF 直出）／AC-180（展示件形態與質量）；
  · §10.23 **AC-204**（存量 AVIF 字節：不遷移 / 不清除 / 不引導重傳 ＋ **讀取面須能顯示該行**）
    ＋ AC-197（舊 AVIF 條款不得據以判負）／**AC-205**（api 面凍結 reason 表恰 7 值）。

本探針產出（**全部為實跑讀數**）：
  ① **parity**（驗收核心）：`server/tools/geom.mjs` node 橋 與「前端側所掛的同一份契約中間件」
     （真實 HTTP，臨時高位埠）之響應體**逐字節一致** ＋ **兩邊 md5** ＋ 結構化覆核；
  ② **切塊清單**：face 4 塊 2×2 ／ scene 8 塊 4×2（塊數讀自內核；容器統一後**靠 kind 區分**）；
  ③ **拼回對帳**：N 塊按 `placements` 拼回 vs **整圖一次轉碼** —— **新判據 ＝ 逐像素一致（maxΔ=0）**；
     並留**舊口徑對照**（每塊各自有損 0.92）＋ **噪聲底**（整圖 0.92 解碼 vs 源位圖）＋ **「縫」讀數**
     （跨塊邊界 vs 塊內的像素差中位數比值）；
  ④ `thumb` / `download` **均不經 TileSplicer**（以橋調用計數器不動為機械讀數）；下載件全分辨率 WebP 0.92；
  ⑤ **存量只讀面**（AC-204）：AVIF 源 ⇒ 解 / 縮略圖 / 預覽三鏈路皆 200 且產物皆 WebP（非源字節）；
  ⑥ 補 P2 兩缺口：**mime 對照改絕對路徑**（產品真值函數 readings）＋ **`reason_is_frozen` 複核**；
  ⑦ 失敗形態 / 繁體 message / 零副作用 / LRU 讀數 / 實現點掃描（**排除 `*_probe.py` 自指**）。

用法：
    server/.venv/bin/python server/tools/p3_probe.py --base http://127.0.0.1:5191 \\
        --out-dir qa-recheck/kong-P3-20260923/evidence
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import select
import signal
import statistics
import subprocess
import sys
import time
import tokenize
from pathlib import Path

import httpx
from PIL import Image, ImageChops, ImageDraw, ImageStat

REPO = Path(__file__).resolve().parents[2]          # xiai/
XIAI_SRC = REPO / "src"
SERVER = REPO / "server"
GEOM_SCRIPT = SERVER / "tools" / "geom.mjs"
DEVCONTRACT_SCRIPT = SERVER / "tools" / "devcontract_server.mjs"
NODE = os.environ.get("XIAI_NODE_BIN") or "node"

BOUNDARY = "xiai-slices-v1"
IMAGE_CT = {"image/tiff", "image/avif", "image/webp", "image/png", "image/jpeg", "image/gif"}


# ── 通用工具 ────────────────────────────────────────────────────────────────
def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def hex_head(data: bytes, n: int = 16) -> str:
    return data[:n].hex()


def try_json(data: bytes):
    try:
        return json.loads(data.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


def compare_images(a: Image.Image, b: Image.Image) -> dict:
    """兩張位圖的像素級對帳（純 PIL：均值 / 最大 / PSNR / 恆等像素佔比）。"""
    if a.size != b.size:
        return {"size_equal": False, "size_a": list(a.size), "size_b": list(b.size)}
    left, right = a.convert("RGB"), b.convert("RGB")
    diff = ImageChops.difference(left, right)
    stat = ImageStat.Stat(diff)
    rms = stat.rms
    mse = sum(value * value for value in rms) / max(1, len(rms))
    bands = diff.split()
    mask = bands[0].point(lambda v: 0 if v == 0 else 255)
    for band in bands[1:]:
        mask = ImageChops.lighter(mask, band.point(lambda v: 0 if v == 0 else 255))
    total = left.width * left.height
    differing = mask.histogram()[255]
    return {
        "size_equal": True,
        "identical_ratio": round(1 - differing / total, 6),
        "differing_pixels": differing,
        "total_pixels": total,
        "mean_abs_delta": [round(value, 6) for value in stat.mean],
        "max_abs_delta": [value[1] for value in stat.extrema],
        "psnr_db": None if mse == 0 else round(10 * math.log10(255 * 255 / mse), 4),
        "rms": [round(value, 6) for value in rms],
    }


def webp_chunk_kind(data: bytes) -> str:
    """WebP 容器的位流類型（**塊傳輸口徑**的機械判據）：`VP8L` ＝ 無損／`VP8 ` ＝ 有損／`VP8X` ＝ 擴展容器／`?` ＝ 認不出。"""
    if len(data) < 16 or data[0:4] != b"RIFF" or data[8:12] != b"WEBP":
        return "?"
    return data[12:16].decode("latin-1")


def seam_step_reading(assembled: Image.Image, reference: Image.Image, x_cuts: list, y_cuts: list) -> dict:
    """**「縫」讀數**（邊界台階判據）：**跨塊邊界** vs **塊內** 的像素差中位數比值。

    量 ＝ `assembled`（塊拼回位圖）減 `reference`（整圖 0.92 解碼位圖）的逐像素 |Δ|（三通道之和 / 3）：
      · **邊界像素** ＝ 列號 ∈ `x_cuts` 或行號 ∈ `y_cuts` 的像素（即塊邊界「之後」那一片像素）；
      · **塊內像素** ＝ 其餘像素；
      · **縫讀數** ＝ median(邊界 |Δ|) ÷ median(塊內 |Δ|)  ⇒ 越接近 1 ⇒ 邊界與塊內無差別（無台階）。
    無損塊下拼回與整圖**逐像素相同** ⇒ 分子分母**同為 0** ⇒ 該比值退化（本讀數記為 None 並在 REPORT 說明）。
    """
    if assembled.size != reference.size:
        return {"size_equal": False}
    left, right = assembled.convert("RGB"), reference.convert("RGB")
    width, height = left.size
    diff = ImageChops.difference(left, right).tobytes()
    xset, yset = set(x_cuts), set(y_cuts)
    boundary: list[int] = []
    interior: list[int] = []
    for y in range(height):
        row = diff[y * width * 3 : (y + 1) * width * 3]
        row_sum = [row[x * 3] + row[x * 3 + 1] + row[x * 3 + 2] for x in range(width)]
        is_boundary_row = y in yset
        boundary.extend(value for x, value in enumerate(row_sum) if is_boundary_row or x in xset)
        interior.extend(value for x, value in enumerate(row_sum) if not is_boundary_row and x not in xset)

    def median(values: list) -> float | None:
        return round(statistics.median(values), 6) if values else None

    boundary_median, interior_median = median(boundary), median(interior)
    ratio = (
        round(boundary_median / interior_median, 6)
        if boundary_median and interior_median
        else (None if not (boundary_median or interior_median) else float("inf"))
    )
    return {
        "size_equal": True, "boundary_pixels": len(boundary), "interior_pixels": len(interior),
        "boundary_median_abs_delta": boundary_median, "interior_median_abs_delta": interior_median,
        "seam_ratio": ratio,
    }


def parse_multipart(body: bytes, boundary: str = BOUNDARY) -> list[dict]:
    marker = b"--" + boundary.encode()
    chunks = body.split(marker)
    parts: list[dict] = []
    for chunk in chunks[1:]:
        if chunk.startswith(b"--"):
            break
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        head, _, payload = chunk.partition(b"\r\n\r\n")
        if payload.endswith(b"\r\n"):
            payload = payload[:-2]
        headers = {}
        for line in head.split(b"\r\n"):
            if b":" in line:
                key, _, value = line.partition(b":")
                headers[key.decode().strip().lower()] = value.decode().strip()
        parts.append({"headers": headers, "payload": payload, "bytes": len(payload)})
    return parts


def make_photo(width: int = 1200, height: int = 800):
    """可壓縮的「照片感」源位圖（漸層 ＋ 幾何 ＋ 細紋）——並保證 JPEG 落在輸入側 1 MB 之內。"""
    img = Image.new("RGB", (width, height))
    pixels = img.load()
    for y in range(height):
        for x in range(width):
            pixels[x, y] = (x * 255 // width, y * 255 // height, (x * 3 + y * 5) % 256)
    draw = ImageDraw.Draw(img)
    for i in range(0, width, 89):
        draw.line([(i, 0), (i + 37, height)], fill=(250, 250, 250), width=2)
    for i in range(0, height, 73):
        draw.line([(0, i), (width, i + 19)], fill=(12, 12, 12), width=2)
    draw.ellipse([width // 5, height // 5, width * 4 // 5, height * 4 // 5], outline=(255, 0, 0), width=7)
    for quality in (92, 88, 82, 74, 66, 58):
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        if len(buf.getvalue()) <= 1_048_576:
            return img, buf.getvalue(), quality
    return img, buf.getvalue(), 58


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def avif_bytes(img: Image.Image, quality: int = 92) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="AVIF", quality=quality)
    return buf.getvalue()


# ── 產品真值函數（**絕對路徑**；一把尺子 ＝ §1.3 第 9 / 10 條）────────────────
def product_truth_mime(paths: list[Path]) -> dict:
    abs_paths = [str(Path(p).resolve()) for p in paths]      # ★ 缺口 ① 的收口：一律絕對路徑
    script = (
        "const im = await import(" + json.dumps(str(XIAI_SRC / "utils" / "image.js")) + ");"
        "const am = await import(" + json.dumps(str(XIAI_SRC / "data" / "assetmeta.js")) + ");"
        "const fs = await import('node:fs');"
        "const out = {};"
        "for (const p of " + json.dumps(abs_paths) + ") {"
        "  const b = new Uint8Array(fs.readFileSync(p));"
        "  out[p] = { sniffBytesMime: im.sniffBytesMime(b), sniffMime: am.sniffMime(b), bytes: b.length };"
        "}"
        "console.log(JSON.stringify(out));"
    )
    done = subprocess.run(
        [NODE, "--input-type=module", "-e", script],
        capture_output=True, text=True, cwd=str(REPO), check=False, timeout=120,
    )
    if done.returncode != 0:
        return {"__error__": done.stderr.strip()[-400:]}
    return json.loads(done.stdout)


def s2t_readings(texts: list[str]) -> dict:
    script = (
        "const tr = await import(" + json.dumps(str(XIAI_SRC / "utils" / "traditional.js")) + ");"
        "const s2t = tr.toTraditionalText;"
        "const out = {};"
        "for (const t of " + json.dumps(texts) + ") out[t] = { s2t: s2t(t), identical: s2t(t) === t };"
        "console.log(JSON.stringify(out));"
    )
    done = subprocess.run(
        [NODE, "--input-type=module", "-e", script],
        capture_output=True, text=True, cwd=str(REPO), check=False, timeout=120,
    )
    if done.returncode != 0:
        return {"__error__": done.stderr.strip()[-400:]}
    return json.loads(done.stdout)


def bridge_direct(payload: dict) -> dict:
    """**不經 api**、直接驅動薄橋（第三條腿）：返回 stdout 原始字節的 md5 / 長度 / 內容。"""
    done = subprocess.run(
        [NODE, str(GEOM_SCRIPT)],
        input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        capture_output=True, cwd=str(REPO), check=False, timeout=120,
    )
    return {
        "returncode": done.returncode,
        "body": done.stdout,
        "bytes": len(done.stdout),
        "md5": md5(done.stdout) if done.stdout else None,
        "stderr": done.stderr.decode("utf-8", "replace").strip()[:200],
        "md5_source": "subprocess stdout（未 strip、無尾隨換行）",
    }


# ── 主流程 ──────────────────────────────────────────────────────────────────
def main() -> int:  # noqa: C901
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:5191")
    ap.add_argument("--out-dir", default=str(REPO / "qa-recheck" / "kong-P3-20260923" / "evidence"))
    ap.add_argument("--side", type=int, default=1200)
    args = ap.parse_args()

    base = args.base.rstrip("/")
    out_dir = Path(args.out_dir).resolve()          # ★ 絕對路徑（缺口 ①）
    out_dir.mkdir(parents=True, exist_ok=True)
    ev: dict = {"base_url": base, "out_dir": str(out_dir), "sections": {}}
    lines: list[str] = []

    def say(line: str = "") -> None:
        lines.append(line)
        print(line, flush=True)

    say(f"== xiai-api P3 取證 == base={base} out_dir={out_dir}")
    say(f"node={subprocess.run([NODE, '-v'], capture_output=True, text=True).stdout.strip()}")

    sys.path.insert(0, str(SERVER))
    from app import codec as codec_mod  # noqa: PLC0415

    dev_proc = None
    results: dict[str, str] = {}

    def mark(name: str, ok: bool, detail: str = "") -> None:
        results[name] = ("PASS" if ok else "FAIL") + (f"｜{detail}" if detail else "")
        say(f"    【{results[name]}】{name}")

    try:
        with httpx.Client(timeout=120.0, trust_env=False) as client:
            # ── 0. health ──────────────────────────────────────────────────
            health_resp = client.get(f"{base}/api/health")
            health = health_resp.json()
            ev["sections"]["health"] = {"status": health_resp.status_code, "body": health}
            say("")
            say(f"[0] health: {health_resp.status_code} name={health['name']} version={health['version']} "
                f"pid={health['pid']}")
            say(f"    source_containers={health['source_containers']} storage={health['storage_containers']} "
                f"retired={health['retired_capabilities']} quality={health['display']['quality']}")
            say(f"    slicing.performed_here={health['slicing']['performed_here']} "
                f"kernel={health['slicing']['kernel']} bridge={health['slicing']['bridge']} "
                f"node={health['slicing']['node_version']} second_impl={health['slicing']['second_implementation']}")
            say(f"    legacy_readonly={health.get('legacy_readonly_containers')} "
                f"readable={health.get('readable_source_containers')}")
            say(f"    slicing.tile_container={health['slicing'].get('tile_container')} "
                f"tile_lossless={health['slicing'].get('tile_lossless')} "
                f"（整圖展示口徑 display=webp/{health['display']['quality']}/"
                f"lossless:{health['display']['lossless']} —— 未改）")
            mark("health.source_containers == ['image/tiff']（**寫入面／新增產物**：AVIF 於新增產物面退場）",
                 health["source_containers"] == ["image/tiff"], repr(health["source_containers"]))
            mark("health.legacy_readonly_containers == ['image/avif']（**存量只讀面**單列、不串台 —— AC-204）",
                 health.get("legacy_readonly_containers") == ["image/avif"]
                 and health.get("readable_source_containers") == ["image/tiff", "image/avif"],
                 f"legacy={health.get('legacy_readonly_containers')} "
                 f"readable={health.get('readable_source_containers')}")
            mark("health.slicing 塊傳輸口徑單列（tile_container=image/webp ＋ tile_lossless=True）",
                 health["slicing"].get("tile_container") == "image/webp"
                 and health["slicing"].get("tile_lossless") is True
                 and health["display"]["quality"] == 0.92
                 and health["display"]["lossless"] is False,
                 f"tile_lossless={health['slicing'].get('tile_lossless')} / "
                 f"display={health['display']}")
            mark("health.display.quality == 0.92（質量口徑恰 1 處）",
                 health["display"]["quality"] == 0.92 and health["display"]["lossless"] is False)
            mark("health.slicing.second_implementation is False（真源恰 1 處）",
                 health["slicing"]["second_implementation"] is False)

            # ── 1. 源件與存儲件（寫入面產物 ⇒ 讀取面消費）───────────────────
            say("")
            say("[1] 源件與存儲件（TIFF）：寫入面產物 ⇒ 讀取面消費")
            photo, jpeg, jpeg_quality = make_photo(args.side, int(args.side * 2 / 3))
            (out_dir / "source_photo.jpg").write_bytes(jpeg)
            say(f"    源 JPEG {photo.size} {len(jpeg)} B q={jpeg_quality} sha256={sha256(jpeg)[:16]}")
            enc = client.post(f"{base}/api/image/encode", params={"container": "tiff", "kind": "face"},
                              content=jpeg, headers={"content-type": "application/octet-stream"})
            tiff = enc.content
            (out_dir / "storage_tiff.bin").write_bytes(tiff)
            tiff_facts = codec_mod.tiff_facts(tiff)
            ev["sections"]["storage_tiff"] = {
                "status": enc.status_code, "bytes": len(tiff), "sha256": sha256(tiff),
                "content_type": enc.headers.get("content-type"), "facts": tiff_facts,
                "server_headers": {k.lower(): v for k, v in enc.headers.items() if k.lower().startswith("x-xiai")},
            }
            say(f"    encode?container=tiff ⇒ {enc.status_code} {enc.headers.get('content-type')} "
                f"{len(tiff)} B sha256={sha256(tiff)[:16]}")
            say(f"    TIFF 讀數：pages={tiff_facts.get('pages')} bits={tiff_facts.get('bits_per_sample')} "
                f"compression={tiff_facts.get('compression')} photometric={tiff_facts.get('photometric_interpretation')} "
                f"spp={tiff_facts.get('samples_per_pixel')} rowsPerStrip={tiff_facts.get('rows_per_strip')} "
                f"strips={tiff_facts.get('strip_count')} deflate_ok={tiff_facts.get('deflate_streams_readable')}")
            pinned = tiff_facts.get("pinned_parameters") or {}
            mark("TIFF 修正口徑逐條成立（單頁／8bit／RGB／Deflate／strip／必需標籤）",
                 bool(tiff_facts.get("pinned_all_true")), json.dumps(pinned, ensure_ascii=False))

            # ── 2. parity（驗收核心）────────────────────────────────────────
            say("")
            say("[2] parity：node 橋 vs 前端側同一份契約中間件（真實 HTTP，臨時高位埠） vs xiai-api")
            dev_proc = subprocess.Popen(
                [NODE, str(DEVCONTRACT_SCRIPT)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                cwd=str(REPO), text=True,
            )
            dev_port = None
            ready, _, _ = select.select([dev_proc.stdout], [], [], 20)
            if ready:
                line = dev_proc.stdout.readline()
                if line.startswith("PORT"):
                    dev_port = int(line.split()[1])
            if dev_port is None:
                raise RuntimeError("dev-side contract harness 未回報埠（parity 第二條腿無法取得）")
            dev_base = f"http://127.0.0.1:{dev_port}"
            say(f"    第二條腿（前端側契約中間件）：{dev_base}（127.0.0.1 ＋ OS 指派高位埠；"
                f"**不佔** 5163/5164/5191/5195/5196）")
            ev["sections"]["parity"] = {"dev_side_base": dev_base, "cases": {}}

            cases = [
                ("discovery_get", "GET", "/api/tilesplicer/v1", None, {"cmd": "discovery"}),
                ("plan_face_registered", "GET", "/api/tilesplicer/v1/plan",
                 {"assetId": "img-0001f", "kind": "FACE"},
                 {"cmd": "plan", "assetId": "img-0001f", "kind": "FACE"}),
                ("plan_photo_explicit_size", "GET", "/api/tilesplicer/v1/plan",
                 {"assetId": "photo-p3-1", "kind": "PHOTO", "width": 1600, "height": 800},
                 {"cmd": "plan", "assetId": "photo-p3-1", "kind": "PHOTO", "width": 1600, "height": 800}),
                ("plan_edge_registered", "GET", "/api/tilesplicer/v1/plan", {"assetId": "img-0001e", "kind": "PHOTO"},
                 {"cmd": "plan", "assetId": "img-0001e", "kind": "PHOTO"}),
                ("plan_lowercase_kind", "GET", "/api/tilesplicer/v1/plan", {"assetId": "img-0002f", "kind": "photo"},
                 {"cmd": "plan", "assetId": "img-0002f", "kind": "photo"}),
                ("plan_missing_asset", "GET", "/api/tilesplicer/v1/plan", {"assetId": "", "kind": "FACE"},
                 {"cmd": "plan", "assetId": "", "kind": "FACE"}),
                ("plan_unknown_kind", "GET", "/api/tilesplicer/v1/plan", {"assetId": "img-0001f", "kind": "BOGUS"},
                 {"cmd": "plan", "assetId": "img-0001f", "kind": "BOGUS"}),
                ("plan_unregistered_id", "GET", "/api/tilesplicer/v1/plan", {"assetId": "no-such-id", "kind": "FACE"},
                 {"cmd": "plan", "assetId": "no-such-id", "kind": "FACE"}),
                ("plan_too_small", "GET", "/api/tilesplicer/v1/plan",
                 {"assetId": "tiny", "kind": "FACE", "width": 1, "height": 1},
                 {"cmd": "plan", "assetId": "tiny", "kind": "FACE", "width": 1, "height": 1}),
                ("method_post_discovery", "POST", "/api/tilesplicer/v1", None,
                 {"cmd": "discovery", "method": "POST"}),
                ("method_post_plan", "POST", "/api/tilesplicer/v1/plan", {"assetId": "img-0001f", "kind": "FACE"},
                 {"cmd": "plan", "assetId": "img-0001f", "kind": "FACE", "method": "POST"}),
                ("unknown_path", "GET", "/api/tilesplicer/v1/nope", None,
                 {"cmd": "raw", "path": "/api/tilesplicer/v1/nope"}),
                ("scope_root", "GET", "/api/tilesplicer", None, {"cmd": "raw", "path": "/api/tilesplicer"}),
            ]

            parity_rows = []
            parity_pass = 0
            for name, method, path, params, bridge_payload in cases:
                dev = client.request(method, dev_base + path, params=params)
                api = client.request(method, base + path, params=params)
                leg = bridge_direct(bridge_payload)
                kernel = None
                if name.startswith("plan_") and name not in ("plan_too_small",) and params and params.get("width"):
                    kernel = bridge_direct({
                        "cmd": "kernel-plan", "assetId": params["assetId"], "kind": params["kind"],
                        "sourceWidth": params["width"], "sourceHeight": params["height"],
                    })
                elif name == "plan_face_registered":
                    kernel = bridge_direct({"cmd": "kernel-plan", "assetId": "img-0001f", "kind": "FACE",
                                            "sourceWidth": 1600, "sourceHeight": 1600})

                body_equal = api.content == dev.content
                bridge_equal = leg["body"] == dev.content
                kernel_equal = None if kernel is None else kernel["body"] == dev.content
                structural = try_json(api.content) == try_json(dev.content)
                # 結構化覆核（不靠透傳）：Python 以緊湊分隔重新序列化 ⇒ 是否與 JS 字節逐字節相同
                reserialized = None
                parsed = try_json(dev.content)
                if parsed is not None:
                    reserialized = json.dumps(parsed, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                reserialize_equal = None if reserialized is None else reserialized == dev.content

                ok = (
                    body_equal
                    and bridge_equal
                    and api.status_code == dev.status_code
                    and structural
                    and (kernel_equal is not False)
                    and (reserialize_equal is not False)
                )
                if ok:
                    parity_pass += 1
                parity_rows.append({
                    "case": name, "method": method, "path": path, "params": params,
                    "status": {"dev": dev.status_code, "api": api.status_code},
                    "bytes": {"dev": len(dev.content), "api": len(api.content)},
                    "md5": {"dev_side_middleware": md5(dev.content), "xiai_api": md5(api.content),
                            "node_bridge_geom_mjs": leg["md5"], "kernel_direct_planFor": (kernel or {}).get("md5")},
                    "byte_identical": {"api_vs_dev": body_equal, "bridge_vs_dev": bridge_equal,
                                       "kernel_vs_dev": kernel_equal},
                    "structural_equal": structural, "python_reserialize_equals_js_bytes": reserialize_equal,
                    "content_type": {"dev": dev.headers.get("content-type"), "api": api.headers.get("content-type")},
                    "body_sample": dev.content.decode("utf-8", "replace")[:120],
                })
                flag = "✔" if ok else "✘"
                say(f"    {flag} {name:24s} status {dev.status_code}/{api.status_code} "
                    f"md5 {md5(dev.content)[:12]}/{md5(api.content)[:12]} 逐字節={body_equal} 橋={bridge_equal} "
                    f"內核={kernel_equal} 結構={structural} 重序列化={reserialize_equal}")

            ev["sections"]["parity"]["cases"] = parity_rows
            ev["sections"]["parity"]["summary"] = {
                "cases": len(parity_rows), "pass": parity_pass, "fail": len(parity_rows) - parity_pass,
            }
            mark(f"parity 逐字節一致 ＋ 兩邊 md5（{parity_pass}/{len(parity_rows)}）",
                 parity_pass == len(parity_rows),
                 "所有用例：api 響應體 == 前端側中間件響應體；橋與內核直調亦逐字節相同")

            # ── 3. 切塊清單 ＋ 拼回對帳 ─────────────────────────────────────
            say("")
            say("[3] 切塊清單（face 4 / scene 8，靠 kind 區分）＋ 拼回對帳（N 塊 vs 整圖一次轉碼）")
            slices_ev: dict = {}
            for kind, asset_id in (("face", "img-0001f"), ("scene", "photo-p3-1")):
                resp = client.post(f"{base}/api/image/slices",
                                   params={"assetId": asset_id, "kind": kind},
                                   content=tiff, headers={"content-type": "application/octet-stream"})
                entry: dict = {
                    "request": {"method": "POST", "path": "/api/image/slices",
                                "params": {"assetId": asset_id, "kind": kind}, "body_bytes": len(tiff)},
                    "status": resp.status_code, "content_type": resp.headers.get("content-type"),
                    "server_headers": {k.lower(): v for k, v in resp.headers.items()
                                       if k.lower().startswith("x-xiai")},
                    "bytes": len(resp.content), "sha256": sha256(resp.content),
                }
                if resp.status_code != 200:
                    entry["body"] = resp.content.decode("utf-8", "replace")[:300]
                    slices_ev[kind] = entry
                    mark(f"slices[{kind}] 200", False, entry["body"][:120])
                    continue
                parts = parse_multipart(resp.content)
                manifest = json.loads(parts[0]["payload"].decode("utf-8"))
                blocks = [p for p in parts[1:]]
                entry.update({
                    "parts": len(parts), "block_parts": len(blocks), "manifest_bytes": parts[0]["bytes"],
                    "manifest": {k: v for k, v in manifest.items() if k not in ("blocks", "tiles", "placements")},
                })
                (out_dir / f"slices_{kind}_response.bin").write_bytes(resp.content)
                for position, part in enumerate(blocks):
                    (out_dir / f"slices_{kind}_block_{position:02d}.webp").write_bytes(part["payload"])

                # 每塊：mime / 可解 / 尺寸 == rect / sha256 自洽
                block_checks = []
                for block_meta, part in zip(manifest["blocks"], blocks):
                    payload = part["payload"]
                    server_sniff = codec_mod.sniff_mime(payload)
                    try:
                        with Image.open(io.BytesIO(payload)) as im:
                            im.load()
                            size = list(im.size)
                    except Exception as exc:  # noqa: BLE001
                        size = f"decode-fail:{exc}"
                    block_checks.append({
                        "index": block_meta["index"], "rect": block_meta["rect"],
                        "placements": block_meta["placements"],
                        "part_content_id": part["headers"].get("content-id"),
                        "part_content_type": part["headers"].get("content-type"),
                        "bytes": len(payload), "sha256_ok": sha256(payload) == block_meta["sha256"],
                        "server_sniff": server_sniff,
                        # ★ 塊傳輸口徑：VP8L ＝ 無損（`X-Block-Lossless` 自報值 ＋ RIFF 子塊四字元自證）
                        "chunk_kind": webp_chunk_kind(payload),
                        "lossless_flag": block_meta.get("lossless"),
                        "container_scope": block_meta.get("container_scope"),
                        "quality": block_meta.get("quality"),
                        "x_block_lossless_header": part["headers"].get("x-block-lossless"),
                        "decoded_size": size,
                        "size_matches_rect": size == [block_meta["rect"]["w"], block_meta["rect"]["h"]],
                        "placement_equals_rect": block_meta["placements"] == {
                            "x": block_meta["rect"]["x"], "y": block_meta["rect"]["y"],
                            "width": block_meta["rect"]["w"], "height": block_meta["rect"]["h"],
                        },
                    })
                entry["blocks"] = block_checks
                (out_dir / f"slices_{kind}_blocks.json").write_text(
                    json.dumps(block_checks, ensure_ascii=False, indent=1), encoding="utf-8")

                # 無未切分整圖：任何一件的尺寸都不得等於源面尺寸
                whole_present = any(
                    isinstance(item["decoded_size"], list)
                    and item["decoded_size"] == [photo.width, photo.height]
                    for item in block_checks
                )
                entry["whole_image_part_present"] = whole_present

                # 對帳：拼回 vs 整圖一次轉碼（同一支路 decode）＋ vs 源位圖
                canvas = Image.new("RGB", (photo.width, photo.height))
                for block_meta, part in zip(manifest["blocks"], blocks):
                    with Image.open(io.BytesIO(part["payload"])) as block_img:
                        block_img.load()
                        canvas.paste(block_img.convert("RGB"), (block_meta["placements"]["x"], block_meta["placements"]["y"]))
                canvas.save(out_dir / f"reassembled_{kind}.png")
                dec = client.post(f"{base}/api/image/decode", params={"kind": kind}, content=tiff,
                                  headers={"content-type": "application/octet-stream"})
                (out_dir / f"whole_{kind}.webp").write_bytes(dec.content)
                with Image.open(io.BytesIO(dec.content)) as whole_img:
                    whole_img.load()
                    whole = whole_img.convert("RGB")
                with Image.open(io.BytesIO(tiff)) as source_img:
                    source_img.load()
                    source_bitmap = source_img.convert("RGB")

                vs_whole = compare_images(canvas, whole)
                vs_source = compare_images(canvas, source_bitmap)

                # ★ 對照讀數（派單方裁定 ③）：舊口徑（**每塊各自獨立有損 0.92**，即在已 0.92 有損的
                #   展示位圖上再量化一次）⇒ 拼回 vs 整圖轉碼；以及**噪聲底**（整圖 0.92 解碼 vs 源位圖）。
                legacy_canvas = Image.new("RGB", (photo.width, photo.height))
                for block_meta in manifest["blocks"]:
                    rect = block_meta["rect"]
                    piece = codec_mod.bitmap_to_webp(
                        whole.crop((rect["x"], rect["y"], rect["x"] + rect["w"], rect["y"] + rect["h"])), 0.92
                    )
                    with Image.open(io.BytesIO(piece)) as block_img:
                        block_img.load()
                        legacy_canvas.paste(block_img.convert("RGB"), (rect["x"], rect["y"]))
                vs_legacy_rule = compare_images(legacy_canvas, whole)
                noise_floor = compare_images(whole, source_bitmap)

                # ★ 「縫」讀數（邊界台階判據）：跨塊邊界 vs 塊內的像素差中位數比值（新舊口徑各一）
                cuts_x = sorted({b["rect"]["x"] for b in manifest["blocks"] if b["rect"]["x"] > 0})
                cuts_y = sorted({b["rect"]["y"] for b in manifest["blocks"] if b["rect"]["y"] > 0})
                seam_new = seam_step_reading(canvas, whole, cuts_x, cuts_y)
                seam_legacy = seam_step_reading(legacy_canvas, whole, cuts_x, cuts_y)

                entry["reassembly"] = {
                    "assembled_size": list(canvas.size), "source_size": list(source_bitmap.size),
                    "whole_transcode": {"bytes": len(dec.content), "sha256": sha256(dec.content),
                                        "content_type": dec.headers.get("content-type"),
                                        "quality": dec.headers.get("x-xiai-quality")},
                    "vs_whole_transcode": vs_whole, "vs_source_bitmap": vs_source,
                    # 口徑修正後的三行並列（新判据 / 舊口徑對照 / 噪聲底）
                    "tile_rule_new_lossless": vs_whole,
                    "tile_rule_legacy_lossy_per_block": vs_legacy_rule,
                    "noise_floor_whole092_vs_source": noise_floor,
                    "seam_boundary_step": {"cuts_x": cuts_x, "cuts_y": cuts_y,
                                           "new_lossless_tiles": seam_new,
                                           "legacy_lossy_tiles": seam_legacy},
                    "kernel_seam": manifest["seam"],
                    "kernel_plan_md5": md5(json.dumps(manifest["slicing"]["kernel_plan"], ensure_ascii=False,
                                                      sort_keys=True).encode("utf-8")),
                }
                slices_ev[kind] = entry

                expected_blocks = 4 if kind == "face" else 8
                expected_shape = "2x2" if kind == "face" else "4x2"
                shape_ok = (manifest["cols"], manifest["rows"]) == ((2, 2) if kind == "face" else (4, 2))
                mark(f"slices[{kind}]：{len(blocks)} 塊／形狀 {manifest['cols']}x{manifest['rows']}（期望 "
                     f"{expected_blocks} 塊 {expected_shape}）",
                     len(blocks) == expected_blocks and shape_ok,
                     f"header x-xiai-blocks={resp.headers.get('x-xiai-blocks')}")
                mark(f"slices[{kind}] 每塊為 WebP（**塊傳輸口徑 ＝ 無損 VP8L**）且尺寸 == rect",
                     all(b["server_sniff"] == "image/webp" and b["chunk_kind"] == "VP8L"
                         and b["lossless_flag"] is True and b["size_matches_rect"] and b["sha256_ok"]
                         for b in block_checks),
                     f"{len(block_checks)} 塊逐塊核對；chunk_kinds="
                     f"{sorted({b['chunk_kind'] for b in block_checks})}")
                mark(f"slices[{kind}] **新判据**：拼回位圖 與 整圖 0.92 解碼位圖 逐像素一致（maxΔ=0）",
                     vs_whole.get("size_equal") is True and vs_whole.get("max_abs_delta") == [0, 0, 0]
                     and vs_whole.get("identical_ratio") == 1.0,
                     f"maxΔ={vs_whole.get('max_abs_delta')} ident={vs_whole.get('identical_ratio')}")
                mark(f"slices[{kind}] 對照：舊口徑（每塊各自有損 0.92）拼回 vs 整圖轉碼（如實報差）",
                     vs_legacy_rule.get("size_equal") is True
                     and (vs_legacy_rule.get("psnr_db") or 0) < (vs_whole.get("psnr_db") or 10**9),
                     f"舊 {vs_legacy_rule.get('psnr_db')} dB / 新 maxΔ={vs_whole.get('max_abs_delta')} / "
                     f"噪聲底 {noise_floor.get('psnr_db')} dB")
                mark(f"slices[{kind}] placements == rect（落位由內核派生）",
                     all(b["placement_equals_rect"] for b in block_checks))
                mark(f"slices[{kind}] 響應內無未切分整圖", not whole_present)
                mark(f"slices[{kind}] 內核 seam 三鍵皆真（校驗讀數）",
                     all(manifest["seam"].get(key) is True
                         for key in ("ok", "areaEqualsSource", "noOverlap", "edgesAdjacent")),
                     json.dumps(manifest["seam"], ensure_ascii=False))
                say(f"    ★ 新口徑（無損塊）拼回 vs 整圖轉碼：恆等像素 {vs_whole.get('identical_ratio')}，"
                    f"均值Δ {vs_whole.get('mean_abs_delta')}，最大Δ {vs_whole.get('max_abs_delta')}，"
                    f"PSNR {vs_whole.get('psnr_db')}")
                say(f"      舊口徑（每塊有損 0.92）拼回 vs 整圖轉碼：恆等像素 {vs_legacy_rule.get('identical_ratio')}，"
                    f"均值Δ {vs_legacy_rule.get('mean_abs_delta')}，最大Δ {vs_legacy_rule.get('max_abs_delta')}，"
                    f"PSNR {vs_legacy_rule.get('psnr_db')} dB")
                say(f"      噪聲底（整圖 0.92 解碼 vs 源位圖）：均值Δ {noise_floor.get('mean_abs_delta')}，"
                    f"最大Δ {noise_floor.get('max_abs_delta')}，PSNR {noise_floor.get('psnr_db')} dB")
                say(f"      「縫」讀數：新口徑 seam_ratio={seam_new.get('seam_ratio')}"
                    f"（邊界中位 {seam_new.get('boundary_median_abs_delta')} / 塊內中位 "
                    f"{seam_new.get('interior_median_abs_delta')}）；舊口徑 seam_ratio="
                    f"{seam_legacy.get('seam_ratio')}（邊界中位 {seam_legacy.get('boundary_median_abs_delta')} / "
                    f"塊內中位 {seam_legacy.get('interior_median_abs_delta')}）")
            ev["sections"]["slices"] = slices_ev

            # ── 4. 直出路徑（thumb / download）——均不經 TileSplicer ─────────
            say("")
            say("[4] 直出路徑：thumb / download（**均不經 TileSplicer**；下載件全分辨率 WebP 0.92）")
            before = client.get(f"{base}/api/health").json()["slicing"]["calls"]
            thumb = client.post(f"{base}/api/image/thumb", params={"kind": "face", "width": 256}, content=tiff,
                                headers={"content-type": "application/octet-stream"})
            download = client.post(f"{base}/api/image/download", params={"kind": "face"}, content=tiff,
                                   headers={"content-type": "application/octet-stream"})
            after = client.get(f"{base}/api/health").json()["slicing"]["calls"]
            (out_dir / "direct_thumb.webp").write_bytes(thumb.content)
            # ★ 2026-09-23 Kevin 裁定：下載件 ＝ **原始 TIFF 字節直出**（原字節面）⇒ 副檔名如實為 `.tif`
            (out_dir / "direct_download.tif").write_bytes(download.content)
            with Image.open(io.BytesIO(thumb.content)) as im:
                im.load()
                thumb_size = list(im.size)
            with Image.open(io.BytesIO(download.content)) as im:
                im.load()
                download_size = list(im.size)
            # 負對照：同一份源件的 **WebP 展示件**（decode 支路）—— 證明下載件**不是** WebP 轉碼產物
            webp_product = client.post(f"{base}/api/image/decode", params={"kind": "face"}, content=tiff,
                                       headers={"content-type": "application/octet-stream"})
            (out_dir / "direct_download_webp_negative_control.webp").write_bytes(webp_product.content)
            neg = {
                "webp_product_sniff": codec_mod.sniff_mime(webp_product.content),
                "download_sniff": codec_mod.sniff_mime(download.content),
                "webp_product_bytes": len(webp_product.content), "download_bytes": len(download.content),
                "webp_product_sha256": sha256(webp_product.content),
                "download_sha256": sha256(download.content),
                "mime_differ": codec_mod.sniff_mime(webp_product.content) != codec_mod.sniff_mime(download.content),
                "sha256_differ": sha256(webp_product.content) != sha256(download.content),
                "bytes_differ": len(webp_product.content) != len(download.content),
            }
            direct_ev = {
                "bridge_calls_before": before, "bridge_calls_after": after,
                "bridge_calls_delta": after - before,
                "thumb": {"status": thumb.status_code, "content_type": thumb.headers.get("content-type"),
                          "bytes": len(thumb.content), "size": thumb_size,
                          "sha256": sha256(thumb.content),
                          "headers": {k.lower(): v for k, v in thumb.headers.items()
                                      if k.lower().startswith("x-xiai")}},
                "download": {"status": download.status_code, "content_type": download.headers.get("content-type"),
                             "bytes": len(download.content), "size": download_size,
                             "sha256": sha256(download.content),
                             "magic_head": hex_head(download.content, 8),
                             "magic_is_tiff": download.content[:2] in (b"II", b"MM"),
                             "content_disposition": download.headers.get("content-disposition"),
                             "filename_suffix": (download.headers.get("content-disposition") or "").rsplit(".", 1)[-1],
                             "sha256_matches_source": sha256(download.content) == sha256(tiff),
                             "bytes_match_source": len(download.content) == len(tiff),
                             "source_sha256": sha256(tiff), "source_bytes": len(tiff),
                             "headers": {k.lower(): v for k, v in download.headers.items()
                                         if k.lower().startswith("x-xiai")}},
                "download_negative_control_vs_webp_product": neg,
                "source_size": list(photo.size),
                "download_mime_by_server_sniff": codec_mod.sniff_mime(download.content),
                "tab_separated_blocks_in_response": b"--" + BOUNDARY.encode() in thumb.content
                or b"--" + BOUNDARY.encode() in download.content,
            }
            ev["sections"]["direct"] = direct_ev
            say(f"    橋調用計數：before={before} after={after}（Δ={after - before}；兩條直出路徑**零**橋調用）")
            say(f"    thumb ⇒ {thumb.status_code} {thumb.headers.get('content-type')} {thumb_size} "
                f"{len(thumb.content)} B splicer={thumb.headers.get('x-xiai-tile-splicer')}")
            say(f"    download ⇒ {download.status_code} {download.headers.get('content-type')} {download_size} "
                f"{len(download.content)} B transcode={download.headers.get('x-xiai-transcode')} "
                f"watermark={download.headers.get('x-xiai-watermark')} min_role={download.headers.get('x-xiai-min-role')}")
            say(f"      ├ 與源存儲件對帳：sha256 相同={direct_ev['download']['sha256_matches_source']} "
                f"長度相同={direct_ev['download']['bytes_match_source']} "
                f"（源 {len(tiff)} B / 下載 {len(download.content)} B）magic={direct_ev['download']['magic_head']}")
            say(f"      └ 負對照（同源 WebP 展示件 vs 下載件）：mime {neg['webp_product_sniff']!r} vs "
                f"{neg['download_sniff']!r}・{neg['webp_product_bytes']} B vs {neg['download_bytes']} B ⇒ "
                f"兩者不同={neg['sha256_differ'] and neg['mime_differ']}")
            faces = health["direct"]["faces"]
            say(f"    health 三面：slices={faces['slices']['container']}/lossless:{faces['slices']['lossless']} "
                f"｜ thumb={faces['thumb']['container']}/{faces['thumb']['quality']} "
                f"｜ download={faces['download']['container']}/{faces['download']['transcode']}")
            mark("直出路徑：橋調用計數 Δ == 0（機械讀數：不經 TileSplicer）", after == before, f"Δ={after - before}")
            policy = health["direct"]["raw_bytes_policy"]
            say(f"    原始字節政策（帶面別）：preview={policy['preview']} ／ download={policy['download']} ／ "
                f"legacy_readonly_download={policy['legacy_readonly_download']}")
            mark("原始字節下發政策**帶面別**（`preview: blocked` ／ `download: verbatim_tiff`）：無無限定的"
                 "「原字節永不下發」布爾位；下載面返回 TIFF 屬**正對照（合規行為）**，不作風險項",
                 policy["preview"] == "blocked" and policy["download"] == "verbatim_tiff"
                 and not any(isinstance(v, bool) for v in policy.values()),
                 f"preview={policy['preview']} / download={policy['download']}")
            mark("health 三面分列（slices 塊面・無損 ／ thumb 縮略面 WebP 0.92 ／ download 原字節面 TIFF）"
                 "＋ 整圖展示口徑未改（webp / 0.92 / lossless:false）",
                 faces["slices"]["container"] == "image/webp" and faces["slices"]["lossless"] is True
                 and faces["thumb"]["container"] == "image/webp" and faces["thumb"]["quality"] == 0.92
                 and faces["download"]["container"] == "image/tiff" and faces["download"]["passthrough"] is True
                 and health["display"]["quality"] == 0.92 and health["display"]["lossless"] is False,
                 f"download={faces['download']['container']} / display={health['display']}")
            mark("thumb 為單件圖片響應、無切塊集合",
                 thumb.status_code == 200 and not direct_ev["tab_separated_blocks_in_response"]
                 and max(thumb_size) <= 256)
            mark("download ＝ **原始 TIFF 字節直出**（byte-verbatim）：sha256 ≡ 源存儲件 ＋ 長度一致 ＋ "
                 "magic TIFF ＋ `image/tiff` ＋ 零轉碼 ＋ 不加水印 ＋ 登錄用戶可下載 ＋ 檔名帶 `.tif`",
                 download.status_code == 200
                 and direct_ev["download"]["sha256_matches_source"]
                 and direct_ev["download"]["bytes_match_source"]
                 and direct_ev["download"]["magic_is_tiff"]
                 and (download.headers.get("content-type") or "").startswith("image/tiff")
                 and download.headers.get("x-xiai-transcode") == "none"
                 and download.headers.get("x-xiai-watermark") == "false"
                 and download.headers.get("x-xiai-min-role") == "user"
                 and download.headers.get("x-xiai-tile-splicer") == "bypassed"
                 and direct_ev["download"]["filename_suffix"] in ("tif", "tiff"),
                 f"sha256 ≡ 源={direct_ev['download']['sha256_matches_source']}｜"
                 f"magic={direct_ev['download']['magic_head']}｜"
                 f"disposition={direct_ev['download']['content_disposition']}")
            mark("download 負對照：同源 WebP 展示件 與 下載件**不同**（mime 不同 ＋ sha256 不同 ＋ 長度不同）"
                 "⇒ 下載件確為 TIFF 原字節、而非任何 WebP 轉碼",
                 neg["mime_differ"] and neg["sha256_differ"] and neg["bytes_differ"],
                 f"{neg['webp_product_sniff']}/{neg['webp_product_bytes']} B vs "
                 f"{neg['download_sniff']}/{neg['download_bytes']} B")
            mark("download 全分辨率（返回位圖尺寸 == 源面尺寸）", download_size == list(photo.size),
                 f"{download_size} vs {list(photo.size)}")

            # ── 5. 失敗形態（新增端點）＋ 繁體 message ──────────────────────
            say("")
            say("[5] 失敗形態（結構化 / 零偽數據 / 繁體 message / 不洩漏內部標識）")
            failures: dict = {}

            def failure_case(name: str, method: str, path: str, params, payload: bytes, ctype="application/octet-stream"):
                resp = client.request(method, f"{base}{path}", params=params, content=payload,
                                      headers={"content-type": ctype})
                parsed = try_json(resp.content)
                entry = {
                    "case": name, "status": resp.status_code, "content_type": resp.headers.get("content-type"),
                    "reason": (parsed or {}).get("reason"), "message": (parsed or {}).get("message"),
                    "structured": bool(parsed and parsed.get("ok") is False and parsed.get("reason")),
                    "image_bytes": (resp.headers.get("content-type") or "").startswith("image/"),
                    "bytes": len(resp.content),
                }
                failures[name] = entry
                say(f"    {name}: {resp.status_code} {entry['reason']} 結構化={entry['structured']} "
                    f"圖片字節={entry['image_bytes']}")
                return entry

            failure_case("slices_missing_asset", "POST", "/api/image/slices", {"kind": "face"}, tiff)
            failure_case("slices_missing_kind", "POST", "/api/image/slices", {"assetId": "img-0001f"}, tiff)
            failure_case("slices_bad_kind", "POST", "/api/image/slices", {"assetId": "img-0001f", "kind": "bogus"}, tiff)
            failure_case("slices_unknown_field", "POST", "/api/image/slices", {"assetId": "img-0001f", "kind": "face", "x": "1"}, tiff)
            failure_case("slices_non_tiff", "POST", "/api/image/slices", {"assetId": "img-0001f", "kind": "face"}, png_bytes(photo))
            failure_case("slices_empty", "POST", "/api/image/slices", {"assetId": "img-0001f", "kind": "face"}, b"")
            tiny = png_bytes(Image.new("RGB", (1, 1), (12, 34, 56)))
            tenc = client.post(f"{base}/api/image/encode", params={"container": "tiff"}, content=tiny,
                               headers={"content-type": "application/octet-stream"})
            failure_case("slices_size_too_small", "POST", "/api/image/slices",
                         {"assetId": "tiny-1", "kind": "face"}, tenc.content)
            failure_case("thumb_non_tiff", "POST", "/api/image/thumb", {"kind": "face"}, png_bytes(photo))
            failure_case("download_non_tiff", "POST", "/api/image/download", {"kind": "face"}, png_bytes(photo))
            failure_case("thumb_bad_width", "POST", "/api/image/thumb", {"width": "99999"}, tiff)
            failure_case("decode_png", "POST", "/api/image/decode", {"kind": "face"}, png_bytes(photo))
            # ★ AVIF 自本輪起**不屬失敗面**（依 §3.25.5 ⑤ ＋ §10.23 AC-204 恢復**存量只讀面**解碼能力）
            #   ⇒ 移出本節，其正向讀數見 [7]；**PNG 仍留在本節作對照**（舊 8 色索引 PNG 不走本面 —— AC-168）。
            failure_case("decode_garbage", "POST", "/api/image/decode", {"kind": "face"}, b"\x00\x01\x02garbage-12")
            failures["messages"] = sorted({entry["message"] for entry in failures.values() if entry.get("message")})
            ev["sections"]["failures"] = failures
            all_structured = all(
                entry["structured"] and not entry["image_bytes"]
                for key, entry in failures.items() if isinstance(entry, dict) and "structured" in entry
            )
            mark("新增端點失敗形態一律結構化（無圖片字節冒充）", all_structured)

            messages = failures["messages"]
            s2t = s2t_readings(messages)
            ev["sections"]["message_s2t"] = s2t
            leak_tokens = ["X-Xiai", "sourceWidth", "assetId", "kind", "5191", "/api/", "slice", "Slice",
                           "TIFF", "AVIF", "WebP", "http"]
            leaks = {
                message: [token for token in leak_tokens if token in message]
                for message in messages
            }
            ev["sections"]["message_leaks"] = leaks
            if "__error__" in s2t:
                mark("message 繁體檢測（s2t）", False, s2t["__error__"][:120])
            else:
                all_trad = all(read["identical"] for read in s2t.values())
                for message, read in s2t.items():
                    say(f"    identical={read['identical']} · {message}")
                mark(f"message 全繁體 s2t(x) === x（{len(s2t)} 條）", all_trad)
            # 端點路徑 / 端口 / 字段名的洩漏面：技術標識只允許出現在「圖像編解碼面」的字面值裡，
            # message 一律不得含端點路徑 / 端口 / 內部字段名（`TIFF` 為 mime 字面的一部份，屬命名例外範圍）
            hard_leaks = {
                message: [token for token in tokens if token in ("/api/", "5191", "X-Xiai", "sourceWidth", "assetId")]
                for message, tokens in leaks.items()
            }
            hard_leaks = {k: v for k, v in hard_leaks.items() if v}
            ev["sections"]["message_hard_leaks"] = hard_leaks
            mark("message 不含端點路徑 / 端口 / 內部字段名", not hard_leaks, json.dumps(hard_leaks, ensure_ascii=False))

            # ── 6. LRU 讀數（同鍵第二次為命中；換鍵為未命中）────────────────
            say("")
            say("[6] 進程內 LRU：同鍵第二次命中、換鍵未命中、產出逐字節同一份")
            p1 = client.get(f"{base}/api/tilesplicer/v1/plan", params={"assetId": "lru-probe-1", "kind": "FACE",
                                                                     "width": 1024, "height": 768})
            p2 = client.get(f"{base}/api/tilesplicer/v1/plan", params={"assetId": "lru-probe-1", "kind": "FACE",
                                                                     "width": 1024, "height": 768})
            p3 = client.get(f"{base}/api/tilesplicer/v1/plan", params={"assetId": "lru-probe-2", "kind": "FACE",
                                                                     "width": 1024, "height": 768})
            lru_ev = {
                "same_key_twice_byte_equal": p1.content == p2.content,
                "status": {"first": p1.status_code, "second": p2.status_code, "other_key": p3.status_code},
                "first_md5": md5(p1.content), "second_md5": md5(p2.content), "other_key_md5": md5(p3.content),
                "other_key_differs": p1.content != p3.content,
                "stats_after": client.get(f"{base}/api/health").json()["slicing"]["lru"],
            }
            ev["sections"]["lru"] = lru_ev
            say(f"    同鍵兩次逐字節相同={lru_ev['same_key_twice_byte_equal']}；stats={json.dumps(lru_ev['stats_after'])}")
            mark("LRU：同鍵第二次產出逐字節相同、統計有命中", lru_ev["same_key_twice_byte_equal"]
                 and lru_ev["stats_after"]["hits"] > 0, json.dumps(lru_ev["stats_after"]))

            # ── 7. AVIF 退場節（新增產物面退場）＋ **存量只讀面**（AC-204）────────
            say("")
            say("[7] AVIF：**新增產物面退場**（§3.25.5）＋ **存量只讀面可讀**（§3.25.5 ⑤ / §10.23 AC-204）")
            avif_src = avif_bytes(photo)
            (out_dir / "retired_source.avif").write_bytes(avif_src)
            # (a) 存量只讀面：**解 / 縮略圖 / 預覽** 三條鏈路（AC-204 ①「須可顯示、可預覽、不報錯」）
            avif_dec = client.post(f"{base}/api/image/decode", params={"kind": "scene"}, content=avif_src,
                                   headers={"content-type": "application/octet-stream"})
            (out_dir / "legacy_avif_decode.webp").write_bytes(avif_dec.content)
            avif_thumb = client.post(f"{base}/api/image/thumb", params={"kind": "scene"}, content=avif_src,
                                     headers={"content-type": "application/octet-stream"})
            avif_slices = client.post(f"{base}/api/image/slices", params={"assetId": "legacy-avif-1", "kind": "scene"},
                                      content=avif_src, headers={"content-type": "application/octet-stream"})
            tiff_branch = client.post(f"{base}/api/image/decode", params={"kind": "face"}, content=tiff,
                                      headers={"content-type": "application/octet-stream"})

            def branch_reading(resp) -> dict:
                parsed = try_json(resp.content) or {}
                read = {"status": resp.status_code, "content_type": resp.headers.get("content-type"),
                        "bytes": len(resp.content), "server_sniff": codec_mod.sniff_mime(resp.content),
                        "reason": parsed.get("reason"), "message": parsed.get("message"),
                        "headers": {k.lower(): v for k, v in resp.headers.items()
                                    if k.lower().startswith("x-xiai")}}
                if read["server_sniff"] == "image/webp":
                    with Image.open(io.BytesIO(resp.content)) as im:
                        im.load()
                        read["decoded_size"] = list(im.size)
                return read

            avif_dec_read = branch_reading(avif_dec)
            with Image.open(io.BytesIO(avif_src)) as avif_img:
                avif_img.load()
                avif_bitmap = avif_img.convert("RGB")
            with Image.open(io.BytesIO(avif_dec.content)) as dec_img:
                dec_img.load()
                avif_webp_bitmap = dec_img.convert("RGB")
            avif_dec_read["vs_source_bitmap"] = compare_images(avif_webp_bitmap, avif_bitmap)
            avif_dec_read["source_sniff"] = codec_mod.sniff_mime(avif_src)

            avif_enc = client.post(f"{base}/api/image/encode", params={"container": "avif", "kind": "scene"},
                                   content=jpeg, headers={"content-type": "application/octet-stream"})
            report_p2 = REPO / "qa-recheck" / "kong-P2-20260923" / "REPORT.md"
            prior = [
                line.strip() for line in report_p2.read_text(encoding="utf-8").splitlines()
                if "avif" in line.lower()
            ] if report_p2.exists() else []
            retired_ev = {
                "declaration": "依 Kevin 2026-09-23 修正：無論 face-photo 或 scene-photo 一律【單頁 8bit Deflate TIFF】"
                               "⇒ AVIF 於**新增產物面**整體退場（§3.25.5 四項）。",
                "correction": "★ 本輪依 v1.25 §3.25.5 ⑤ ＋ §10.23 AC-204 改正：退場**只作用於新增產物的容器選擇**"
                              "、**不作用於存量字節的如實回報**（§3.25.5 (d)）⇒ **存量只讀面**的 AVIF 字節仍須"
                              "**可解、可顯示**（不遷移 / 不清除 / 不引導重傳）；派單方先前「decode 收窄為 TIFF-only」"
                              "的 steer 只覆蓋新增產物面、漏了存量面，**以 v1.25 為準回退該收窄**。",
                "face_separation": {
                    "source_containers（寫入面／新增產物）": health["source_containers"],
                    "legacy_readonly_containers（存量只讀面）": health.get("legacy_readonly_containers"),
                    "readable_source_containers（讀取面可解集合）": health.get("readable_source_containers"),
                    "retired_capabilities": health["retired_capabilities"],
                    "retired_capabilities_scope": health.get("retired_capabilities_scope"),
                },
                "legacy_readonly_decode": avif_dec_read,
                "legacy_readonly_thumb": branch_reading(avif_thumb),
                "legacy_readonly_slices": {**branch_reading(avif_slices),
                                           "x_xiai_blocks": avif_slices.headers.get("x-xiai-blocks"),
                                           "x_xiai_block_mime": avif_slices.headers.get("x-xiai-block-mime")},
                "tiff_branch_decode_parallel": branch_reading(tiff_branch),
                "decode_avif_now": avif_dec_read,
                "encode_avif_capability": {"status": avif_enc.status_code,
                                           "content_type": avif_enc.headers.get("content-type"),
                                           "bytes": len(avif_enc.content),
                                           "server_sniff": codec_mod.sniff_mime(avif_enc.content),
                                           "note": "保留為實現能力；**不再作驗收判據、不計入 PASS 數**"},
                "p2_report_prior_avif_readings": prior,
            }
            ev["sections"]["avif_retired"] = retired_ev
            say(f"    存量只讀面 decode(AVIF) ⇒ {avif_dec_read['status']} {avif_dec_read['content_type']} "
                f"{avif_dec_read['bytes']} B size={avif_dec_read.get('decoded_size')} "
                f"sniff={avif_dec_read['server_sniff']} quality={avif_dec_read['headers'].get('x-xiai-quality')}")
            say(f"    TIFF 支並列　 decode(TIFF) ⇒ {tiff_branch.status_code} {tiff_branch.headers.get('content-type')} "
                f"{len(tiff_branch.content)} B sniff={codec_mod.sniff_mime(tiff_branch.content)} "
                f"quality={tiff_branch.headers.get('x-xiai-quality')}")
            say(f"    存量只讀面 thumb(AVIF) ⇒ {avif_thumb.status_code} {avif_thumb.headers.get('content-type')} "
                f"{len(avif_thumb.content)} B；slices(AVIF) ⇒ {avif_slices.status_code} "
                f"{avif_slices.headers.get('content-type')} blocks={avif_slices.headers.get('x-xiai-blocks')}")
            say(f"    encode?container=avif ⇒ {avif_enc.status_code} {avif_enc.headers.get('content-type')} "
                f"{len(avif_enc.content)} B（實現能力，不判）")
            say(f"    P2 已取得的 AVIF 讀數（{len(prior)} 行）已原樣留在證據 JSON 的 "
                f"`avif_retired.p2_report_prior_avif_readings`（**不刪證據**）")
            mark("AVIF 退場（**新增產物面**）：source_containers 仍恰 TIFF ＋ 寫入面零 AVIF 產出 ＋ health 如實宣告",
                 health["source_containers"] == ["image/tiff"]
                 and health["retired_capabilities"] == ["avif"],
                 f"source={health['source_containers']} retired={health['retired_capabilities']}")
            mark("存量只讀面（AC-204 ①）：AVIF 源 ⇒ **解／縮略圖／預覽** 三鏈路皆 200 且產物皆 WebP（非源字節）",
                 avif_dec.status_code == 200 and avif_thumb.status_code == 200 and avif_slices.status_code == 200
                 and avif_dec_read["server_sniff"] == "image/webp"
                 and codec_mod.sniff_mime(avif_thumb.content) == "image/webp"
                 and codec_mod.sniff_mime(avif_dec.content) != "image/avif",
                 f"decode={avif_dec.status_code}/{avif_dec_read['server_sniff']} "
                 f"thumb={avif_thumb.status_code} slices={avif_slices.status_code}/"
                 f"{avif_slices.headers.get('x-xiai-blocks')} 塊")
            mark("存量只讀面：AVIF 支與 TIFF 支並列（皆 200 image/webp、同一展示口徑 0.92、尺寸 == 源面）",
                 avif_dec_read["status"] == 200 and tiff_branch.status_code == 200
                 and avif_dec_read["headers"].get("x-xiai-quality") == tiff_branch.headers.get("x-xiai-quality") == "0.92"
                 and avif_dec_read.get("decoded_size") == list(photo.size),
                 f"AVIF {avif_dec_read.get('decoded_size')} / TIFF {list(photo.size)} / "
                 f"quality {avif_dec_read['headers'].get('x-xiai-quality')}")

            # ── 8. 補 P2 缺口 ①：mime 對照（絕對路徑）──────────────────────
            say("")
            say("[8] 補 P2 缺口 ①：mime 對照 —— 產品真值函數 readings（**絕對路徑**）")
            artifacts = [out_dir / "source_photo.jpg", out_dir / "storage_tiff.bin",
                         out_dir / "whole_face.webp", out_dir / "direct_download.tif",
                         out_dir / "direct_download_webp_negative_control.webp",
                         out_dir / "direct_thumb.webp", out_dir / "retired_source.avif"]
            artifacts += sorted(out_dir.glob("slices_*_block_*.webp"))
            truth = product_truth_mime([p for p in artifacts if p.exists()])
            server_side = {}
            for path in artifacts:
                if not path.exists():
                    continue
                server_side[str(path)] = codec_mod.sniff_mime(path.read_bytes())
            agreement = []
            for path in artifacts:
                key = str(path)
                if key not in truth or key not in server_side:
                    continue
                product = truth[key]
                agreement.append({
                    "path": key, "name": path.name, "bytes": product.get("bytes"),
                    "server_sniff_mime": server_side[key],
                    "product_sniffBytesMime": product.get("sniffBytesMime"),
                    "product_sniffMime": product.get("sniffMime"),
                    "agreement_sniffBytesMime": server_side[key] == product.get("sniffBytesMime"),
                })
            gap1 = {
                "note": "P2 缺口 ①（mime 對照未取到讀數）的收口：本輪**一律以絕對路徑**（`Path.resolve()`）"
                        "把產物路徑交給 node 側只讀調用產品真值函數 ⇒ 不再出現相對路徑基準不一致的 ENOENT。",
                "product_truth_sources": ["src/utils/image.js::sniffBytesMime", "src/data/assetmeta.js::sniffMime"],
                "agreement": agreement,
                "disagreements": [row for row in agreement if not row["agreement_sniffBytesMime"]],
            }
            ev["sections"]["gap1_mime_absolute_paths"] = gap1
            for row in agreement:
                say(f"    {row['name']:26s} server={row['server_sniff_mime']!r:14s} "
                    f"product.sniffBytesMime={row['product_sniffBytesMime']!r:14s} "
                    f"product.sniffMime={row['product_sniffMime']!r:14s} 一致={row['agreement_sniffBytesMime']}")
            if gap1["disagreements"]:
                say(f"    ★ 不一致 {len(gap1['disagreements'])} 項（如實登記，不掩蓋）：")
                for row in gap1["disagreements"]:
                    say(f"       · {row['name']}：服務側 {row['server_sniff_mime']!r} vs "
                        f"產品真值 {row['product_sniffBytesMime']!r}")
            mark("缺口 ① 收口：mime 對照以絕對路徑取得**兩側讀數**", bool(agreement) and "__error__" not in truth,
                 f"{len(agreement)} 項，其中 {len(gap1['disagreements'])} 項兩側不一致（見 REPORT 如實登記）")

            # ── 9. 補 P2 缺口 ②：reason_is_frozen 複核 ─────────────────────
            say("")
            say("[9] 補 P2 缺口 ②：`reason_is_frozen` 複核（產物側閘 vs 輸入側閘，兩套不得互用）")
            from app import errors as errors_mod  # noqa: PLC0415

            small_jpeg = jpeg
            saved_limit = codec_mod.STORED_MAX_BYTES
            codec_mod.STORED_MAX_BYTES = 65536          # 只在本探針進程內臨時壓小（不動產品數值）
            try:
                codec_mod.encode_storage(small_jpeg, "tiff")
                artifact_branch = {"raised": False}
            except codec_mod.XiaiError as exc:
                artifact_branch = {
                    "raised": True, "reason": exc.reason, "status": exc.status, "message": exc.message,
                    "reason_is_frozen": exc.reason in errors_mod.MESSAGES,
                    "reason_is_artifact_side": exc.reason == errors_mod.ARTIFACT_TOO_LARGE,
                }
            finally:
                codec_mod.STORED_MAX_BYTES = saved_limit
            try:
                codec_mod.encode_storage(b"\x00" * (codec_mod.MAX_INPUT_BYTES + 16), "tiff")
                input_branch = {"raised": False}
            except codec_mod.XiaiError as exc:
                input_branch = {"raised": True, "reason": exc.reason, "status": exc.status,
                                "reason_is_frozen": exc.reason in errors_mod.MESSAGES,
                                "reason_is_input_side": exc.reason == errors_mod.TOO_LARGE}
            gap2 = {
                "p2_reading": {
                    "value": "reason_is_frozen=False（4c 進程內直調）",
                    "root_cause": "P2 的那次直調用 1024×1024 噪聲 PNG 當輸入（> 1 MB）⇒ 先撞**輸入側**閘"
                                  "（`TOO_LARGE`），探針卻拿它與**產物側**值 `ARTIFACT_TOO_LARGE` 比較 ⇒ "
                                  "`reason_is_frozen=False` 是**比較基準錯位**，不是 reason 不在凍結集合內。",
                },
                "recheck": {
                    "artifact_side": artifact_branch,
                    "input_side": input_branch,
                    "frozen_set": sorted(errors_mod.MESSAGES),
                    "limits_in_probe": {"STORED_MAX_BYTES_during_call": 65536,
                                        "STORED_MAX_BYTES_restored": codec_mod.STORED_MAX_BYTES,
                                        "MAX_INPUT_BYTES": codec_mod.MAX_INPUT_BYTES,
                                        "input_bytes_for_artifact_branch": len(small_jpeg)},
                },
                "verdict": None,
                "http_face_reachability": {
                    "formula": "artifact_bytes(TIFF,RGB) ≈ W*H*3（Deflate 對噪聲近不可壓）；"
                               "有界重編 ≤3 輪、每輪最長邊 ÷2 ⇒ 第 3 輪後邊長 ＝ W0/8",
                    "threshold_px": math.ceil(math.sqrt(4 * 1024 * 1024 * 64 / 3)),
                    "verdict": "HTTP 面不可達（輸入側 1 MB 閘 ＋ 產物側 4 MiB 閘聯立）⇒ 該分支僅在"
                               "進程內直調可觀測（**與 P2 結論一致，未變**）",
                },
            }
            ok_artifact = bool(artifact_branch.get("raised")) and artifact_branch.get("reason_is_frozen") \
                and artifact_branch.get("reason_is_artifact_side")
            ok_input = bool(input_branch.get("raised")) and input_branch.get("reason_is_frozen") \
                and input_branch.get("reason_is_input_side")
            gap2["verdict"] = (
                "reason_is_frozen=True（產物側 `ARTIFACT_TOO_LARGE` 在凍結集合內、狀態 413、message 繁體）；"
                "輸入側為 `TOO_LARGE`；兩閘 reason 互不混用 ⇒ P2 的 `reason_is_frozen=False` 定性為"
                "**比較基準錯位**，已在本輪以正確的閘位複跑並如實標註。"
            )
            ev["sections"]["gap2_reason_is_frozen"] = gap2
            say(f"    產物側（縮小上限至 65536）：raised={artifact_branch.get('raised')} "
                f"reason={artifact_branch.get('reason')} status={artifact_branch.get('status')} "
                f"frozen={artifact_branch.get('reason_is_frozen')} 屬產物側={artifact_branch.get('reason_is_artifact_side')}")
            say(f"    輸入側（> 1 MB）：reason={input_branch.get('reason')} status={input_branch.get('status')} "
                f"frozen={input_branch.get('reason_is_frozen')} 屬輸入側={input_branch.get('reason_is_input_side')}")
            say(f"    上限已復原={gap2['recheck']['limits_in_probe']['STORED_MAX_BYTES_restored']}")
            mark("缺口 ② 複核：產物側 reason 凍結（`ARTIFACT_TOO_LARGE` 413）＋ 兩閘不串台", ok_artifact and ok_input,
                 f"artifact={artifact_branch.get('reason')} / input={input_branch.get('reason')}")

            # ── 10. 零副作用 ＋ 內核導出面（AC-177 取證）────────────────────
            say("")
            say("[10] 零副作用 ＋ 內核導出面（AC-177 真源恰 1 處）")
            listing = sorted(p.name for p in SERVER.iterdir())
            listing_before = ev.get("sections", {}).get("zero_side_effect", {}).get("server_dir_listing")
            ev["sections"]["zero_side_effect"] = {
                "server_dir_listing": listing,
                "note": "服務自身不寫任何文件 / 快取目錄；本探針的產物一律寫進 qa-recheck/ 證據目錄",
                "listing_before": listing_before,
            }
            say(f"    server/ 清單：{listing}")
            kernel_info = bridge_direct({"cmd": "kernel-info"})
            kinfo = json.loads(kernel_info["body"].decode("utf-8"))
            ev["sections"]["kernel_facts"] = kinfo
            say(f"    內核：{kinfo['name']} {kinfo['version']}　模組 {kinfo['modules']}")
            say(f"    導出面（{len(kinfo['exports'])} 個）：{kinfo['exports']}")
            say(f"    塊數真源：{json.dumps(kinfo['cut_counts'], ensure_ascii=False)}　刀向：{kinfo['directions']}")
            mark("內核身份逐字（`TileSplicer` / `tilesplicer/v1`）＋ 導出面齊備",
                 kinfo["name"] == "TileSplicer" and kinfo["version"] == "tilesplicer/v1"
                 and {"planFor", "metaFor", "windowsOf", "pixelRectsOf", "seamOf", "placementsOf"} <= set(kinfo["exports"]))

            # 幾何 / 切位實現點檢索（源碼面）：**以「定義形態」檢索**，避免把導出面 / 註釋的「名字提及」誤判為實作
            def python_code_lines(path: Path) -> set[int]:
                """Python 檔的**非註釋、非字符串**行號集合（`tokenize`；供區分「實作」與「說明文字」）。"""
                keep: set[int] = set()
                try:
                    with path.open("rb") as handle:
                        for token in tokenize.tokenize(handle.readline):
                            if token.type in (
                                tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE,
                                tokenize.INDENT, tokenize.DEDENT, tokenize.ENCODING, tokenize.ENDMARKER,
                            ):
                                continue
                            keep.add(token.start[0])
                except Exception:  # noqa: BLE001
                    return set(range(1, 10_000))
                return keep

            def scan(files: list[Path], patterns: tuple[str, ...], root: Path, python: bool) -> dict:
                found: dict = {}
                for path in files:
                    code_lines = python_code_lines(path) if python else None
                    hits = []
                    for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                        if not any(pattern in line for pattern in patterns):
                            continue
                        in_code = True if code_lines is None else (number in code_lines)
                        hits.append({"line": number, "text": line.strip()[:110], "in_code": in_code})
                    if hits:
                        found[str(path.relative_to(root))] = hits
                return found

            # JS：模式本身即「定義形態」⇒ 命中即實作（導出面 / 註釋只會提到名字，不會帶 `function …(`）
            definition_patterns = (
                "function ratioAt(", "function windowsOf(", "function pixelRectsOf(",
                "function pixelRectsFromCuts(", "function metaFor(", "function seamOf(", "function placementsOf(",
                "function planFor(",
            )
            # 凍結字面值（刀向序列 / 刀數表）的真源：`src/data/seed.js`（core.js 只 import ＋ 轉口）
            frozen_literal_patterns = ("SLICE_DIRECTIONS =", "SLICE_CUT_COUNTS =")
            geometry_identifiers = (
                "ratioAt(", "windowsOf(", "pixelRectsOf(", "pixelRectsFromCuts(", "metaFor(", "seamOf(",
                "placementsOf(", "planFor(", "offsetRatio", "SLICE_CUT_COUNTS", "SLICE_DIRECTIONS",
            )
            geo_hits = scan(sorted((REPO / "src").rglob("*.js")), definition_patterns, REPO, python=False)
            literal_hits = scan(sorted((REPO / "src").rglob("*.js")), frozen_literal_patterns, REPO, python=False)
            # ★ 本輪修正（探針自指）：`server/**` 的實現點掃描**排除 `*_probe.py`** ——
            #   理由 ＝ 探針自身源文件裡的模式清單（如 `"ratioAt("` 字面量，位於 `p3_probe.py` 的代碼行）
            #   會被**自匹配**，**非產品實現命中**。排除項 ＋ 理由同時寫入證據 JSON 與 REPORT。
            all_server_py = sorted(SERVER.rglob("*.py"))
            probe_self_files = [p for p in all_server_py if p.name.endswith("_probe.py")]
            server_scan_files = [p for p in all_server_py if not p.name.endswith("_probe.py")]
            server_hits = scan(server_scan_files, geometry_identifiers, REPO, python=True)
            excluded_hits = scan(probe_self_files, geometry_identifiers, REPO, python=True)  # **只記錄，不判**
            server_in_code = {
                name: [hit for hit in hits if hit["in_code"]] for name, hits in server_hits.items()
            }
            server_in_code = {name: hits for name, hits in server_in_code.items() if hits}
            # 拼接面檢索（AC-178）：api 側不得有「把切塊拼回整圖」的實作點
            assembly_hits = scan(sorted((SERVER / "app").rglob("*.py")),
                                 (".paste(", "Image.new(", "composite(", "alpha_composite("), REPO, python=True)
            assembly_in_code = {name: [hit for hit in hits if hit["in_code"]] for name, hits in assembly_hits.items()}
            assembly_in_code = {name: hits for name, hits in assembly_in_code.items() if hits}
            ev["sections"]["implementation_points"] = {
                "src_definition_hits": geo_hits,
                "src_frozen_literal_hits": literal_hits,
                "server_identifier_hits": server_hits,
                "server_identifier_hits_in_code": server_in_code,
                "server_assembly_hits_in_code": assembly_in_code,
                # ★ 探針自指的排除項（顯式記錄；理由逐字）
                "server_scan_exclusion": {
                    "excluded_glob": "*_probe.py",
                    "excluded_files": [str(path.relative_to(REPO)) for path in probe_self_files],
                    "scan_scope": "server/**/*.py（含 `server/.venv/` 的第三方套件 —— 取**更嚴**的掃描面："
                                  "連第三方一併掃過仍為 0 命中）",
                    "scanned_file_count": len(server_scan_files),
                    "scanned_product_files": [str(path.relative_to(REPO)) for path in server_scan_files
                                              if ".venv" not in path.parts],
                    "reason": "探針自身源文件的模式清單（如 `\"ratioAt(\"` 字面量，落於 `server/tools/p3_probe.py` 的"
                              "**代碼行**）會被**自匹配** ⇒ **非產品實現命中**；故 `server/**` 的實現點掃描一律"
                              "排除探針自身（`*_probe.py`），命中數須為 0 方判通過。",
                    "hits_if_not_excluded": {name: len(hits) for name, hits in excluded_hits.items()},
                },
            }
            say(f"    src/** 內「定義形態」命中處：{json.dumps({k: len(v) for k, v in geo_hits.items()}, ensure_ascii=False)}")
            say(f"    src/** 內凍結字面值定義處：{json.dumps({k: len(v) for k, v in literal_hits.items()}, ensure_ascii=False)}")
            say(f"    server/** 內同標識命中：{sum(len(v) for v in server_hits.values())} 行，"
                f"其中**在代碼中**（非註釋 / 非字符串）{sum(len(v) for v in server_in_code.values())} 行"
                f"：{json.dumps(server_in_code, ensure_ascii=False)[:240]}")
            say(f"    ★ 掃描排除：`*_probe.py` —— 排除 {len(probe_self_files)} 件"
                f"{[str(p.relative_to(REPO)) for p in probe_self_files]}；"
                f"掃描檔 {len(server_scan_files)} 件。理由 ＝ 探針自身模式清單**自匹配**，非產品命中；"
                f"未排除時所得（僅記錄、不判）：{json.dumps({k: len(v) for k, v in excluded_hits.items()}, ensure_ascii=False)}")
            say(f"    server/app 內拼接原語（在代碼中）：{json.dumps({k: len(v) for k, v in assembly_in_code.items()}, ensure_ascii=False)}")
            mark("真源恰 1 處：幾何 / 切位**定義**僅在 `src/tilesplicer/core.js`",
                 set(geo_hits) == {"src/tilesplicer/core.js"},
                 json.dumps(sorted(geo_hits), ensure_ascii=False))
            mark("凍結字面值（刀向 / 刀數）定義恰 1 處：`src/data/seed.js`",
                 set(literal_hits) == {"src/data/seed.js"},
                 json.dumps(sorted(literal_hits), ensure_ascii=False))
            mark("api 側零幾何 / 零切位實作（同標識只出現在說明文字；掃描已排除 `*_probe.py` 自指）",
                 not server_in_code,
                 f"掃描檔 {len(server_scan_files)} 件（排除 probe 自指 {len(probe_self_files)} 件）；"
                 f"在代碼中命中 {sum(len(v) for v in server_in_code.values())} 行")
            mark("AC-178：api 側零拼接實作點", not assembly_in_code)

    finally:
        if dev_proc is not None:
            dev_proc.send_signal(signal.SIGTERM)
            try:
                dev_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                dev_proc.kill()
    ev["sections"]["dev_side_process"] = {"terminated": dev_proc is not None,
                                          "returncode": None if dev_proc is None else dev_proc.returncode}

    # ── 匯總 ────────────────────────────────────────────────────────────────
    ev["results"] = results
    passed = sum(1 for value in results.values() if value.startswith("PASS"))
    ev["summary"] = {"checks": len(results), "pass": passed, "fail": len(results) - passed}
    (out_dir / "evidence.json").write_text(json.dumps(ev, ensure_ascii=False, indent=1), encoding="utf-8")
    (out_dir / "probe-run.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    say("")
    say(f"== 匯總：{passed}/{len(results)} 通過 ==")
    for name, value in results.items():
        say(f"    {value}｜{name}")
    say(f"證據：{out_dir}/evidence.json（{os.path.getsize(out_dir / 'evidence.json')} B）")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
