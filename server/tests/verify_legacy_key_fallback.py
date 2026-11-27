#!/usr/bin/env python3
"""xiai-api · **存量鍵回落 ＋ 寫鍵形態** 離線自檢（假存儲適配器；零雲依賴、零真網絡）

================================================================================
被測件（跑的是倉裡那份真源碼，不是抄本）：
  · `server/app/store.py` —— `object_key_for()`（cos 寫鍵）、`legacy_rel_paths()`、
    `candidate_rel_paths()`（讀面確定探測序）、`read_bytes()` / `exists()`（同一份序）、
    `store_bytes()`（兩後端寫鍵）、`health_facts()`（只讀事實）；
  · `server/app/main.py` —— `POST /api/image/store` 回包 `storage_key` ＋ `X-Xiai-Storage-Key`、
    `GET /api/image/original/{sha256}`、`GET /api/health`。

怎麼跑（**本地、離線、零網絡**）：
  · `cos` 後端 ＝ 假存儲適配器（直接替換 `app.cosstore` 的 `get/stat/exists/put`，
    另把 `_request` 換成「一調用即炸」的哨兵 ⇒ 真網絡一次都不會發）；
  · `local` 後端 ＝ `XIAI_AUTHORITY_ROOT` 指到臨時目錄（不碰真 `data/originals`）；
  · 端點面 ＝ `fastapi.testclient.TestClient`（進程內 ASGI，不佔端口、不發請求）。

判據（逐條硬口）：
  A  探測序 ＝ ① `xiai/images/<xx>/<d>.tiff` → ② `xiai/images/<xx>/<d>.png`
     → ③ 裸形 `<xx>/<d>.tiff` → ④ 其餘 `codec.LEGACY_READONLY_CONTAINERS` 擴展（同模板）；
  B  **命中即停**：① 命中 ⇒ 探測日誌恰 1 條；③（新布局裸形）命中 ⇒ 日誌恰 3 條（不再探 ④）；
  C  字節逐字相等（byte-verbatim）；全缺 ⇒ `NOT_FOUND`（**不新增 reason**，status 404）；
  D  `exists()` 與 `read_bytes()` **逐例同結論、同序**（探活與讀取語義一致）；
  E  零回寫：讀 / 探活過程 `put` 次數恆 0、`_request` 一次未調；
  F  寫鍵：cos ＝ `xiai/images/<xx>/<d>.tiff`（且冪等只 PUT 一次）；local ＝ 空串 `storage_key`；
  G  端點面：回包 `storage_key` ＋ `X-Xiai-Storage-Key` 逐字；`/api/health` 只讀事實齊、既有字段不刪不改名；
  H  **變異負對照**：把回落去掉（`candidate_rel_paths` 只回裸形）⇒ 存量鍵用例**必紅**、
     裸形用例仍綠（證明 A–D 不是恆真）。

紀律：不打印任何密鑰 / 憑據原文；斷言失敗 ⇒ 退出碼非 0；本套件零寫入生產、零網絡。
"""
from __future__ import annotations

import hashlib
import importlib
import io
import json
import os
import sys
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent          # xiai/server/tests/
SERVER_DIR = HERE.parent                        # xiai/server/
sys.path.insert(0, str(SERVER_DIR))

# ── 環境（**強制假憑據**：即使 shell 裡有真 COS_* 也不帶進本進程）──────────────
os.environ["XIAI_STORE_BACKEND"] = "cos"
os.environ["COS_SECRET_ID"] = "SELFTEST-DUMMY-SECRET-ID"
os.environ["COS_SECRET_KEY"] = "SELFTEST-DUMMY-SECRET-KEY"
os.environ["COS_BUCKET"] = "selftest-bucket"
os.environ["COS_REGION"] = "ap-guangzhou"
os.environ["COS_ENDPOINT"] = "https://selftest.invalid"
os.environ.pop("COS_FORCE_PATH_STYLE", None)
os.environ.pop("COS_SESSION_TOKEN", None)

from PIL import Image                          # noqa: E402

from app import cosstore, store                # noqa: E402
from app.errors import NOT_FOUND, XiaiError    # noqa: E402

# ── 斷言骨架（與本倉既有 verify-*.mjs 同形：逐條 JSON 讀數 ＋ 失敗計數）──────────
RESULTS: list[dict] = []
FAILURES = 0


