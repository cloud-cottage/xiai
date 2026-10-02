"""xiai-api · 服務骨架（P2 圖像編解碼面 ＋ **P3 切分面**）

**讀取面 ＝ xiai-api**（§3.24.1）：對外展示內容的唯一輸出口；本服務落地**圖像編解碼面**與
**切分面**（預覽切塊 / 縮略圖 / 下載件）——

| 方法 / 路徑 | 職責 | 判據落位 |
| --- | --- | --- |
| `GET  /api/health` | 健康檢查（服務名逐字 `xiai-api`；切分 / 直出兩條路徑的聲明與讀數） | §3.24.8 |
| `GET  /api/tilesplicer/v1` | **發現面**（與前端 dev 中間件響應體**逐字節一致**） | §3.24.5 ② |
| `GET  /api/tilesplicer/v1/plan` | **切片計劃**（同上；切位 / 塊數 / 幾何全部來自同一份內核） | §3.24.5 ② / AC-177 |
| `POST /api/image/slices` | **預覽路徑**：解 → 轉 WebP 0.92 → 經 TileSplicer → 出塊（face 4 / scene 8） | §3.24.3 ① / AC-174 |
| `POST /api/image/thumb` | **直出路徑**（縮略圖）：**不經 TileSplicer** | §3.24.3 ② / AC-175 |
| `POST /api/image/download` | **直出路徑・原字節面**（「下載高清原圖」）：**原始 TIFF 字節直出（byte-verbatim、零轉碼）**、不經 TileSplicer | §3.24.3 ② / **Kevin 2026-09-23 裁定**（取代件 J v1.26 在途） |
| `POST /api/image/decode` | 源面類字節（**TIFF**；**存量只讀面**另收 AVIF —— AC-204） ⇒ 展示件（有損 WebP 0.92） | AC-165 / AC-174（「解 → 轉」兩段） |
| `POST /api/image/encode` | 位圖 ⇒ 存儲件（**TIFF ＋ Deflate**） | §3.22.1 |
| `POST /api/image/store` | **服務端權威存儲**（內容尋址）⇒ `<sha256[:2]>/<sha256>.tiff` | §3.24.7 ①② / §3.22.1 |
| `GET  /api/image/original/{sha256}` | 權威庫按 digest 取回**原字節**（byte-verbatim、零轉碼） | §3.26.3 / §3.26.4 |

★ **2026-09-23 Kevin 修正**：「無論是 face-photo 還是 scene-photo 都選用**【單頁 8bit Deflate TIFF】
進行存儲，對外的輸出格式不變」** ⇒ **寫入面（新增產物）唯一源容器 ＝ TIFF**；AVIF 於**新增產物面**
整體退場（§3.25.5 退場四項；`encode?container=avif` 保留為**實現能力**、**不再作為驗收判據、
不計入 PASS 數**）。兩類切片**只靠 `kind` 區分**（`face` / `scene`），不靠容器（§3.25.7）。

★★ **2026-09-23 依 v1.25 §3.25.5 ⑤ ＋ §10.23 AC-204 改正（面別分開、不得串台）**：AVIF 退場
**只作用於新增產物的容器選擇**、**不作用於存量字節的如實回報**（§3.25.5 (d)）；「認 AVIF 魔數」**保留**
⇒ **存量只讀面**的 AVIF 字節仍須**可解、可顯示**（不遷移 / 不清除 / 不引導重傳；AC-204 ①）——
故 `source_containers` 仍為 `["image/tiff"]`（**寫入面**），另立 `legacy_readonly_containers`
（**存量只讀面**）如實單列；**PNG 仍按原口徑 415**（舊 8 色索引 PNG 由前端原生解碼、不走本面）。

★ **塊傳輸口徑（2026-09-23 派單方裁定）**：塊邊界台階的**結構性消除** —— 整圖編一次有損 WebP 0.92
→ 解碼位圖 → 按內核幾何窗口裁塊 → 每塊以**無損 WebP（VP8L）**輸出（塊僅為**傳輸容器**，承載的仍是
0.92 有損轉碼的展示位圖、不再二次量化）⇒ 拼回位圖與整圖 0.92 解碼位圖**逐像素一致**。
**整圖展示口徑一字不改**（`health.display` 仍 webp / 0.92 / lossless:false）；塊口徑單列於
`health.slicing`（`tile_container` / `tile_lossless`）。與 §3.25.4 ① / AC-198 ④ 字面口徑的張力
**已如實登記**（REPORT U-5）。

邊界（本服務自限，逐條可機械判）：
  ① **零第二處切分實現** —— 本服務不含任何幾何 / 切位 / 刀向 / 塊數 / 取整計算（真源恰 1 處 ＝
     `xiai/src/tilesplicer/`；本面經 `server/tools/geom.mjs` 薄橋**消費同一份內核**）：AC-177；
  ② **零回寫、零落盤** —— 讀路徑不碰任何存儲面 / 文件系統（AC-158 / §3.24.3 ⑦）；
  ③ **零防泄露違反（面别限定 —— ★ Kevin 2026-09-23 澄清：「TIFF 不是永不下发，下载高清原图的时候用户是可以得到 TIFF 的」）**
     —— **預覽／展示面（隱式）**：源面類字節不下發（只給切塊集合／縮略圖／整圖展示）；
        **下載面（顯式）**：**原 TIFF 字節直出**（`image/tiff`、byte-verbatim，見 `raw_bytes_policy`）。
        預覽響應內**不含未切分整圖**
     （AC-179 / AC-174 ⑤）；
  ④ **零新增 reason 字面值** —— 一切拒絕走 `app/errors.py` 的凍結集合（§3.12.10(c)）。

**★ 本檔不是上屏面**：`message` 一律繁體且不含內部標識；端點名 / 字段名 / mime 字面 /
TIFF 容器標識屬 §3.23.6「圖像編解碼面」命名例外（不受「上屏零『切分』措辭」約束）。
"""

