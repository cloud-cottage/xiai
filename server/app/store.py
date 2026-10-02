"""xiai-api · **服務端權威存儲**（內容尋址／content-addressed）

判據真源：
  · §3.24.7 ①②（權威存儲面恰 1 處、在服務端；容器一律單頁 8bit Deflate TIFF）
  · §3.22.1 五條變體口徑（單頁 8bit Deflate TIFF —— 本模組只認**容器魔數**，轉碼面仍恰 1 處 ＝ `codec.py`）
  · §3.26.3 / §3.26.4（原字節面：byte-verbatim、零轉碼、讀路徑零回寫）
  · §3.25.10(a) **xiai-api 面凍結 reason 表**（7 值；本模組**不新增任何 reason 字面值**）

落位（路徑形狀）：
    <root>/<sha256[:2]>/<sha256>.tiff
  · **默認 root** ＝ `<repo>/data/originals`（repo ＝ `xiai/`，與既有 `PROD_DB_PATH` 同源口徑：
    數據根在 `xiai/data/`）；
  · **可由環境變量覆蓋**（供測試隔離）：`XIAI_AUTHORITY_ROOT`（見 `ENV_ROOT_VAR`）；
    ⇒ 測試把 root 指向 `qa-recheck/<單號>/originals_test/` ⇒ **不污染真 `data/originals`**；
  · **行內 `sha256` 即索引鍵**（不建額外索引文件、不掃描、不遷移、不刪除既有數據）。

紀律（本模組自限，逐條可機械判）：
  ① **只收 TIFF 容器** —— 魔數 `II*\\0` / `MM\\0*`（與 `codec._is_tiff` 同簽名；**不回落、不冒充**）；
  ② **上限複用 `codec.STORED_MAX_BYTES`（4 MiB）**；輸入側 1 MB 口徑屬 `codec.MAX_INPUT_BYTES` 面；
  ③ **原子寫** —— 同目錄臨時文件 ＋ `os.replace`（同文件系統內原子 rename）⇒ 不得出現半件；
  ④ **冪等** —— 目標已存在且 size 相同（且內容 hash 相同）⇒ **不重寫**、直接返回（mtime 不變）；
  ⑤ **寫入面唯一職責** —— 落盤 ＋ 按 digest 取回；**本模組不做切分 / 幾何 / 轉碼**（真源仍恰 1 處）；
  ⑥ 失敗一律取**凍結 reason 表**內的值（空 ⇒ `EMPTY_CONTENT`；超限 ⇒ `TOO_LARGE`；
     非 TIFF ⇒ `NOT_IMAGE`；digest 形態不符 ⇒ `INVALID_VALUE`；取不到 ⇒ `NOT_FOUND`）。
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

from . import codec
from .errors import EMPTY_CONTENT, INVALID_VALUE, NOT_FOUND, NOT_IMAGE, TOO_LARGE, XiaiError

# ── 根目錄解析（默認 ＝ <repo>/data/originals；環境變量可覆蓋 —— 供測試隔離）──────────
SERVER_DIR = Path(__file__).resolve().parents[1]        # xiai/server/
REPO_ROOT = SERVER_DIR.parent                           # xiai/
ENV_ROOT_VAR = "XIAI_AUTHORITY_ROOT"                    # ← 測試隔離用的覆蓋變量名
DEFAULT_ROOT = REPO_ROOT / "data" / "originals"
DEFAULT_ROOT_REL = "data/originals"

# ── 內容尋址形狀 ────────────────────────────────────────────────────────────────
DIGEST_ALGO = "sha256"
SHARD_CHARS = 2
EXTENSION = ".tiff"
PATH_SHAPE = "<sha256[:2]>/<sha256>.tiff"
HEX_DIGITS = "0123456789abcdef"

# TIFF 容器魔數（§3.23.6 ①：`II` / `MM` / `0x2A00` / `0x002A`）—— **只認容器，不判內容**
TIFF_MAGICS = (b"II\x2a\x00", b"MM\x00\x2a")


def authority_root() -> Path:
    """權威庫根目錄：環境變量 `XIAI_AUTHORITY_ROOT` 在場時以它為準（測試隔離），否則用默認值。"""
    override = (os.environ.get(ENV_ROOT_VAR) or "").strip()
    return Path(override).expanduser() if override else DEFAULT_ROOT


def root_display() -> str:
    """根目錄的**相對形態**讀數（**本模組不對外回報絕對路徑** —— 響應體不含絕對路徑）。"""
    root = authority_root()
    try:
        return str(root.relative_to(REPO_ROOT))
    except ValueError:
        return "<root-outside-repo>"


def rel_path_for(digest: str) -> str:
    """相對路徑形狀（**索引鍵即 `sha256`**）：`<sha256[:2]>/<sha256>.tiff`。"""
    return f"{digest[:SHARD_CHARS]}/{digest}{EXTENSION}"


def path_for(digest: str) -> Path:
    return authority_root() / digest[:SHARD_CHARS] / f"{digest}{EXTENSION}"


# ── 輸入面判定（魔數 / 上限；全部取凍結 reason 表）───────────────────────────────
def is_tiff_container(data: bytes) -> bool:
    """容器判據：魔數命中 `II*\\0` 或 `MM\\0*`（8 字節頭齊備才算）。"""
    return len(data) >= 8 and bytes(data[:4]) in TIFF_MAGICS


def normalize_digest(raw: object) -> str:
    """`sha256` 引用鍵的形態判定：恰 64 位十六進制（大小寫歸一為小寫）。"""
    if raw is None:
        raise XiaiError(INVALID_VALUE)
    text = str(raw).strip().lower()
    if len(text) != 64 or any(ch not in HEX_DIGITS for ch in text):
        raise XiaiError(INVALID_VALUE)
    return text


def validate_payload(data: bytes) -> str:
    """寫入面三步門（空 → 超限 → 非 TIFF），返回 digest。**三步順序固定、可機械判**。"""
    if not data:
        raise XiaiError(EMPTY_CONTENT)
    if len(data) > codec.STORED_MAX_BYTES:
        raise XiaiError(TOO_LARGE)
    if not is_tiff_container(data):
        raise XiaiError(NOT_IMAGE)
    return hashlib.sha256(data).hexdigest()


# ── 寫入（原子 ＋ 冪等）────────────────────────────────────────────────────────
def store_bytes(data: bytes) -> dict:
    """權威落盤：`<root>/<sha256[:2]>/<sha256>.tiff`；**同目錄臨時文件 ＋ 原子 rename**。

    冪等：目標已存在、size 相同且內容 `sha256` 相同 ⇒ **不重寫**（`idempotent=True`，mtime 不變）。
    返回體**不含絕對路徑**（`relPath` 為相對形狀）。
    """
    digest = validate_payload(data)
    target = path_for(digest)
    existed = False
    idempotent = False
    mtime_ns_before: int | None = None

    if target.exists() and target.is_file():
        existed = True
        mtime_ns_before = target.stat().st_mtime_ns
        same_size = target.stat().st_size == len(data)
        same_digest = same_size and hashlib.sha256(target.read_bytes()).hexdigest() == digest
        if same_digest:
            idempotent = True          # ⑤ 冪等：一次都不重寫
    if not idempotent:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=".staging-", suffix=".tmp", dir=str(target.parent))
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_name, target)      # 同目錄 ⇒ 同文件系統 ⇒ 原子
        except BaseException:
            Path(tmp_name).unlink(missing_ok=True)
            raise

    stat = target.stat()
    return {
        "ok": True,
        "sha256": digest,
        "bytesLength": len(data),
        "relPath": rel_path_for(digest),
        "idempotent": idempotent,
        "existedBefore": existed,
        "storedBytes": stat.st_size,
        "mtimeNsBefore": mtime_ns_before,
        "mtimeNsAfter": stat.st_mtime_ns,
    }


# ── 讀取（byte-verbatim；讀路徑零回寫）─────────────────────────────────────────
def read_bytes(digest: str) -> bytes:
    """按 digest 取回權威庫原字節（**零轉碼、零回寫**）；取不到 ⇒ `NOT_FOUND`（404）。"""
    normalized = normalize_digest(digest)
    target = path_for(normalized)
    if not target.is_file():
        raise XiaiError(NOT_FOUND)
    return target.read_bytes()


def health_facts() -> dict:
    """`/api/health` 的 `authority_storage` 讀數（**只回報相對形狀**，不回報絕對路徑）。"""
    return {
        "root_relative": root_display(),
        "path_shape": PATH_SHAPE,
        "content_addressed": True,
        "index_key": DIGEST_ALGO,
        "container": codec.TIFF_MIME,
        "max_bytes": codec.STORED_MAX_BYTES,
        "shard_chars": SHARD_CHARS,
        "extension": EXTENSION,
        "atomic_write": "same-dir tempfile + os.replace",
        "idempotent": True,
        "env_override": ENV_ROOT_VAR,
        "endpoints": {"store": "/api/image/store", "original": "/api/image/original/{sha256}"},
        "read_forms": {"slices": "?sha256=<hex>", "thumb": "?sha256=<hex>", "download": "?sha256=<hex>"},
        "legacy_direct_upload_forms": "保留（既有直傳字節形態一字未破）",
        "existing_data_policy": "存量面不掃、不遷移、不刪任何件；同名同 digest 異內容 ⇒ 以真內容自愈（`os.replace` 覆寫該同名件）—— 非「不覆蓋存量」",
    }
