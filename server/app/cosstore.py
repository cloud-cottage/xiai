"""xiai-api · **權威存儲的 `cos` 後端**（雲存儲桶對象面）

判據真源（與 `store.py` 同一份）：
  · §3.24.7 ①② —— 權威存儲面恰 1 處、在服務端；
  · §3.26.3 / §3.26.4 —— 原字節面 byte-verbatim、讀路徑零回寫。

本模組只做一件事：**把一個已定形的對象鍵（`xx/<sha256>.tiff`，與 local 後端同構）
在雲存儲桶上讀 / 寫 / 探活**。它**不做** TIFF 判門、**不做**上限判定、**不算** digest
—— 三步門與內容尋址真源仍在 `store.py`（本模組只收已過門的 `key` + `digest` + `data`）。

設計紀律（逐條可機械判）：
  ① **零新依賴** —— 只用標準庫（`urllib` / `hmac` / `hashlib`），簽名照 `qcloud_cos.cos_auth`
     的同一套算法（`q-sign-algorithm=sha1`，官方 SDK 默認口徑）逐行同構 ⇒ 鏡像不為此多裝一個包；
  ② **對象鍵即 `relPath`**（`<sha256[:2]>/<sha256>.tiff`）—— **與 local 後端逐字同形**，
     桶內無前綴、不另立命名空間（換後端不換鍵形 ⇒ 兩後端可互指同一件）；
  ③ **憑據只從環境變量讀**（`COS_SECRET_ID` / `COS_SECRET_KEY` / `COS_BUCKET` / `COS_REGION`，
     可選 `COS_SESSION_TOKEN`）—— **不落盤、不入倉、不回顯**；
  ④ **桶內無對象 ⇒ 與 local「無此件」同語義**：回 `store` 側的 `NOT_FOUND`（404 同形，
     **不新增 reason 字面值**）；其餘失敗一律 `STORAGE_UNAVAILABLE`（500 結構化）；
  ⑤ **讀路徑零回寫** —— `get` 只讀；`put` 只在 `store` 側判定「需寫」時才發生（冪等面在 `store.py`）。

可選環境變量（**非憑據**，僅為自測 / 兼容網關）：
  · `COS_ENDPOINT` —— 覆蓋默認端點 `https://cos.<region>.myqcloud.com`；
  · `COS_FORCE_PATH_STYLE=true` —— 改用路徑式 URL（`<endpoint>/<bucket>/<key>`），
    供本地 mock / 兼容網關自測用；默認虛擬主機式（`<bucket>.<endpoint>`）。
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from .errors import NOT_FOUND, STORAGE_UNAVAILABLE, XiaiError

# ── 憑據面（**本模組是這些變量名的唯一真源**）────────────────────────────────────
REQUIRED_ENV = ("COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET", "COS_REGION")
OPTIONAL_ENV = ("COS_SESSION_TOKEN",)
ENDPOINT_ENV = "COS_ENDPOINT"
PATH_STYLE_ENV = "COS_FORCE_PATH_STYLE"

SIGN_ALGORITHM = "sha1"          # 官方 SDK `CosS3Auth` 默認口徑
SIGN_SKEW_BACK_S = 300           # 簽名起點回撥（容時鐘偏差）
SIGN_WINDOW_S = 900              # 簽名窗口（總長 20 分鐘）
REQUEST_TIMEOUT_S = 30.0
OCTET_MIME = "application/octet-stream"
SECURITY_TOKEN_HEADER = "x-cos-security-token"


class StoreConfigError(RuntimeError):
    """`XIAI_STORE_BACKEND=cos` 但配置不全 —— **啟動即失敗**（絕不靜默回落 local）。"""


def missing_required_env() -> tuple[str, ...]:
    """回報**缺失的必需變量名**（只回名字、**永不回值**）。"""
    missing: list[str] = []
    for name in REQUIRED_ENV:
        if not (os.environ.get(name) or "").strip():
            missing.append(name)
    return tuple(missing)


def config_error() -> StoreConfigError:
    """把缺失清單拼成可讀錯誤（**只含變量名**）。"""
    missing = missing_required_env()
    return StoreConfigError(
        "XIAI_STORE_BACKEND=cos 缺少必需環境變量："
        + "、".join(missing)
        + "（必需：" + "/".join(REQUIRED_ENV)
        + "；可選：" + "/".join(OPTIONAL_ENV) + "）"
    )


# ── 配置（惰性解析一次；憑據只存在進程內存）──────────────────────────────────────
@dataclass(frozen=True)
class _Conf:
    bucket: str
    region: str
    secret_id: str
    secret_key: str
    token: str
    scheme: str
    netloc: str          # 端點主機（可帶端口）
    path_style: bool

    @property
    def host(self) -> str:
        """實際下發的 `Host` 頭（虛擬主機式 ⇒ 桶名前置；路徑式 ⇒ 端點主機）。"""
        return f"{self.bucket}.{self.netloc}" if not self.path_style else self.netloc

    def url(self, key: str) -> str:
        if self.path_style:
            return f"{self.scheme}://{self.netloc}/{self.bucket}/{key}"
        return f"{self.scheme}://{self.bucket}.{self.netloc}/{key}"


_CONF: _Conf | None = None


def _config() -> _Conf:
    global _CONF
    if _CONF is None:
        missing = missing_required_env()
        if missing:
            raise config_error()
        region = os.environ["COS_REGION"].strip()
        endpoint = (os.environ.get(ENDPOINT_ENV) or "").strip() or f"https://cos.{region}.myqcloud.com"
        parts = urllib.parse.urlsplit(endpoint)
        if not parts.scheme or not parts.netloc:
            raise StoreConfigError(f"{ENDPOINT_ENV} 形態不對（需要形如 https://cos.<region>.myqcloud.com）")
        _CONF = _Conf(
            bucket=os.environ["COS_BUCKET"].strip(),
            region=region,
            secret_id=os.environ["COS_SECRET_ID"].strip(),
            secret_key=os.environ["COS_SECRET_KEY"].strip(),
            token=(os.environ.get("COS_SESSION_TOKEN") or "").strip(),
            scheme=parts.scheme,
            netloc=parts.netloc,
            path_style=(os.environ.get(PATH_STYLE_ENV) or "").strip().lower() in ("1", "true", "yes"),
        )
    return _CONF


# ── 簽名（與官方 `qcloud_cos.cos_auth.CosS3Auth.__call__` 逐行同構）──────────────
def _quote(value: object) -> str:
    """保留字節安全集 `-_ . ~`（`/`、`:`、空格全部編碼）—— 與 SDK 同。"""
    return urllib.parse.quote(str(value), safe="-_.~")


def _authorization(conf: _Conf, method: str, path: str, headers: dict[str, str], sign_time: str) -> str:
    signed = {_quote(key.lower()): _quote(value) for key, value in headers.items()}
    header_string = "&".join(f"{key}={value}" for key, value in sorted(signed.items()))
    # format_str ＝ method\n<path>\n<query>\n<headers>\n（本面不帶 query ⇒ 第三段恆空）
    format_str = f"{method.lower()}\n{path}\n\n{header_string}\n"
    sha1 = hashlib.sha1(format_str.encode("utf-8")).hexdigest()
    str_to_sign = f"{SIGN_ALGORITHM}\n{sign_time}\n{sha1}\n"
    sign_key = hmac.new(conf.secret_key.encode("utf-8"), sign_time.encode("utf-8"), hashlib.sha1).hexdigest()
    signature = hmac.new(sign_key.encode("utf-8"), str_to_sign.encode("utf-8"), hashlib.sha1).hexdigest()
    return (
        f"q-sign-algorithm={SIGN_ALGORITHM}"
        f"&q-ak={conf.secret_id}"
        f"&q-sign-time={sign_time}"
        f"&q-key-time={sign_time}"
        f"&q-header-list={';'.join(sorted(signed.keys()))}"
        f"&q-url-param-list="
        f"&q-signature={signature}"
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不跟隨重定向（簽名只對原主機有效；重定向 ⇒ 結構化失敗，不偽造成功）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _request(conf: _Conf, method: str, key: str, data: bytes | None = None) -> tuple[int, dict[str, str], bytes]:
    """發一次已簽名請求 ⇒ `(status, headers, body)`；404 交回 404（不當異常）。

    簽名頭只覆蓋**本函數實際下發**的三個頭：`host` / `content-type`（有體時）/
    `x-cos-security-token`（有臨時憑證時）——多簽一個沒下發的頭必 403，故按實下發簽。
    """
    url = conf.url(key)
    path = urllib.parse.urlsplit(url).path
    headers: dict[str, str] = {"Host": conf.host}
    if data is not None:
        headers["Content-Type"] = OCTET_MIME
    if conf.token:
        headers[SECURITY_TOKEN_HEADER] = conf.token
    now = int(time.time())
    sign_time = f"{now - SIGN_SKEW_BACK_S};{now + SIGN_WINDOW_S}"
    headers["Authorization"] = _authorization(conf, method, path, headers, sign_time)

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with _OPENER.open(request, timeout=REQUEST_TIMEOUT_S) as response:
            body = response.read() if method != "HEAD" else b""
            return response.status, dict(response.headers), body
    except urllib.error.HTTPError as exc:          # 4xx / 5xx / 3xx（不跟隨）
        body = b""
        try:
            body = exc.read()
        except Exception:                          # pragma: no cover — 讀體失敗不覆蓋狀態碼
            body = b""
        return exc.code, dict(exc.headers or {}), body
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise XiaiError(STORAGE_UNAVAILABLE, message=f"雲存儲暫時不可用（{type(exc).__name__}）。") from exc


def _conf_error() -> XiaiError:
    """非 404 的桶側失敗 ⇒ 凍結表內的 `STORAGE_UNAVAILABLE`（500 結構化）。"""
    return XiaiError(STORAGE_UNAVAILABLE, message="雲存儲暫時無法完成這個請求，請稍後再試一次。")


# ── 三個原語（key 由 `store.py` 傳入 —— 本模組不自算鍵形）────────────────────────
def stat(key: str) -> int | None:
    """對象字節長；**桶內無對象 ⇒ `None`**（與 local「無此件」同語義）。"""
    conf = _config()
    status, headers, _ = _request(conf, "HEAD", key)
    if status == 404:
        return None
    if status != 200:
        raise _conf_error()
    raw = headers.get("Content-Length") or headers.get("content-length") or "0"
    try:
        return int(str(raw).strip())
    except ValueError as exc:
        raise XiaiError(STORAGE_UNAVAILABLE, message="雲存儲暫時無法完成這個請求，請稍後再試一次。") from exc


def get(key: str) -> bytes:
    """按鍵取回原字節；桶內無對象 ⇒ `NOT_FOUND`（404 同形，零回寫）。"""
    conf = _config()
    status, _headers, body = _request(conf, "GET", key)
    if status == 404:
        raise XiaiError(NOT_FOUND)
    if status != 200:
        raise _conf_error()
    return body


def put(key: str, data: bytes) -> None:
    """整件 PUT（COS 對象寫入原子可見：**不出半件**）。"""
    conf = _config()
    status, _headers, _body = _request(conf, "PUT", key, data=data)
    if status not in (200, 201, 204):
        raise _conf_error()


def exists(key: str) -> bool:
    return stat(key) is not None


def health_facts() -> dict:
    """`/api/health` 的 cos 側讀數（**不回報桶名 / 憑據**，只回報形狀）。"""
    conf = _config()
    return {
        "region": conf.region,
        "endpoint_scheme": conf.scheme,
        "url_style": "path-style" if conf.path_style else "virtual-hosted",
        "session_token": bool(conf.token),
        "required_env": list(REQUIRED_ENV),
        "optional_env": list(OPTIONAL_ENV),
        "atomic_write": "object PUT（單鍵整件可見；冪等判定在 store.py）",
        "read_write": "byte-verbatim（讀路徑零回寫）",
    }