from __future__ import annotations

import hashlib
import json
import os
import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from PIL import Image
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import codec, slicer, store
from .errors import (
    INVALID_FIELD,
    INVALID_VALUE,
    MISSING_REQUIRED,
    NOT_FOUND,
    STORAGE_UNAVAILABLE,
    XiaiError,
)

SERVICE_NAME = "xiai-api"
SERVICE_VERSION = "0.1.0-p3"
API_PREFIX = "/api"
TILESPLICER_PREFIX = "/api/tilesplicer/v1"
TILESPLICER_SCOPE = "/api/tilesplicer"
SLICES_PATH = f"{API_PREFIX}/image/slices"
THUMB_PATH = f"{API_PREFIX}/image/thumb"
DOWNLOAD_PATH = f"{API_PREFIX}/image/download"
# ── 權威存儲面（P5a）：寫入口 ＋ 按 digest 原字節面 ──────────────────────────────
STORE_PATH = f"{API_PREFIX}/image/store"
ORIGINAL_PATH = f"{API_PREFIX}/image/original"
REF_SHA256 = "sha256"          # 三面「按 digest 引用」的查詢鍵名
STARTED_AT = time.time()

app = FastAPI(
    title=SERVICE_NAME,
    version=SERVICE_VERSION,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# ── 查詢參數白名單（字段面；未知鍵 ⇒ INVALID_FIELD，值不在集合內 ⇒ INVALID_VALUE）────
DECODE_QUERY = {"kind"}
ENCODE_QUERY = {"container", "kind", "quality"}
# ★ P5a：三面各增**按 digest 引用**的形態（`?sha256=<hex>`）；
#   **既有直傳字節形態一字未破**（不帶 `sha256` 時仍走請求載荷 ⇒ 行為與取值全不變）。
STORE_QUERY = {"kind"}
SLICES_QUERY = {"assetId", "kind", REF_SHA256}
THUMB_QUERY = {"kind", "width", REF_SHA256}
DOWNLOAD_QUERY = {"kind", REF_SHA256}
KIND_VALUES = set(slicer.CLIENT_KINDS)

# ── 直出路徑（縮略圖）的目標長邊（**本面唯一的縮略圖尺寸口徑**；非塊數、非幾何）────────
THUMB_DEFAULT_LONG_EDGE = 256
THUMB_MIN_LONG_EDGE = 16
THUMB_MAX_LONG_EDGE = 4096

# ── 切塊傳輸面（multipart/mixed；塊字節逐塊獨立，**不含整圖**）──────────────────────
SLICES_BOUNDARY = "xiai-slices-v1"


def _validate_query(query: dict, allowed: set[str], kind_check: bool = True) -> dict:
    """字段面 ＋ 值域面判定（**在任何解碼 / 編碼之前**，失敗即零副作用 —— §3.15.11 精神）。"""
    unknown = sorted(set(query) - allowed)
    if unknown:
        raise XiaiError(INVALID_FIELD)
    kind = query.get("kind")
    if kind_check and kind is not None and kind not in KIND_VALUES:
        raise XiaiError(INVALID_VALUE)
    return {key: query[key] for key in allowed if key in query}


async def _read_payload(request: Request) -> bytes:
    """取請求載荷：`application/octet-stream`（裸字節）或 `multipart/form-data` 的 `file` 字段。"""
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype == "multipart/form-data":
        form = await request.form()
        for key in form.keys():
            if key != "file":
                raise XiaiError(INVALID_FIELD)
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            raise XiaiError(MISSING_REQUIRED)
        return await upload.read()
    return await request.body()


async def _source_bytes(request: Request, params: dict) -> tuple[bytes, str]:
    """源字節的兩種取得形態（**面別不變、職責不變**）：

    · `?sha256=<hex>`：從**服務端權威存儲**按 digest 取件（`app/store.py`；取不到 ⇒ `NOT_FOUND`）；
    · 不帶 `sha256`：**既有直傳字節形態**（請求載荷 `application/octet-stream` / `multipart`）。

    返回 `(bytes, digest_or_empty)` —— digest 非空即「按 digest 引用」形態（供取證頭如實回報）。
    """
    ref = params.get(REF_SHA256)
    if ref is None:
        return await _read_payload(request), ""
    digest = store.normalize_digest(ref)
    return store.read_bytes(digest), digest


# ── 展示件公共頭（質量口徑恰 1 處 ＝ `codec.DISPLAY_WEBP_QUALITY`）──────────────────
def _display_headers(**extra: object) -> dict:
    headers = {
        "X-Xiai-Out-Mime": codec.WEBP_MIME,
        "X-Xiai-Quality": f"{codec.DISPLAY_WEBP_QUALITY}",
        "X-Xiai-Lossless": "false" if not codec.DISPLAY_WEBP_LOSSLESS else "true",
        "Cache-Control": "no-store",
    }
    for key, value in extra.items():
        if value is None:
            continue
        headers[key.replace("_", "-")] = str(value)
    return headers


@app.get(f"{API_PREFIX}/health")
async def health() -> dict:
    """健康檢查（只讀、冪等、零副作用）——同時是本面兩條路徑與質量口徑的**自我聲明**。"""
    return {
        "ok": True,
        "name": SERVICE_NAME,          # 逐字（§3.24.1 ②）
        "version": SERVICE_VERSION,
        "pid": os.getpid(),
        "uptime_s": round(time.time() - STARTED_AT, 3),
        "face": "readpath",            # 讀取面（§3.24.1 ③）
        "endpoints": [
            f"GET {API_PREFIX}/health",
            f"GET {TILESPLICER_PREFIX}",
            f"GET {TILESPLICER_PREFIX}/plan",
            f"POST {SLICES_PATH}",
            f"POST {THUMB_PATH}",
            f"POST {DOWNLOAD_PATH}",
            f"POST {API_PREFIX}/image/decode",
            f"POST {API_PREFIX}/image/encode",
        ],
        # ★ 2026-09-23 修正：**寫入面（新增產物）**唯一源容器 ＝ TIFF（AVIF 於新增產物面退場）
        "source_containers": list(codec.SOURCE_CONTAINERS),
        # ★★ 依 v1.25 §3.25.5 ⑤ ＋ AC-204（面別分開、不得串台）：**存量只讀面**仍須可解、可顯示
        "legacy_readonly_containers": list(codec.LEGACY_READONLY_CONTAINERS),
        "readable_source_containers": list(codec.READABLE_SOURCE_CONTAINERS),
        "storage_containers": list(codec.ARCHITECTURE_STORAGE_CONTAINERS),
        "retired_capabilities": list(codec.RETIRED_CAPABILITIES),
        "retired_capabilities_scope": "僅限新增產物面（寫入面不再產 AVIF）；**不影響存量只讀面** ——"
                                      "認 AVIF 魔數保留、存量字節仍可解可顯示（§3.25.5 ⑤ / AC-204）",
        "display": {
            "mime": codec.WEBP_MIME,
            "quality": codec.DISPLAY_WEBP_QUALITY,
            "lossless": codec.DISPLAY_WEBP_LOSSLESS,
        },
        # ★ P5a 新增讀數（**上面各既有字段一字不改**）：服務端權威存儲（內容尋址）——
        #   只回報**相對路徑形狀**（不回報絕對路徑）、`content_addressed = true`、`max_bytes`。
        "authority_storage": store.health_facts(),
        "limits": {
            "max_input_bytes": codec.MAX_INPUT_BYTES,
            "stored_max_bytes": codec.STORED_MAX_BYTES,
            "max_source_bytes": codec.MAX_SOURCE_BYTES,
            "max_reencode_rounds": codec.MAX_REENCODE_ROUNDS,
        },
        # 切分面：運算落點在本面，**但幾何仍由同一份內核給**（真源恰 1 處）
        "slicing": slicer.health_facts(),
        # 直出路徑三面**如實分開**（★ 2026-09-23 Kevin 裁定：download ＝ 原字節面）
        "direct": {
            "endpoints": {"slices": SLICES_PATH, "thumb": THUMB_PATH, "download": DOWNLOAD_PATH},
            "tile_splicer": "bypassed",
            "thumb_long_edge": THUMB_DEFAULT_LONG_EDGE,
            "faces": {
                "slices": {
                    "path": SLICES_PATH, "face": "塊面（預覽）", "output": "切塊集合（multipart/mixed）",
                    "container": codec.WEBP_MIME, "lossless": codec.TILE_WEBP_LOSSLESS,
                    "quality": codec.TILE_WEBP_QUALITY,
                    "note": "塊內無損（塊傳輸口徑）—— 承載的仍是 0.92 有損轉碼的展示位圖",
                    "tile_splicer": "applied",
                },
                "thumb": {
                    "path": THUMB_PATH, "face": "縮略面", "output": "單件縮略圖",
                    "container": codec.WEBP_MIME, "quality": codec.DISPLAY_WEBP_QUALITY,
                    "lossless": codec.DISPLAY_WEBP_LOSSLESS, "long_edge": THUMB_DEFAULT_LONG_EDGE,
                    "tile_splicer": "bypassed",
                },
                "download": {
                    "path": DOWNLOAD_PATH, "face": "原字節面（「下載高清原圖」）",
                    "output": "原始存儲件字節直出", "container": codec.TIFF_MIME,
                    "passthrough": True, "transcode": "none（byte-verbatim：下載件 sha256 ≡ 存儲件 sha256）",
                    "watermark": False, "min_role": "user",
                    "note": "★ Kevin 2026-09-23 裁定（推翻派單方先前的『全分辨率 WebP 0.92』默認口徑）",
                    "tile_splicer": "bypassed",
                },
            },
            "display_face": {"mime": codec.WEBP_MIME, "quality": codec.DISPLAY_WEBP_QUALITY,
                             "lossless": codec.DISPLAY_WEBP_LOSSLESS,
                             "note": "整圖**展示**口徑（與上面三面分列；本口径未改）"},
            # ★ 原始字節下發政策**帶面別**（★ Kevin 2026-09-23 澄清：「TIFF 不是永不下發，
            #   下載高清原圖的時候用戶是可以得到 TIFF 的」）—— **不得**寫成無限定的布爾位。
            "raw_bytes_policy": {
                "preview": "blocked",                 # 預覽／展示面（隱式）：不下發源面類字節
                "download": "verbatim_tiff",          # 下載面（顯式）：原 TIFF 字節直出（合規行為）
                "legacy_readonly_download": "verbatim_avif",   # 存量只讀行的原字節直出（AC-204 面）
                "note": "面別限定：預覽面 blocked／下載面 verbatim —— 不存在無限定的『原字節永不下發』",
            },
        },
    }


# ── 契約面：與前端 dev 中間件**逐字節同一份**產出（真源 ＝ src/tilesplicer/）──────────
def _contract_response(reply: slicer.BridgeReply) -> Response:
    """把橋交回的**原始字節**原樣下發（**不重新序列化** ⇒ 逐字節一致不依賴 Python 的 JSON 實現）。

    狀態碼與 `Content-Type` 亦如實照搬中間件的自報值；另加 `X-Xiai-*` 取證頭（不改響應體）。
    """
    headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Xiai-Contract-Source": f"{slicer.KERNEL_DIR_REL}server.js",
        "X-Xiai-Kernel": slicer.KERNEL_DIR_REL,
        "X-Xiai-Bridge": os.path.basename(str(slicer.GEOM_SCRIPT)),
        "X-Xiai-Slicing-Second-Implementation": "false",
    }
    media_type = (reply.headers.get("content-type") or "application/json; charset=utf-8").split(";")[0].strip()
    return Response(content=reply.body, status_code=reply.status, media_type=media_type, headers=headers)