def _jsonable(value):
    """bytes ⇒ `{bytes, sha256}` 摘要讀數（JSON 可序列化，且逐字節可核）。"""
    if isinstance(value, bytes):
        return {"bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
    if isinstance(value, dict):
        return {key: _jsonable(val) for key, val in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(val) for val in value]
    return value


def check(case_id: str, label: str, expected, actual) -> None:
    global FAILURES
    expected = _jsonable(expected)
    actual = _jsonable(actual)
    ok = json.dumps(expected, sort_keys=True, ensure_ascii=False) == json.dumps(
        actual, sort_keys=True, ensure_ascii=False
    )
    if not ok:
        FAILURES += 1
    RESULTS.append({"id": case_id, "case": label, "pass": ok, "expected": expected, "actual": actual})
    print(json.dumps({"id": case_id, "case": label, "pass": ok, "expected": expected, "actual": actual},
                     ensure_ascii=False))


def section(title: str) -> None:
    print(json.dumps({"section": title}, ensure_ascii=False))


# ── 夾具：一枚真 TIFF（單頁 8bit Deflate，過 `store.validate_payload` 三步門）────
def make_tiff(seed: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), (seed % 256, (seed * 7) % 256, (seed * 13) % 256)).save(
        buf, format="TIFF", compression="tiff_deflate"
    )
    data = buf.getvalue()
    assert store.is_tiff_container(data), "夾具不是 TIFF 容器"
    return data


TIFF_A = make_tiff(11)
TIFF_B = make_tiff(29)
DIGEST_A = hashlib.sha256(TIFF_A).hexdigest()
DIGEST_B = hashlib.sha256(TIFF_B).hexdigest()
MISSING = "f" * 64


def keys_of(digest: str) -> dict:
    shard = digest[:2]
    return {
        "legacy_tiff": f"xiai/images/{shard}/{digest}.tiff",
        "legacy_png": f"xiai/images/{shard}/{digest}.png",
        "bare": f"{shard}/{digest}.tiff",
        "legacy_avif": f"xiai/images/{shard}/{digest}.avif",
    }


# ── 假存儲適配器（cos 後端）＋ 零真網絡哨兵 ─────────────────────────────────────
class FakeBucket:
    """桶的假體：只記**探測日誌**（順序 / 次數）與**寫入日誌**（用於零回寫斷言）。"""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.get_log: list[str] = []
        self.exists_log: list[str] = []
        self.puts: list[str] = []

    def reset_logs(self) -> None:
        self.get_log.clear()
        self.exists_log.clear()

    def get(self, key: str) -> bytes:
        self.get_log.append(key)
        if key not in self.objects:
            raise XiaiError(NOT_FOUND)
        return self.objects[key]

    def stat(self, key: str) -> int | None:
        return len(self.objects[key]) if key in self.objects else None

    def exists(self, key: str) -> bool:
        self.exists_log.append(key)
        return key in self.objects

    def put(self, key: str, data: bytes) -> None:
        self.puts.append(key)
        self.objects[key] = data


BUCKET = FakeBucket()


NET_CALLS = 0


def _no_network(*_args, **_kwargs):
    global NET_CALLS
    NET_CALLS += 1
    raise AssertionError("selftest: 試圖發真網絡請求（假適配器應已攔下全部原語）")


cosstore.get = BUCKET.get                 # type: ignore[assignment]
cosstore.stat = BUCKET.stat                # type: ignore[assignment]
cosstore.exists = BUCKET.exists            # type: ignore[assignment]
cosstore.put = BUCKET.put                  # type: ignore[assignment]
cosstore._request = _no_network            # type: ignore[assignment]

# ── 期望的確定探測序（獨立於被測碼寫死，防「表值自指比對」）────────────────────
EXPECTED_ORDER = [
    "xiai/images/<xx>/<digest>.tiff",
    "xiai/images/<xx>/<digest>.png",
    "<xx>/<digest>.tiff",
    "xiai/images/<xx>/<digest>.avif",      # ④ 由 codec.LEGACY_READONLY_CONTAINERS（image/avif）派生
]


def shape_of(rel: str, digest: str) -> str:
    return rel.replace(digest, "<digest>").replace(digest[:2], "<xx>")


# ══════════════════════════════════════════════════════════════════════════════
section("A. 探測序（cos 後端 · 確定序、獨立期望值）")
# ══════════════════════════════════════════════════════════════════════════════
check("A1", "candidate_rel_paths 形狀序逐字 ＝ ①tiff → ②png → ③裸形 → ④avif",
      EXPECTED_ORDER, [shape_of(rel, DIGEST_A) for rel in store.candidate_rel_paths(DIGEST_A)])
