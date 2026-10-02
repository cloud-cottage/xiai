"""xiai-api · 切分面（**node 薄橋 ＋ 進程內 LRU**）

判據真源：
  · §3.24.3 ① 讀取面預覽路徑（解 → 轉 WebP → **經 TileSplicer** → 通過 api 出塊；四段順序固定）；
  · §3.24.6 ② 取代條款（**切分計算落點 ＝ xiai-api 側**）＋ ③ 不變項（**真源恰 1 處**、
    塊數與形狀不變（face 4 塊 2×2 / scene 8 塊 4×2）、刀向交替、導出名凍結、切位元數據派生、跨工程邊界單向）；
  · §10.22 AC-174（預覽路徑：響應為切塊件、四段職責各可指認、塊數與真源一致、響應體內無未切分整圖）
    ＋ AC-177（真源恰 1 處、不得第二實現）＋ AC-180（展示件 ＝ 有損 WebP 0.92、質量口徑恰 1 處）；
  · §3.24.7 ③ 防泄露**（面别限定）**：**預覽／展示面**不下發源面類字節；**下載面**＝原 TIFF 字節直出。

**本模組自限（可機械檢索）**：
  ① **零幾何 / 零切位 / 零刀向 / 零塊數 / 零取整計算** —— 一行都沒有；全部由 `server/tools/geom.mjs`
     交給**同一份** `src/tilesplicer/core.js`（真源恰 1 處）；
  ② 本模組只做三件事：**驅動薄橋**、**緩存橋的產出（LRU）**、**按內核給定的矩形裁像素並編 WebP**；
  ③ 塊數 / 形狀 / 序列**一律讀自橋的產出**（`cuts` / `directions` / `ratios` / `cols` / `rows` / `tiles`），
     本模組**不寫任何塊數常量**（唯一的「面類 ⇒ 內核類別」是**名稱別名**，見下表 —— 不是幾何、不是塊數）。

★ 名稱別名（**非幾何、非塊數**；塊數仍由內核的 `SLICE_CUT_COUNTS` 決定）：
   客戶面 `kind=face` ⇒ 內核類別 `FACE`（印面族）；客戶面 `kind=scene` ⇒ 內核類別 `PHOTO`（實拍族）。
   容器自 2026-09-23 修正起**兩類統一為 TIFF** ⇒ **兩類只靠 `kind` 區分**（不再靠容器區分）。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
from collections import OrderedDict
from pathlib import Path

from PIL import Image

from . import codec
from .errors import (
    INVALID_VALUE,
    MISSING_REQUIRED,
    STORAGE_UNAVAILABLE,
    XiaiError,
)

# ── 路徑與可執行檔 ────────────────────────────────────────────────────────────
SERVER_DIR = Path(__file__).resolve().parents[1]          # server/
REPO_ROOT = SERVER_DIR.parent                             # xiai/
GEOM_SCRIPT = SERVER_DIR / "tools" / "geom.mjs"           # ★ 薄橋（只 import 內核）
KERNEL_DIR_REL = "src/tilesplicer/"
NODE_ENV_VAR = "XIAI_NODE_BIN"
BRIDGE_TIMEOUT_S = float(os.environ.get("XIAI_BRIDGE_TIMEOUT_S", "30"))
PLAN_CACHE_MAXSIZE = int(os.environ.get("XIAI_PLAN_CACHE_MAXSIZE", "64"))

# ── 名稱別名（見檔頭 ★；唯一一份，且**不含任何塊數 / 幾何值**）──────────────────
CLIENT_KIND_TO_KERNEL = {"face": "FACE", "scene": "PHOTO"}
KERNEL_KIND_TO_CLIENT = {"FACE": "face", "PHOTO": "scene", "EDGE": "face"}
CLIENT_KINDS = tuple(CLIENT_KIND_TO_KERNEL)


def kernel_kind(client_kind: str) -> str | None:
    """客戶面 `kind`（`face` / `scene`）⇒ 內核類別（`FACE` / `PHOTO`）。認不出 ⇒ `None`。"""
    return CLIENT_KIND_TO_KERNEL.get(str(client_kind or "").strip().lower())


# ── 進程內 LRU（鍵 ＝ 契約入參的完整四元組）────────────────────────────────────
class PlanLru:
    """**有界** LRU：鍵 ＝ `(assetId, kernelKind, width, height)`，值 ＝ **契約響應體原始字節**。

    · 只緩存**成功**（`ok:true`）且方法為 `GET` 的產出 —— 失敗不緩存（內核落地 / 參數修正後即刻生效）；
    · 產出是**字節**（與橋的 stdout 逐字節同一份），命中時**原樣**返回 ⇒ 響應體一致性不因緩存而變；
    · 讀數（hits / misses / evictions / entries / hit_rate）供 health 與探針取證。
    """

    def __init__(self, maxsize: int = PLAN_CACHE_MAXSIZE):
        self.maxsize = max(1, int(maxsize))
        self._lock = threading.Lock()
        self._store: OrderedDict[tuple, bytes] = OrderedDict()
        self.hits = 0
        self.misses = 0
        self.evictions = 0
        self.stores = 0

    def get(self, key: tuple) -> bytes | None:
        with self._lock:
            value = self._store.get(key)
            if value is None:
                self.misses += 1
                return None
            self._store.move_to_end(key)
            self.hits += 1
            return value

    def put(self, key: tuple, value: bytes) -> None:
        with self._lock:
            if key in self._store:
                self._store.move_to_end(key)
            self._store[key] = value
            self.stores += 1
            while len(self._store) > self.maxsize:
                self._store.popitem(last=False)
                self.evictions += 1

    def clear(self) -> None:
        with self._lock:
            self._store.clear()

    def stats(self) -> dict:
        with self._lock:
            total = self.hits + self.misses
            return {
                "maxsize": self.maxsize,
                "entries": len(self._store),
                "hits": self.hits,
                "misses": self.misses,
                "stores": self.stores,
                "evictions": self.evictions,
                "hit_rate": round(self.hits / total, 4) if total else 0.0,
            }


class BridgeReply:
    """薄橋的一次應答：`body` ＝ **stdout 原始字節**（將直接下發的那份）；`status` / `headers` 由橋如實回報。"""

    __slots__ = ("body", "status", "headers")

    def __init__(self, body: bytes, status: int = 200, headers: dict | None = None):
        self.body = body
        self.status = int(status)
        self.headers = dict(headers or {})

    def json(self):
        return json.loads(self.body.decode("utf-8"))


class NodeBridge:
    """**薄橋客戶端**：`node server/tools/geom.mjs` ⇐ stdin JSON、⇒ stdout **原始字節**。

    紀律：一切幾何 / 切位 / 塊數 / 序列都來自橋的產出；本類**不解析、不改寫、不重算**任何幾何值
    （`plan_bytes(...).body` 就是**將直接下發的字節**）。
    """

    def __init__(self, node_bin: str | None = None, script: Path | None = None):
        self.script = Path(script or GEOM_SCRIPT)
        self._node_override = node_bin or os.environ.get(NODE_ENV_VAR) or ""
        self._node_resolved: str | None = None
        self._node_version: str | None = None
        self.calls = 0
        self.failures = 0
        self.last_ms: float | None = None
        self.total_ms = 0.0
        self.lru = PlanLru()
        self._lock = threading.Lock()

    # ── 可執行檔解析（按 PATH 實測，不硬編碼）──────────────────────────────
    def node(self) -> str:
        if self._node_resolved is None:
            candidate = self._node_override or shutil.which("node") or ""
            if not candidate or not Path(candidate).exists():
                raise XiaiError(STORAGE_UNAVAILABLE)
            self._node_resolved = str(candidate)
            try:
                done = subprocess.run(
                    [self._node_resolved, "-v"], capture_output=True, text=True, timeout=10, check=False
                )
                self._node_version = (done.stdout or done.stderr or "").strip() or None
            except Exception:  # noqa: BLE001
                self._node_version = None
        return self._node_resolved

    # ── 調用面 ───────────────────────────────────────────────────────────
    @staticmethod
    def _meta_of(stderr_text: str) -> tuple[int, dict]:
        """取橋寫在 stderr 的**唯一一行**元資訊（狀態碼 ＋ 中間件自帶回應頭）。"""
        for line in reversed((stderr_text or "").splitlines()):
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and "status" in parsed:
                return int(parsed.get("status") or 200), dict(parsed.get("headers") or {})
        return 200, {}

    def invoke(self, payload: dict) -> BridgeReply:
        """跑一次橋：成功返回 `BridgeReply`（**stdout 原始字節**，不 strip、不加換行）；失敗 ⇒ 結構化 500。"""
        node = self.node()
        if not self.script.exists():
            raise XiaiError(STORAGE_UNAVAILABLE)
        started = time.perf_counter()
        try:
            done = subprocess.run(
                [node, str(self.script)],
                input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                capture_output=True,
                timeout=BRIDGE_TIMEOUT_S,
                check=False,
                cwd=str(REPO_ROOT),
            )
        except (OSError, subprocess.TimeoutExpired):
            with self._lock:
                self.calls += 1
                self.failures += 1
                self.last_ms = round((time.perf_counter() - started) * 1000, 2)
            raise XiaiError(STORAGE_UNAVAILABLE) from None
        elapsed = (time.perf_counter() - started) * 1000
        with self._lock:
            self.calls += 1
            self.last_ms = round(elapsed, 2)
            self.total_ms = round(self.total_ms + elapsed, 2)
            if done.returncode != 0 or not done.stdout:
                self.failures += 1
        if done.returncode != 0 or not done.stdout:
            # 零偽數據：橋失敗 ⇒ 結構化失敗（絕不自造一份計劃 / 一份塊）
            raise XiaiError(STORAGE_UNAVAILABLE)
        status, headers = self._meta_of(done.stderr.decode("utf-8", "replace"))
        return BridgeReply(done.stdout, status=status, headers=headers)

    def invoke_json(self, payload: dict):
        return self.invoke(payload).json()

    # ── 契約面（與前端同文件內核的產出逐字節同一份）──────────────────────
    def discovery(self, method: str = "GET") -> BridgeReply:
        """`/api/tilesplicer/v1` 的響應（由中間件本體應答；本類不重寫；方法面同樣原樣轉交）。"""
        return self.invoke({"cmd": "discovery", "method": method})

    def raw(self, method: str, path: str, query: str = "") -> BridgeReply:
        """`/api/tilesplicer/**` 下**任意**路徑的響應（含未知路徑的 404 面）—— 入參原樣轉交中間件。"""
        return self.invoke({"cmd": "raw", "method": method, "path": path, "query": query})

    def plan_bytes(
        self, asset_id, kind, width=None, height=None, method: str = "GET"
    ) -> tuple[BridgeReply, bool]:
        """`/api/tilesplicer/v1/plan?assetId=&kind=[&width=&height=]` 的響應。

        入參**原樣轉交**（缺參 / 空參 / 值域面的判定權在契約中間件 —— 本面不預判、不自造文案）。
        @returns `(BridgeReply, cache_hit)`；LRU 只緩存 **GET ＋ 入參齊備 ＋ `ok:true`** 的產出。
        """
        cacheable = (
            method.upper() == "GET"
            and isinstance(asset_id, str)
            and asset_id.strip() != ""
            and isinstance(kind, str)
            and kind.strip() != ""
            and _cache_scalar(width)
            and _cache_scalar(height)
        )
        # 鍵：`int` 形態與字符串形態**各自成鍵**（不做形態歸一 ⇒ 不引入跨形態別名風險）
        key = (
            asset_id.strip(),
            kind.strip().upper(),
            int(width) if isinstance(width, int) else str(width).strip(),
            int(height) if isinstance(height, int) else str(height).strip(),
        )
        if cacheable:
            cached = self.lru.get(key)
            if cached is not None:
                return BridgeReply(cached, status=200, headers={"content-type": "application/json; charset=utf-8"}), True
        reply = self.invoke(
            {"cmd": "plan", "assetId": asset_id, "kind": kind, "width": width, "height": height, "method": method}
        )
        if cacheable and reply.status == 200 and reply.json().get("ok") is True:
            self.lru.put(key, reply.body)
        return reply, False

    def kernel_plan_bytes(self, asset_id: str, client_kind: str, width: int, height: int) -> bytes:
        """**內核直調**（`planFor`）的 `JSON.stringify` —— 僅供對帳取證，**不入 LRU、不進響應**。"""
        return self.invoke(
            {
                "cmd": "kernel-plan",
                "assetId": asset_id,
                "kind": kernel_kind(client_kind),
                "sourceWidth": int(width),
                "sourceHeight": int(height),
            }
        ).body

    def placements(self, tiles: list[dict]) -> list[dict]:
        """拼接落位（**幾何由內核派生**）：`placementsOf` 的產出。"""
        payload = [
            {
                "canvas": tile.get("index"),          # 不透明把手 ＝ 計劃內的塊序號（值原樣回傳）
                "index": tile.get("index"),
                "x": tile["rect"]["x"],
                "y": tile["rect"]["y"],
                "width": tile["rect"]["w"],
                "height": tile["rect"]["h"],
            }
            for tile in tiles
        ]
        return self.invoke_json({"cmd": "placements", "tiles": payload})

    def kernel_info(self) -> dict:
        """內核身份與導出面清單（AC-177 取證；只讀）。"""
        return self.invoke_json({"cmd": "kernel-info"})

    def health_facts(self) -> dict:
        with self._lock:
            calls, failures = self.calls, self.failures
            last_ms, total_ms = self.last_ms, self.total_ms
        return {
            "bridge": str(self.script.relative_to(REPO_ROOT)) if self.script.is_relative_to(REPO_ROOT) else str(self.script),
            "node_bin": self._node_resolved,
            "node_version": self._node_version,
            "calls": calls,
            "failures": failures,
            "last_ms": last_ms,
            "total_ms": total_ms,
            "lru": self.lru.stats(),
        }


BRIDGE = NodeBridge()


# ── 契約面取用（供 main.py）─────────────────────────────────────────────────
def discovery(method: str = "GET") -> BridgeReply:
    """`/api/tilesplicer/v1` 的響應（**逐字節**由契約中間件產出；方法面同樣原樣轉交）。"""
    return BRIDGE.discovery(method)


def raw_reply(method: str, path: str, query: str = "") -> BridgeReply:
    """`/api/tilesplicer/**` 下任意路徑的響應（含未知路徑的 404 面）。"""
    return BRIDGE.raw(method, path, query)


def _cache_scalar(value) -> bool:
    """緩存鍵的可接受形態：`int`（本面內部調用）或**純數字字符串**（HTTP 查詢面拿到的一律是 `str`）。

    ★ 2026-09-23 修正：`/api/tilesplicer/v1/plan` 這條透傳路由把查詢值以**字符串**交進來，
    舊判定只認 `int` ⇒ 該路由的產出**從不進緩存**（LRU 實際只被切分路徑行使）。本判定放開
    「純數字字符串」這一形態（`+1024` / `1e3` / 負號等**不放行**），且**不改轉交給橋的值**
    （仍原樣透傳 ⇒ 與前端側中間件的**逐字節一致**不受影響）。
    """
    if isinstance(value, int):
        return True
    return isinstance(value, str) and value.strip().isdigit()


def plan_reply(asset_id, kind, width=None, height=None, method: str = "GET") -> tuple[BridgeReply, bool]:
    """`/api/tilesplicer/v1/plan` 的響應（入參原樣轉交；LRU 命中如實回報）。"""
    return BRIDGE.plan_bytes(asset_id, kind, width=width, height=height, method=method)


def served_plan(asset_id: str, client_kind: str, width: int, height: int) -> tuple[dict, BridgeReply, bool]:
    """取**將直接下發的**計劃：返回 `(parsed, reply, cache_hit)`；內核的結構化失敗 ⇒ 結構化拒絕。"""
    reply, hit = BRIDGE.plan_bytes(asset_id, kernel_kind(client_kind), width, height)
    parsed = reply.json()
    if parsed.get("ok") is not True:
        # 內核的結構化失敗（`NOT_FOUND` / `INVALID_ARGUMENT` / `UNKNOWN_KIND`）——
        # 本面不自造文案、不回落；一律以**結構化拒絕**收場（零偽數據）。
        raise XiaiError(INVALID_VALUE)
    return parsed, reply, hit


def cut_tiles(display_image: Image.Image, tiles: list[dict], quality: float | None = None) -> list[dict]:
    """按**內核給定的矩形**逐塊裁像素並編 WebP（**不重算任何座標**）。

    · 取整 / 邊界 / 無縫一律已由內核決定（本函數只 `crop`）；
    · 越界 / 尺寸為 0 的矩形 ⇒ 結構化拒絕（**不以白圖 / 空圖冒充**）；
    · **塊傳輸口徑**（2026-09-23 派單方裁定 · 塊邊界台階的結構性消除）：預設以**無損 WebP（VP8L）**
      輸出 —— 塊承載的內容仍是那份 **0.92 有損轉碼**的展示位圖（不再二次量化）⇒ 拼回位圖與
      整圖 0.92 解碼位圖**逐像素一致**；`quality` 顯式給值時才走有損（取證 / 對照用）。
    · 編碼走 `codec.bitmap_to_webp_lossless` / `codec.bitmap_to_webp`；**整圖展示口徑恰 1 處**
      ＝ `codec.DISPLAY_WEBP_QUALITY` 0.92（本函數不改它）。
    """
    width, height = display_image.size
    blocks: list[dict] = []
    for tile in tiles:
        rect = tile.get("rect") or {}
        x, y, w, h = int(rect.get("x", 0)), int(rect.get("y", 0)), int(rect.get("w", 0)), int(rect.get("h", 0))
        if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > width or y + h > height:
            raise XiaiError(INVALID_VALUE)
        block = display_image.crop((x, y, x + w, y + h))
        payload = (
            codec.bitmap_to_webp(block, quality) if quality is not None else codec.bitmap_to_webp_lossless(block)
        )
        if codec.sniff_mime(payload) != codec.WEBP_MIME:
            raise XiaiError(STORAGE_UNAVAILABLE)  # 自證：塊必須是真 WebP（不得冒充）
        blocks.append(
            {
                "index": int(tile.get("index", len(blocks))),
                "row": int(tile.get("row", 0)),
                "col": int(tile.get("col", 0)),
                "rect": {"x": x, "y": y, "w": w, "h": h},
                "mime": codec.WEBP_MIME,
                "container_scope": "tile-transport",
                "quality": codec.TILE_WEBP_QUALITY,
                "lossless": codec.TILE_WEBP_LOSSLESS,
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "_payload": payload,
            }
        )
    return blocks


def seam_guard(plan: dict, width: int, height: int) -> None:
    """**校驗**內核自報的無縫讀數（不重算幾何）：三條須同時為真，否則拒發切塊。

    讀數真源 ＝ 內核 `seamOf`（`plan.seam`）；本函數只做「三鍵是否皆真」＋「面積和是否等於源面積」。
    """
    seam = plan.get("seam") or {}
    ok = (
        seam.get("ok") is True
        and seam.get("areaEqualsSource") is True
        and seam.get("noOverlap") is True
        and seam.get("edgesAdjacent") is True
    )
    area = sum(int((t.get("rect") or {}).get("w", 0)) * int((t.get("rect") or {}).get("h", 0)) for t in plan.get("tiles") or [])
    if not ok or area != int(width) * int(height):
        raise XiaiError(STORAGE_UNAVAILABLE)


def require_kind(raw_kind: str | None) -> str:
    """客戶面 `kind` 的值域門（`face` / `scene`）；缺失 ⇒ `MISSING_REQUIRED`，取值不在集合 ⇒ `INVALID_VALUE`。"""
    if raw_kind is None or str(raw_kind).strip() == "":
        raise XiaiError(MISSING_REQUIRED)
    normalized = str(raw_kind).strip().lower()
    if normalized not in CLIENT_KIND_TO_KERNEL:
        raise XiaiError(INVALID_VALUE)
    return normalized


def require_asset_id(raw_asset_id: str | None) -> str:
    """切分必需 `assetId`（切位由影像 id 的摘要確定性派生 —— §3.18.4）。"""
    if raw_asset_id is None or str(raw_asset_id).strip() == "":
        raise XiaiError(MISSING_REQUIRED)
    return str(raw_asset_id).strip()


def health_facts() -> dict:
    return {
        "performed_here": True,                     # 運算落點 ＝ 本面（§3.24.6 ②）
        "kernel": KERNEL_DIR_REL,                   # 真源恰 1 處（AC-177）
        "kernel_module": f"{KERNEL_DIR_REL}core.js",
        "kernel_import": "read-only（同一份內核，經 server/tools/geom.mjs 薄橋）",
        "second_implementation": False,             # 本面零幾何 / 零切位 / 零塊數常量
        "contract_owner": f"{KERNEL_DIR_REL}server.js",
        "block_counts_source": "kernel（讀自 /api/tilesplicer/v1/plan 的 cuts / directions / cols / rows）",
        "kinds": {name: KERNEL_KIND_TO_CLIENT[name] for name in ("FACE", "PHOTO")},
        # ★ 2026-09-23 派單方裁定（塊邊界台階的結構性消除）：**塊傳輸口徑單列於此**，
        #   整圖展示口徑仍見 health.display（webp / 0.92 / lossless:false）—— 兩者不得混。
        "tile_container": codec.WEBP_MIME,
        "tile_lossless": codec.TILE_WEBP_LOSSLESS,
        "tile_quality": codec.TILE_WEBP_QUALITY,
        "tile_pipeline": "整圖編一次有損 WebP 0.92 → 解碼位圖 → 按內核幾何窗口裁塊 → 每塊無損 WebP（VP8L）",
        "tile_criterion": "拼回位圖與整圖 0.92 解碼位圖逐像素一致（max_abs_delta = 0 / identical_ratio = 1.0）",
        "display_scope_unchanged": "整圖展示口徑未改（見 health.display：webp / 0.92 / lossless:false）",
        **BRIDGE.health_facts(),
    }