@app.api_route(TILESPLICER_PREFIX, methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def tilesplicer_discovery(request: Request) -> Response:
    """發現面 `{name, version, kinds, cutCounts}`（**逐字節**由契約中間件產出；含方法面）。"""
    return _contract_response(slicer.discovery(request.method))


@app.api_route(f"{TILESPLICER_PREFIX}/plan", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def tilesplicer_plan(request: Request) -> Response:
    """切片計劃（入參原樣轉交契約中間件；缺參 / 值域面由中間件自答 ⇒ 響應體逐字節一致）。"""
    query = request.query_params
    reply, _hit = slicer.plan_reply(
        query.get("assetId"), query.get("kind"), query.get("width"), query.get("height"), method=request.method
    )
    return _contract_response(reply)


@app.api_route(f"{TILESPLICER_SCOPE}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def tilesplicer_scope_root(request: Request) -> Response:
    """`/api/tilesplicer` 之下的**任意**路徑（含未知者）一律交契約中間件自答（404 面亦逐字節一致）。"""
    reply = slicer.raw_reply(request.method, request.url.path, request.url.query)
    return _contract_response(reply)


@app.api_route(f"{TILESPLICER_SCOPE}/{{rest:path}}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def tilesplicer_scope_any(request: Request) -> Response:
    reply = slicer.raw_reply(request.method, request.url.path, request.url.query)
    return _contract_response(reply)


# ── 預覽路徑：解 → 轉 WebP → 經 TileSplicer → 出塊 ────────────────────────────────
def _multipart_slices(manifest: dict, blocks: list[dict]) -> tuple[bytes, str]:
    """`multipart/mixed`：首部 ＝ 清單（JSON），其後逐塊一件（**響應體內不含未切分整圖**）。"""
    out = bytearray()

    def emit(headers: list[tuple[str, str]], payload: bytes) -> None:
        out.extend(f"--{SLICES_BOUNDARY}\r\n".encode("utf-8"))
        for name, value in headers:
            out.extend(f"{name}: {value}\r\n".encode("utf-8"))
        out.extend(b"\r\n")
        out.extend(payload)
        out.extend(b"\r\n")

    emit(
        [("Content-Type", "application/json; charset=utf-8"), ("Content-ID", "manifest")],
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
    )
    for block in blocks:
        rect = block["rect"]
        placement = block["placements"]
        emit(
            [
                ("Content-Type", block["mime"]),
                ("Content-ID", f"block-{block['index']:03d}"),
                ("X-Block-Index", str(block["index"])),
                ("X-Block-Row", str(block["row"])),
                ("X-Block-Col", str(block["col"])),
                ("X-Block-Rect", f"{rect['x']},{rect['y']},{rect['w']},{rect['h']}"),
                ("X-Block-Placement", f"{placement['x']},{placement['y']},{placement['width']},{placement['height']}"),
                ("X-Block-Container", block["mime"]),
                ("X-Block-Lossless", "true" if block["lossless"] else "false"),
                ("X-Block-Quality-Scope", f"tile-transport（整圖展示口徑 {codec.DISPLAY_WEBP_QUALITY}）"),
                ("X-Block-Sha256", block["sha256"]),
                ("Content-Length", str(block["bytes"])),
            ],
            block["_payload"],
        )
    out.extend(f"--{SLICES_BOUNDARY}--\r\n".encode("utf-8"))
    return bytes(out), f"multipart/mixed; boundary={SLICES_BOUNDARY}"


@app.post(SLICES_PATH)
async def image_slices(request: Request) -> Response:
    """**預覽路徑**：源面字節（TIFF）⇒ 解 ⇒ 轉 WebP 0.92 ⇒ 經 TileSplicer ⇒ 出塊。

    塊數與形狀**一律讀自內核**（face 4 塊 2×2 / scene 8 塊 4×2；本面不寫任何塊數常量）；
    響應 ＝ 清單 ＋ 逐塊 WebP（**無未切分整圖**）；每塊的 `rect` 與落位 `placements` 均由內核派生。
    """
    params = _validate_query(dict(request.query_params), SLICES_QUERY, kind_check=False)
    asset_id = slicer.require_asset_id(params.get("assetId"))
    client_kind = slicer.require_kind(params.get("kind"))

    data, ref_digest = await _source_bytes(request, params)   # 字節直傳 ／ `?sha256=` 按 digest 取件
    source = codec.decode_source_to_bitmap(data)          # 源容器門 ＝ **只認 TIFF**
    width, height = source.size

    plan, reply, cache_hit = slicer.served_plan(asset_id, client_kind, width, height)
    slicer.seam_guard(plan, width, height)                # 校驗內核自報的無縫讀數（不重算幾何）

    display = codec.bitmap_to_webp(source)                # 四段之「轉」：整圖轉 WebP 0.92（中間產物）
    display_bitmap = codec.open_bitmap(display)           # 切分消費的正是這份展示件
    blocks = slicer.cut_tiles(display_bitmap, plan["tiles"])
    placements = slicer.BRIDGE.placements(plan["tiles"])
    by_index = {item["canvas"]: item for item in placements}
    for block in blocks:
        item = by_index.get(block["index"]) or {}
        block["placements"] = {
            "x": int(item.get("x", block["rect"]["x"])),
            "y": int(item.get("y", block["rect"]["y"])),
            "width": int(item.get("width", block["rect"]["w"])),
            "height": int(item.get("height", block["rect"]["h"])),
        }

    manifest = {
        "ok": True,
        "version": plan.get("version"),
        "assetId": asset_id,
        "kind": client_kind,                              # 客戶面 kind（face / scene）
        "kernelKind": plan.get("kind"),                   # 內核類別（FACE / PHOTO）
        "source": plan.get("source"),
        "cuts": plan.get("cuts"),
        "directions": plan.get("directions"),
        "ratios": plan.get("ratios"),
        "cols": plan.get("cols"),
        "rows": plan.get("rows"),
        "blockCount": len(blocks),
        "tiles": plan.get("tiles"),
        "seam": plan.get("seam"),
        "placements": [by_index.get(block["index"]) for block in blocks],
        "blocks": [
            {
                "index": block["index"],
                "row": block["row"],
                "col": block["col"],
                "rect": block["rect"],
                "placements": block["placements"],
                "mime": block["mime"],
                "container_scope": block["container_scope"],
                "quality": block["quality"],
                "lossless": block["lossless"],
                "bytes": block["bytes"],
                "sha256": block["sha256"],
            }
            for block in blocks
        ],
        "display": {
            "mime": codec.WEBP_MIME,
            "quality": codec.DISPLAY_WEBP_QUALITY,
            "lossless": codec.DISPLAY_WEBP_LOSSLESS,
            "whole_image_included": False,                # 預覽不得直出未切分整圖（AC-174 ⑤）
        },
        "slicing": {
            "performed_here": True,
            "kernel": slicer.KERNEL_DIR_REL,
            "second_implementation": False,
            "bridge": os.path.basename(str(slicer.GEOM_SCRIPT)),
            "plan_source": f"{TILESPLICER_PREFIX}/plan",
            "plan_cache_hit": bool(cache_hit),
            # ★ 塊傳輸口徑（與上面的 display 分列；2026-09-23 派單方裁定）
            "tile_container": codec.WEBP_MIME,
            "tile_lossless": codec.TILE_WEBP_LOSSLESS,
            "tile_quality": codec.TILE_WEBP_QUALITY,
            "tile_pipeline": "整圖編一次有損 WebP 0.92 → 解碼位圖 → 按內核幾何窗口裁塊 → 每塊無損 WebP（VP8L）",
            "tile_criterion": "拼回位圖與整圖 0.92 解碼位圖逐像素一致（max_abs_delta = 0）",
            "kernel_plan": reply.json(),                  # 內核原樣計劃（消費方可逐字段覆核）
        },
    }
    body, content_type = _multipart_slices(manifest, blocks)
    headers = _display_headers(
        X_Xiai_Path="preview",
        X_Xiai_Kind=client_kind,
        X_Xiai_Asset_Id=asset_id,
        X_Xiai_Blocks=len(blocks),
        X_Xiai_Block_Mime=codec.WEBP_MIME,
        X_Xiai_Block_Lossless="true" if codec.TILE_WEBP_LOSSLESS else "false",
        X_Xiai_Display_Quality=codec.DISPLAY_WEBP_QUALITY,
        X_Xiai_Out_Width=width,
        X_Xiai_Out_Height=height,
        X_Xiai_Cuts=plan.get("cuts"),
        X_Xiai_Cols=plan.get("cols"),
        X_Xiai_Rows=plan.get("rows"),
        X_Xiai_Plan_Cache="hit" if cache_hit else "miss",
        X_Xiai_Slicing_Kernel=slicer.KERNEL_DIR_REL,
        X_Xiai_Slicing_Bridge=os.path.basename(str(slicer.GEOM_SCRIPT)),
        X_Xiai_Slicing_Second_Implementation="false",
        X_Xiai_Whole_Image="false",
        X_Xiai_Tile_Splicer="applied",
        X_Xiai_Source_Ref=f"sha256:{ref_digest}" if ref_digest else "inline-bytes",
        X_Xiai_Source_Sha256=ref_digest,
    )
    return Response(content=body, media_type=content_type, headers=headers)


# ── 直出路徑：縮略圖 / 「下載高清原圖」⇒ **不經 TileSplicer** ──────────────────────
def _scale_to_long_edge(img: Image.Image, long_edge: int) -> Image.Image:
    width, height = img.size
    longest = max(width, height)
    if longest <= long_edge:
        return img
    scale = long_edge / float(longest)
    return img.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.LANCZOS)


@app.post(THUMB_PATH)
async def image_thumb(request: Request) -> Response:
    """**縮略圖（直出）**：解 ⇒ 縮放 ⇒ WebP 0.92 ⇒ 輸出；**不經 TileSplicer**（響應內無切塊集合）。"""
    params = _validate_query(dict(request.query_params), THUMB_QUERY)
    raw_width = request.query_params.get("width")
    long_edge = THUMB_DEFAULT_LONG_EDGE
    if raw_width is not None and str(raw_width).strip() != "":
        try:
            long_edge = int(str(raw_width).strip())
        except ValueError as exc:
            raise XiaiError(INVALID_VALUE) from exc
        if long_edge < THUMB_MIN_LONG_EDGE or long_edge > THUMB_MAX_LONG_EDGE:
            raise XiaiError(INVALID_VALUE)

    data, ref_digest = await _source_bytes(request, params)   # 字節直傳 ／ `?sha256=` 按 digest 取件
    source = codec.decode_source_to_bitmap(data)          # 源容器門 ＝ 只認 TIFF
    thumb = _scale_to_long_edge(source, long_edge)
    webp = codec.bitmap_to_webp(thumb)
    headers = _display_headers(
        X_Xiai_Path="direct",
        X_Xiai_Kind=params.get("kind") or "",
        X_Xiai_Tile_Splicer="bypassed",
        X_Xiai_Blocks=0,
        X_Xiai_Slicing="none",
        X_Xiai_Full_Resolution="false",
        X_Xiai_Source_Ref=f"sha256:{ref_digest}" if ref_digest else "inline-bytes",
        X_Xiai_Source_Sha256=ref_digest,
        X_Xiai_Thumb_Long_Edge=long_edge,
        X_Xiai_Source_Width=source.width,
        X_Xiai_Source_Height=source.height,
        X_Xiai_Out_Width=thumb.width,
        X_Xiai_Out_Height=thumb.height,
        X_Xiai_Out_Bytes=len(webp),
    )
    return Response(content=webp, media_type=codec.WEBP_MIME, headers=headers)


@app.post(DOWNLOAD_PATH)
async def image_download(request: Request) -> Response:
    """**「下載高清原圖」（直出 · 原字節面）**：**原始存儲件字節直出 → byte-verbatim，零轉碼 / 零重編碼**。

    ★ 2026-09-23 **Kevin 裁定**（**推翻派單方先前「全分辨率 WebP 0.92」的默認口徑**；規範側取代件
    由 Jing 以 **v1.26** 在途產出）：下載件 ＝ **原始 TIFF 字節** —— `Content-Type: image/tiff`、
    檔名帶 `.tif` 後綴、**不加水印**、**不經 TileSplicer**、**不做任何轉碼 / 重編碼** ⇒
    **下載件 `sha256` ≡ 源存儲件 `sha256`**（逐字節同一份）。

    ⚠ **與 v1.25 的衝突（如實登記，見 REPORT 的「下載面口徑改正」節）**：§3.25.4 ② / §3.24.7 ③④ /
    AC-175 ③④ / AC-179 的字面口徑要求「下載件 ＝ 全分辨率 **WebP** 0.92」，且明文「下載件為源面類
    字節（TIFF / AVIF）⇒ 判負」。**本處以 Kevin 的裁定為準**（派單方仲裁、取代件在途）。
    **權限面**：登錄用戶可下載（`X-Xiai-Min-Role: user`）、不加水印、不限管理員（**更嚴形態為可改項**）。
    """
    params = _validate_query(dict(request.query_params), DOWNLOAD_QUERY)
    data, ref_digest = await _source_bytes(request, params)   # 字節直傳 ／ `?sha256=` 按 digest 取件
    stored_mime = codec.source_mime(data)      # 源容器門（新增產物 ＝ TIFF；存量只讀面含 AVIF）
    if stored_mime == "":
        # 認不出 / 非存儲件容器 ⇒ 結構化拒絕（**零偽數據、零回落**）
        raise XiaiError(NOT_IMAGE)
    suffix = ".tif" if stored_mime == codec.TIFF_MIME else ".avif"
    digest = hashlib.sha256(data).hexdigest()
    headers = {
        "Content-Disposition": f'attachment; filename="xiai-original-{digest[:12]}{suffix}"',
        "X-Xiai-Path": "direct",
        "X-Xiai-Face": "download",                 # 三面之一：原字節面（見 health.direct.faces）
        "X-Xiai-Out-Mime": stored_mime,            # 按字節如實（不採信自稱值）
        "X-Xiai-Passthrough": "true",
        "X-Xiai-Transcode": "none",                # 零轉碼 / 零重編碼 ⇒ byte-verbatim
        "X-Xiai-Tile-Splicer": "bypassed",
        "X-Xiai-Blocks": "0",
        "X-Xiai-Slicing": "none",
        "X-Xiai-Watermark": "false",               # 不加水印
        "X-Xiai-Min-Role": "user",                 # 登錄用戶即可下載（更嚴形態為可改項）
        "X-Xiai-Full-Resolution": "true",
        "X-Xiai-Stored-Sha256": digest,            # 自報值；探針另行獨立核對
        "X-Xiai-Stored-Bytes": str(len(data)),
        "X-Xiai-Source-Ref": f"sha256:{ref_digest}" if ref_digest else "inline-bytes",
        "X-Xiai-Source-Sha256": ref_digest,
        "X-Xiai-Kind": params.get("kind") or "",
        "Cache-Control": "no-store",
    }
    return Response(content=data, media_type=stored_mime, headers=headers)


# ── 權威存儲面（P5a）：**寫入口**（`POST /api/image/store`）＋ **原字節面**（`GET /api/image/original/{sha256}`）──
@app.post(STORE_PATH)
async def image_store(request: Request) -> Response:
    """**服務端權威存儲（寫入口）**：收字節（與 `decode` 端點同形態）⇒ 內容尋址落盤。

    路徑形狀 ＝ `<root>/<sha256[:2]>/<sha256>.tiff`（root 默認 `<repo>/data/originals`，可由
    `XIAI_AUTHORITY_ROOT` 覆蓋 —— 供測試隔離）。寫盤為**同目錄臨時文件 ＋ 原子 `os.replace`**；
    **冪等**：目標已存在且 size ／ `sha256` 相同 ⇒ **不重寫**（`X-Xiai-Idempotent: true`、mtime 不變）。

    失敗一律取**凍結 reason 表**（§3.25.10(a) 七值）：空 ⇒ `EMPTY_CONTENT`；超 `STORED_MAX_BYTES`
    ⇒ `TOO_LARGE`；非 TIFF 容器 ⇒ `NOT_IMAGE`。**返回體不含絕對路徑**（只 `relPath` 相對形狀）。
    """
    _validate_query(dict(request.query_params), STORE_QUERY)
    data = await _read_payload(request)
    record = store.store_bytes(data)
    headers = {
        "X-Xiai-Authority-Sha256": record["sha256"],
        "X-Xiai-Authority-Rel-Path": record["relPath"],
        "X-Xiai-Authority-Root": store.root_display(),
        "X-Xiai-Idempotent": "true" if record["idempotent"] else "false",
        "X-Xiai-Existed-Before": "true" if record["existedBefore"] else "false",
        "X-Xiai-Mtime-Ns-Before": "" if record["mtimeNsBefore"] is None else str(record["mtimeNsBefore"]),
        "X-Xiai-Mtime-Ns-After": str(record["mtimeNsAfter"]),
        "X-Xiai-Stored-Bytes": str(record["storedBytes"]),
        "X-Xiai-Out-Mime": codec.TIFF_MIME,
        "Cache-Control": "no-store",
    }
    return JSONResponse(
        status_code=200,
        content={
            "ok": True,
            "sha256": record["sha256"],
            "bytesLength": record["bytesLength"],
            "relPath": record["relPath"],
        },
        headers=headers,
    )


@app.get(f"{ORIGINAL_PATH}/{{sha256}}")
async def image_original(sha256: str) -> Response:
    """**權威庫原字節面**：按 digest 取回存儲件（`image/tiff`、**byte-verbatim**、零轉碼、零回寫）。

    讀路徑零副作用（不回寫存儲件）；取不到 ⇒ 結構化 `NOT_FOUND`（404）。
    """
    digest = store.normalize_digest(sha256)
    data = store.read_bytes(digest)
    digest = hashlib.sha256(data).hexdigest()      # 按字節如實（不採信自報值）
    headers = {
        "Content-Disposition": f'inline; filename="xiai-original-{digest[:12]}.tif"',
        "X-Xiai-Path": "authority",
        "X-Xiai-Face": "original",
        "X-Xiai-Out-Mime": codec.TIFF_MIME,        # 按字節如實
        "X-Xiai-Passthrough": "true",
        "X-Xiai-Transcode": "none",
        "X-Xiai-Tile-Splicer": "bypassed",
        "X-Xiai-Blocks": "0",
        "X-Xiai-Slicing": "none",
        "X-Xiai-Watermark": "false",
        "X-Xiai-Full-Resolution": "true",
        "X-Xiai-Source-Ref": f"sha256:{digest}",
        "X-Xiai-Stored-Sha256": digest,
        "X-Xiai-Stored-Bytes": str(len(data)),
        "X-Xiai-Authority-Rel-Path": store.rel_path_for(digest),
        "Cache-Control": "no-store",
    }
    return Response(content=data, media_type=codec.TIFF_MIME, headers=headers)


# ── 編解碼面（P2；源面：寫入面新增產物**只認 TIFF**，另收存量只讀面的 AVIF —— AC-204）──────────
@app.post(f"{API_PREFIX}/image/decode")
async def image_decode(request: Request) -> Response:
    """源面類字節 ⇒ 展示件（**有損 WebP、質量 0.92**）。

    ★ 2026-09-23 修正：**寫入面（新增產物）**的唯一源容器 ＝ TIFF；
    ★★ 2026-09-23 依 §3.25.5 ⑤ ＋ AC-204 改正：**存量只讀面**的 **AVIF 字節仍須可解、可顯示**
    （不遷移 / 不清除 / 不引導重傳 ⇒ 本端點對 AVIF 與 TIFF 同樣轉出 WebP 0.92）；
    **PNG 入參仍按原口徑** ⇒ 結構化 415 `NOT_IMAGE`（舊 8 色索引 PNG 由前端原生解碼、不走本面，AC-168 面）。
    """
    params = _validate_query(dict(request.query_params), DECODE_QUERY)
    data = await _read_payload(request)
    source = codec.source_mime(data)
    img = codec.decode_source_to_bitmap(data)
    webp = codec.bitmap_to_webp(img)
    headers = {
        "X-Xiai-Source-Mime": source or codec.OCTET_MIME,   # 按字節如實
        "X-Xiai-Out-Mime": codec.WEBP_MIME,
        "X-Xiai-Out-Bytes": str(len(webp)),
        "X-Xiai-Out-Width": str(img.width),
        "X-Xiai-Out-Height": str(img.height),
        "X-Xiai-Quality": f"{codec.DISPLAY_WEBP_QUALITY}",
        "X-Xiai-Kind": params.get("kind") or "",
        "X-Xiai-Path": "direct",
        "X-Xiai-Tile-Splicer": "bypassed",
        "Cache-Control": "no-store",
    }
    return Response(content=webp, media_type=codec.WEBP_MIME, headers=headers)


@app.post(f"{API_PREFIX}/image/encode")
async def image_encode(request: Request) -> Response:
    """位圖 ⇒ 存儲件（`container=tiff` ⇒ TIFF ＋ Deflate）。

    `container=avif` 自 2026-09-23 修正起**保留為實現能力但不再作為驗收判據**（見 REPORT 的 AVIF 退場節）。
    """
    params = _validate_query(dict(request.query_params), ENCODE_QUERY)
    container = params.get("container")
    if container is None:
        raise XiaiError(MISSING_REQUIRED)
    if container not in codec.STORAGE_CONTAINERS:
        raise XiaiError(INVALID_VALUE)
    quality_raw = request.query_params.get("quality")
    quality: float | None = None
    if quality_raw is not None:
        try:
            quality = float(quality_raw)
        except ValueError as exc:
            raise XiaiError(INVALID_VALUE) from exc
        if not (0.0 < quality <= 1.0):
            raise XiaiError(INVALID_VALUE)

    data = await _read_payload(request)
    out, meta = codec.encode_storage(data, container, quality)
    facts = codec.tiff_facts(out) if container == "tiff" else {}
    headers = {
        "X-Xiai-Out-Mime": meta["actual_mime"],            # 按字節如實（不採信自稱值）
        "X-Xiai-Out-Bytes": str(meta["bytes"]),
        "X-Xiai-Source-Size": f"{meta['source_size'][0]}x{meta['source_size'][1]}",
        "X-Xiai-Out-Size": f"{meta['output_size'][0]}x{meta['output_size'][1]}",
        "X-Xiai-Reencode-Rounds": str(meta["reencode_rounds"]),
        "X-Xiai-Kind": params.get("kind") or "",
        "Cache-Control": "no-store",
    }
    if facts:
        headers.update(
            {
                "X-Xiai-Tiff-Pages": str(facts.get("pages")),
                "X-Xiai-Tiff-Bits-Per-Sample": ",".join(str(v) for v in (facts.get("bits_per_sample") or [])),
                "X-Xiai-Tiff-Compression": str(facts.get("compression")),
                "X-Xiai-Tiff-Photometric": str(facts.get("photometric_interpretation")),
                "X-Xiai-Tiff-Samples-Per-Pixel": str(facts.get("samples_per_pixel")),
                "X-Xiai-Tiff-Rows-Per-Strip": str(facts.get("rows_per_strip")),
                "X-Xiai-Tiff-Strips": str(facts.get("strip_count")),
                "X-Xiai-Tiff-Pinned-Ok": "true" if facts.get("pinned_all_true") else "false",
            }
        )
    return Response(content=out, media_type=meta["actual_mime"], headers=headers)


# ── 失敗形態：一切拒絕都是結構化 JSON（不得拋未捕獲異常冒充拒絕）────────────────
@app.exception_handler(XiaiError)
async def _xiai_error_handler(_request: Request, exc: XiaiError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content=exc.body())


@app.exception_handler(RequestValidationError)
async def _validation_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    err = XiaiError(INVALID_VALUE)
    return JSONResponse(status_code=err.status, content=err.body())


@app.exception_handler(StarletteHTTPException)
async def _http_error_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    if exc.status_code in (404, 405):
        # 未知路徑 / 未定義方法 ⇒ NOT_FOUND ＋ 404（沿用既有 tilesplicer 只讀中間件的錯誤面口徑）
        body = {"ok": False, "reason": NOT_FOUND, "message": "找不到這個位址或方法。"}
        return JSONResponse(status_code=404, content=body)
    err = XiaiError(STORAGE_UNAVAILABLE, status=exc.status_code)
    return JSONResponse(status_code=exc.status_code, content=err.body())


@app.exception_handler(Exception)
async def _unhandled_handler(_request: Request, exc: Exception) -> JSONResponse:
    """兜底：一切未預期異常 ⇒ **結構化** 500（零偽數據；不得以前端可見的空圖 / 佔位冒充成功）。

    ★ 規範未凍結「內部錯誤」專用字面值 ⇒ 本處複用 `STORAGE_UNAVAILABLE`（語義最接近的既有值），
      屬**表外值**（見報告 **偏差項 D2**：它不在 §3.25.10(a) 凍結 7 值之內，**已登記待裁**）——
      本單**不新增** reason 字面值（新增須走 §1.3 變更流程）。
    """
    err = XiaiError(STORAGE_UNAVAILABLE, status=500)
    return JSONResponse(status_code=500, content=err.body())