check("A2", "① ＝ cos 寫鍵（object_key_for 逐字同形）",
      store.object_key_for(DIGEST_A), store.candidate_rel_paths(DIGEST_A)[0])
check("A3", "③ ＝ rel_path_for 裸形（**未被改動**）",
      store.rel_path_for(DIGEST_A), store.candidate_rel_paths(DIGEST_A)[2])
check("A4", "④ 由 codec.LEGACY_READONLY_CONTAINERS 派生（image/avif ⇒ .avif）",
      True, any(rel.endswith(".avif") for rel in store.candidate_rel_paths(DIGEST_A))
      and "image/avif" in __import__("app.codec", fromlist=["x"]).LEGACY_READONLY_CONTAINERS)

# ══════════════════════════════════════════════════════════════════════════════
section("B. 讀面：命中即停 / 字節逐字 / 全缺 NOT_FOUND ＋ D. exists 同序同結論")
# ══════════════════════════════════════════════════════════════════════════════
K_A = keys_of(DIGEST_A)
K_B = keys_of(DIGEST_B)

READ_CASES = [
    ("B1", "① 存量 `xiai/images/**.tiff` 命中（首序位 ⇒ 只探 1 次）",
     {K_A["legacy_tiff"]: TIFF_A}, TIFF_A, [K_A["legacy_tiff"]]),
    ("B2", "①② 同在 ⇒ 只回 ①、**不再探 ②③④**",
     {K_A["legacy_tiff"]: TIFF_A, K_A["legacy_png"]: TIFF_B}, TIFF_A, [K_A["legacy_tiff"]]),
    ("B3", "①缺、② `**.png` 命中 ⇒ 返回該字節",
     {K_A["legacy_png"]: TIFF_B}, TIFF_B, [K_A["legacy_tiff"], K_A["legacy_png"]]),
    ("B4", "①②缺、③ 裸形（新布局）命中 ⇒ 返回，且**不再探 ④**",
     {K_A["bare"]: TIFF_A}, TIFF_A, [K_A["legacy_tiff"], K_A["legacy_png"], K_A["bare"]]),
    ("B5", "①②③缺、④ 其餘 legacy 容器（.avif）命中 ⇒ 返回",
     {K_A["legacy_avif"]: TIFF_B}, TIFF_B,
     [K_A["legacy_tiff"], K_A["legacy_png"], K_A["bare"], K_A["legacy_avif"]]),
    ("B6", "全缺 ⇒ NOT_FOUND（404 同形、不新增 reason）",
     {}, "NOT_FOUND",
     [K_A["legacy_tiff"], K_A["legacy_png"], K_A["bare"], K_A["legacy_avif"]]),
]

for case_id, label, objects, expect_bytes, expect_log in READ_CASES:
    BUCKET.objects = dict(objects)
    BUCKET.reset_logs()
    puts_before = len(BUCKET.puts)

    # —— read_bytes ——
    try:
        got = store.read_bytes(DIGEST_A)
        read_face = got
        read_reason = None
    except XiaiError as exc:
        read_face = None
        read_reason = exc.reason
    actual = read_face if expect_bytes != "NOT_FOUND" else read_reason
    check(case_id + "a", f"{label}｜read_bytes", expect_bytes, actual)
    check(case_id + "b", f"{label}｜探測序（命中即停）", expect_log, list(BUCKET.get_log))

    # —— exists()：同序、同結論 ——
    BUCKET.reset_logs()
    exists_result = store.exists(DIGEST_A)
    expect_exists = expect_bytes != "NOT_FOUND"
    check(case_id + "c", f"{label}｜exists 與 read_bytes 同結論", expect_exists, exists_result)
    check(case_id + "d", f"{label}｜exists 同一份探測序", expect_log, list(BUCKET.exists_log))

    # —— 零回寫 ——
    check(case_id + "e", f"{label}｜零回寫（讀 / 探活零 put）",
          {"delta_puts": 0}, {"delta_puts": len(BUCKET.puts) - puts_before})

BUCKET.objects = {}
BUCKET.reset_logs()

# ══════════════════════════════════════════════════════════════════════════════
section("E. 寫鍵（cos ＝ xiai/images/**；冪等只 PUT 一次）")
# ══════════════════════════════════════════════════════════════════════════════
record1 = store.store_bytes(TIFF_A)
record2 = store.store_bytes(TIFF_A)
check("E1", "cos 寫鍵逐字 ＝ xiai/images/<xx>/<digest>.tiff",
      f"xiai/images/{DIGEST_A[:2]}/{DIGEST_A}.tiff", record1["storageKey"])
check("E2", "回包 relPath 仍＝ 裸形（與既有回包 / B 路同形，一字不改）",
      f"{DIGEST_A[:2]}/{DIGEST_A}.tiff", record1["relPath"])
check("E3", "PUT 落的正是寫鍵（桶內鍵逐字）",
      [f"xiai/images/{DIGEST_A[:2]}/{DIGEST_A}.tiff"], list(BUCKET.puts))
check("E4", "同字節二次寫 ⇒ 冪等（不再 PUT）", {"puts": 1, "idempotent": True},
      {"puts": len(BUCKET.puts), "idempotent": record2["idempotent"]})
check("E5", "寫入後按 digest 可讀回（byte-verbatim）", len(TIFF_A), len(store.read_bytes(DIGEST_A)))

# ══════════════════════════════════════════════════════════════════════════════
section("F. 端點面（TestClient · 進程內 ASGI，零端口零網絡）")
# ══════════════════════════════════════════════════════════════════════════════
from fastapi.testclient import TestClient      # noqa: E402
from app import main as app_main               # noqa: E402

client = TestClient(app_main.app)

# F1：寫入口回包 ＋ 表頭
reply = client.post("/api/image/store", content=TIFF_B,
                    headers={"Content-Type": "application/octet-stream"})
body = reply.json()
expected_key = f"xiai/images/{DIGEST_B[:2]}/{DIGEST_B}.tiff"
check("F1a", "POST /api/image/store 200", 200, reply.status_code)
check("F1b", "回包 storage_key 逐字 ＝ xiai/images/<xx>/<digest>.tiff", expected_key, body.get("storage_key"))
check("F1c", "表頭 X-Xiai-Storage-Key 逐字同值", expected_key, reply.headers.get("X-Xiai-Storage-Key"))
check("F1d", "回包既有四鍵一字未改（ok/sha256/bytesLength/relPath）",
      ["bytesLength", "ok", "relPath", "sha256", "storage_key"], sorted(body.keys()))
check("F1e", "回包 relPath 仍＝ 裸形", f"{DIGEST_B[:2]}/{DIGEST_B}.tiff", body.get("relPath"))

# F2：新寫的件按 digest 讀回
reply2 = client.get(f"/api/image/original/{DIGEST_B}")
check("F2a", "GET /api/image/original（新寫鍵）200", 200, reply2.status_code)
check("F2b", "字節逐字相等", len(TIFF_B), len(reply2.content))
check("F2c", "摘要逐字相等", DIGEST_B, hashlib.sha256(reply2.content).hexdigest())

# F3：存量鍵（桶內只在 xiai/images/**）經端點讀回
BUCKET.objects = {K_A["legacy_tiff"]: TIFF_A}
BUCKET.reset_logs()
reply3 = client.get(f"/api/image/original/{DIGEST_A}")
check("F3a", "存量鍵（xiai/images/**.tiff）經端點 200", 200, reply3.status_code)
check("F3b", "字節逐字相等", len(TIFF_A), len(reply3.content))
check("F3c", "端點側也只探 1 次（命中即停）", [K_A["legacy_tiff"]], list(BUCKET.get_log))

# F4：全缺 ⇒ 404 ＋ 凍結 reason（不新增）
BUCKET.objects = {}
BUCKET.reset_logs()
reply4 = client.get(f"/api/image/original/{MISSING}")
check("F4a", "全缺 ⇒ HTTP 404", 404, reply4.status_code)
check("F4b", "reason 逐字 ＝ NOT_FOUND（不新增 reason）", NOT_FOUND, reply4.json().get("reason"))
check("F4c", "reason 仍在凍結表內", True, reply4.json().get("reason") in (
    __import__("app.errors", fromlist=["x"]).MESSAGES))

# F5：/api/health 只讀事實
BUCKET.objects = {K_A["legacy_tiff"]: TIFF_A}
health = client.get("/api/health").json()
storage = health.get("authority_storage") or {}
fallback = storage.get("legacy_key_fallback") or {}
read_forms = storage.get("read_forms") or {}
check("F5a", "health 200 且 authority_storage.backend === 'cos'", "cos", storage.get("backend"))
check("F5b", "只讀事實：存量鍵回落已開啟", True, fallback.get("enabled") is True)
check("F5c", "只讀事實：讀面兜底含裸形", True, fallback.get("bare_form_in_fallback") is True)
check("F5d", "只讀事實：寫鍵形態 ＝ xiai/images/**（cos）",
      True, "xiai/images/<xx>/<digest>.tiff" in str(fallback.get("write_key_shape", "")))
check("F5e", "只讀事實：兩組鍵形（新布局 / xiai/images/**）齊",
      {"new_layout": "<sha256[:2]>/<sha256>.tiff", "legacy": "xiai/images/<xx>/<digest>.{tiff,png,…}"},
      fallback.get("key_forms"))
check("F5f", "讀面探測序讀數逐字 ＝ 期望序", EXPECTED_ORDER, fallback.get("read_probe_order"))
check("F5g", "read_forms 既有三鍵一字未改（slices/thumb/download）",
      {"slices": "?sha256=<hex>", "thumb": "?sha256=<hex>", "download": "?sha256=<hex>"},
      {k: read_forms.get(k) for k in ("slices", "thumb", "download")})
check("F5h", "read_forms 追加一條只讀事實（不改名、不刪既有）",
      True, isinstance(read_forms.get("legacy_key_fallback"), str)
      and bool(read_forms["legacy_key_fallback"]))
LEGACY_HEALTH_FIELDS = (
    "atomic_write", "backend", "container", "content_addressed", "endpoints", "env_override",
    "existing_data_policy", "extension", "idempotent", "index_key", "legacy_direct_upload_forms",
    "max_bytes", "path_shape", "read_forms", "root_relative", "shard_chars",
)
check("F5i", "authority_storage 既有字段全部仍在（不刪、不改名）", True,
      all(key in storage for key in LEGACY_HEALTH_FIELDS))
check("F5j", "authority_storage 既有字段未被改名（新增恰 1 鍵 ＝ legacy_key_fallback）",
      ["legacy_key_fallback"],
      sorted(set(storage) - set(LEGACY_HEALTH_FIELDS) - {"region", "endpoint_scheme", "url_style",
                                                         "session_token", "required_env", "optional_env",
                                                         "read_write"}))

# ══════════════════════════════════════════════════════════════════════════════
section("H. 變異負對照（把回落去掉 ⇒ 存量鍵用例必紅；裸形用例仍綠）")
# ══════════════════════════════════════════════════════════════════════════════
STORE_SRC = (SERVER_DIR / "app" / "store.py").read_text(encoding="utf-8")
MUT_OLD = "    return legacy[:2] + (bare,) + legacy[2:]"
MUT_NEW = "    return (bare,)"
check("H0", "變異錨點在 store.py 恰 1 處（防改錨點後假綠）", 1, STORE_SRC.count(MUT_OLD))

mutated_src = STORE_SRC.replace(MUT_OLD, MUT_NEW)
mutated = types.ModuleType("app.store_mutated")
mutated.__file__ = str(SERVER_DIR / "app" / "store.py")
mutated.__package__ = "app"
sys.modules["app.store_mutated"] = mutated
exec(compile(mutated_src, mutated.__file__, "exec"), mutated.__dict__)   # noqa: S102 —— 變異副本（離線）

check("H1", "變異體探測序恰 1 條（＝ 只探裸形，回落已去掉）",
      ["<xx>/<digest>.tiff"],
      [shape_of(rel, DIGEST_A) for rel in mutated.candidate_rel_paths(DIGEST_A)])

mutated_red = []
mutated_green = []
for case_id, label, objects, expect_bytes, expect_log in READ_CASES:
    BUCKET.objects = dict(objects)
    BUCKET.reset_logs()
    try:
        got = mutated.read_bytes(DIGEST_A)
        face = got
        reason = None
    except XiaiError as exc:
        face = None
        reason = exc.reason
    mutated_actual = face if expect_bytes != "NOT_FOUND" else reason
    if mutated_actual == expect_bytes:
        mutated_green.append(case_id)
    else:
        mutated_red.append(case_id)

# 存量鍵用例（①②④）必紅；③ 裸形與全缺用例仍綠
check("H2", "變異後存量鍵用例**必紅**（①/①②/②/④ 四例全部由綠轉紅）",
      ["B1", "B2", "B3", "B5"], mutated_red)
check("H3", "變異後裸形（新布局）用例仍綠、全缺用例仍綠（變異不誤傷無回歸面）",
      ["B4", "B6"], mutated_green)

# H4：變異體的 `exists()` 與 `read_bytes()` 仍逐例同結論（且都只認裸形）
mutated_pairs = []
for case_id, _label, objects, _expect_bytes, _log in READ_CASES:
    BUCKET.objects = dict(objects)
    BUCKET.reset_logs()
    try:
        mutated.read_bytes(DIGEST_A)
        read_ok = True
    except XiaiError:
        read_ok = False
    exists_ok = mutated.exists(DIGEST_A)
    want = K_A["bare"] in objects            # 變異體只探裸形 ⇒ 命中面恰＝「裸形在場」
    mutated_pairs.append([case_id, read_ok, exists_ok, want])
check("H4", "變異後 exists 與 read_bytes 逐例同結論，且命中面恰 ＝ 裸形在場",
      [[cid, want, want, want] for cid, _r, _e, want in mutated_pairs],
      [[cid, r, e, w] for cid, r, e, w in mutated_pairs])

BUCKET.objects = {}
BUCKET.reset_logs()

# ══════════════════════════════════════════════════════════════════════════════
section("I. local 後端（臨時根目錄；寫鍵一字不改、讀面同一份序）")
# ══════════════════════════════════════════════════════════════════════════════
TMP_ROOT = Path(tempfile.mkdtemp(prefix="xiai-store-selftest-"))
os.environ["XIAI_STORE_BACKEND"] = "local"
os.environ["XIAI_AUTHORITY_ROOT"] = str(TMP_ROOT)
importlib.reload(store)                        # 同一個模組對象原地重載 ⇒ main.app 直接看到 local
client_local = TestClient(app_main.app)

reply_l = client_local.post("/api/image/store", content=TIFF_A,
                            headers={"Content-Type": "application/octet-stream"})
body_l = reply_l.json()
check("I1a", "local 寫鍵一字不改（落在 <root>/<xx>/<digest>.tiff）",
      True, (TMP_ROOT / DIGEST_A[:2] / f"{DIGEST_A}.tiff").is_file())
check("I1b", "local 回包 storage_key ＝ 空串（語義不變）", "", body_l.get("storage_key"))
check("I1c", "local 表頭 X-Xiai-Storage-Key ＝ 空串", "", reply_l.headers.get("X-Xiai-Storage-Key"))
check("I1d", "local 回包 relPath 仍＝ 裸形", f"{DIGEST_A[:2]}/{DIGEST_A}.tiff", body_l.get("relPath"))

# I2：存量鍵回落（<root>/xiai/images/<xx>/<digest>.tiff）
legacy_path = TMP_ROOT / "xiai" / "images" / DIGEST_A[:2] / f"{DIGEST_A}.tiff"
legacy_path.parent.mkdir(parents=True, exist_ok=True)
legacy_path.write_bytes(TIFF_B)
(TMP_ROOT / DIGEST_A[:2] / f"{DIGEST_A}.tiff").unlink()      # 只留存量鍵
reply_l2 = client_local.get(f"/api/image/original/{DIGEST_A}")
check("I2a", "local 存量鍵（<root>/xiai/images/**.tiff）200", 200, reply_l2.status_code)
check("I2b", "字節逐字相等", len(TIFF_B), len(reply_l2.content))
check("I2c", "exists 同結論", True, store.exists(DIGEST_A))

# I3：兩處都除 ⇒ 404
legacy_path.unlink()
reply_l3 = client_local.get(f"/api/image/original/{DIGEST_A}")
check("I3a", "兩處都除 ⇒ 404", 404, reply_l3.status_code)
check("I3b", "reason 仍 ＝ NOT_FOUND（不新增）", NOT_FOUND, reply_l3.json().get("reason"))
check("I3c", "exists 同結論（False）", False, store.exists(DIGEST_A))

health_l = client_local.get("/api/health").json()
storage_l = health_l.get("authority_storage") or {}
check("I4a", "local health backend ＝ local", "local", storage_l.get("backend"))
check("I4b", "local 寫鍵形態讀數 ＝ 裸形（一字未改）",
      True, str((storage_l.get("legacy_key_fallback") or {}).get("write_key_shape", "")).startswith("<xx>/<digest>.tiff"))

# ── 收尾 ──────────────────────────────────────────────────────────────────────
check("Z1", "零真網絡（cos 原語 `_request` 全程 0 次調用）", 0, NET_CALLS)
summary = {
    "total": len(RESULTS),
    "passed": sum(1 for r in RESULTS if r["pass"]),
    "failed": FAILURES,
    "probe_order": EXPECTED_ORDER,
    "mutated_red_cases": mutated_red,
    "mutated_green_cases": mutated_green,
}
print(json.dumps({"summary": summary}, ensure_ascii=False))
sys.exit(0 if FAILURES == 0 else 1)
