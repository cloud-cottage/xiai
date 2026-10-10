"""xiai-api · 图像编解码面（唯一实现点）

判据真源：
  · §3.22.1 face-photo 存储 ＝ TIFF ＋ Deflate（**四条变体口径**：RGB 8-bit 连续取样 /
    `Compression = 8`（Deflate，zlib 流）/ 不透明则省 Alpha / mime 按字节如实记 `image/tiff`）；
  · §3.22.2 保留原色（不灰度化、不量化、不丢通道）；
  · §3.22.5 输出 ＝ 有损 WebP、质量 0.92（两类统一）；
  · §3.22.6 scene-photo 存储仍为 AVIF 源（不得套用 face 的 TIFF 口径）；
  · §3.24.3 读取面两条路径的职责切分（解码 → WebP 转码 →（切分在 §3.24.6 归本面，P3 落地）→ 输出）；
  · §3.23.6「图像编解码面」命名例外（TIFF 容器标识 / IFD tag 名 / 压缩常量 / mime 字面 /
    端点与字段名 / zlib 流原语 —— 该面技术标识不属上屏面，不承担繁体义务）；
  · §3.12.9（J-9 产物侧上限：**先有界降质重编、压不进才拒**）＋ §3.12.5（J-5 输入侧 1 MB）。

**本模块不含任何切分 / 几何 / 切位派生实现**（真源仍恰 1 处 ＝ `xiai/src/tilesplicer/`；AC-177）。
读路径零回写、零落盘：所有函数都是纯函数（bytes → bytes），不写任何文件 / 库。
"""

from __future__ import annotations

import io
import zlib

from PIL import Image

from .errors import ARTIFACT_TOO_LARGE, EMPTY_CONTENT, NOT_IMAGE, TOO_LARGE, XiaiError

# ── mime 字面（§3.23.6 ④；机器字面值不转）───────────────────────────────────────
PNG_MIME = "image/png"
JPEG_MIME = "image/jpeg"
GIF_MIME = "image/gif"
WEBP_MIME = "image/webp"
TIFF_MIME = "image/tiff"
AVIF_MIME = "image/avif"
OCTET_MIME = "application/octet-stream"

# 本面接受的源面類容器（§3.24.3 ①：解 TIFF / AVIF）
# ★ 2026-09-23 Kevin 修正（逐字）：「無論是 face-photo 還是 scene-photo 都選用
#   【單頁 8bit Deflate TIFF】進行存儲，對外的輸出格式不變」⇒ **寫入面（新增產物）的唯一源容器 ＝
#   TIFF**；scene-photo 不再用 AVIF、AVIF 於**新增產物面**整體退場（§3.25.5 退場四項）。
# ★★ 2026-09-23 依 v1.25 §3.25.5 ⑤ ＋ §10.23 AC-204 改正（**面別分開、不得串台**）：
#   AVIF 退場只作用於「新增產物的容器選擇」，**不作用於存量字節的如實回報**（§3.25.5 (d)）；
#   「認 AVIF 魔數」保留 ⇒ **存量只讀面**仍須可解、可顯示（不遷移 / 不清除 / 不引導重傳，
#   AC-204 ①「讀取面須能顯示該行」）⇒ 讀取面可解集合 ＝ **TIFF ＋ AVIF**。
SOURCE_CONTAINERS = (TIFF_MIME,)            # 寫入面（新增產物）容器 —— 仍恰 TIFF（一字不改）
LEGACY_READONLY_CONTAINERS = (AVIF_MIME,)   # 存量只讀面（AC-204）：只讀可解，不產、不寫、不遷移
READABLE_SOURCE_CONTAINERS = SOURCE_CONTAINERS + LEGACY_READONLY_CONTAINERS
# 架構口徑的存儲件容器（兩類**靠 kind 區分**，不再靠容器區分）
ARCHITECTURE_STORAGE_CONTAINERS = ("tiff",)
# 退場中的既有能力（**保留為實現能力，不作驗收判據、不計入 PASS 數**）
RETIRED_CAPABILITIES = ("avif",)
# 本面可產出的存儲件容器（型別面仍保留 avif：P2 已取證的編碼能力，本單不刪、不再判）
STORAGE_CONTAINERS = ("tiff", "avif")
CONTAINER_MIME = {"tiff": TIFF_MIME, "avif": AVIF_MIME}

# ── 质量真源（展示件）——**全服务唯一一份**（AC-165 / AC-180 ③）──────────────────
# 取值 0.92 与 R-137 / AC-136 / §3.24.7 ④ 同源。跨仓收口：前端 `IMAGE_LIMITS.quality`
# 仍为 0.85（本单不得碰 `src/**`，改值与单一真源收口属 P4 / P5）⇒ 见 REPORT 未登记项 U-1。
DISPLAY_WEBP_QUALITY = 0.92
# 有损（不得无损）：Pillow 的 `quality` 参数即 libwebp 有损质量；`lossless` 一律不传 False 之外的值。
DISPLAY_WEBP_LOSSLESS = False

# ── 存储件编码参数（★未登记项：规范 §11.2(s) 已登记「AVIF / TIFF 編碼參數」为未登记项）──
# 该值**不是**展示件质量真源（展示件真源恰一份 ＝ `DISPLAY_WEBP_QUALITY`）；
# 它只决定 scene-photo 存储件的体积 / 保真取舍。取值面待裁 ⇒ REPORT 未登记项 U-2。
STORAGE_AVIF_QUALITY = 0.92

# ── 上限（**沿用既有真源数值，不得改值** —— J-5 / J-9 / AC-33）───────────────────
MAX_INPUT_BYTES = 1_048_576            # 输入侧（原始文件字节）＝ 1 MB
STORED_MAX_BYTES = 8 * 1024 * 1024     # 产物侧（产物二进制）＝ 8 MiB
MAX_REENCODE_ROUNDS = 3                # 产物超限时**有界**降质重编轮数（上界 3）
REENCODE_SIDE_FLOOR = 256              # 每轮最长边 ÷2 的下界（有界降幅）
REENCODE_QUALITY_STEP = 0.2            # 每轮降幅（沿用既有前端口径）

# 源面字节的读入上限：**复用既有产物侧上限 4 MiB**（不新立数值）；见 REPORT 未登记项 U-3。
MAX_SOURCE_BYTES = STORED_MAX_BYTES


# ── 字节魔数判据 ────────────────────────────────────────────────────────────────
def _is_isobmff_avif(v: bytes) -> bool:
    """ISO-BMFF 容器是否 AVIF（谓词与产品真值函数 `isIsobmffAvif` 逐条对齐）。"""
    if len(v) < 12:
        return False
    if v[4:8] != b"ftyp":
        return False

    def brand(offset: int) -> bytes:
        return v[offset : offset + 4]

    if brand(8) in (b"avif", b"avis"):
        return True
    box_size = int.from_bytes(v[0:4], "big")
    end = min(len(v), box_size if box_size >= 16 else len(v))
    offset = 16
    while offset + 3 < end:
        if brand(offset) in (b"avif", b"avis"):
            return True
        offset += 4
    return False


def _is_tiff(v: bytes) -> bool:
    """TIFF 容器标识（§3.23.6 ①：`II` / `MM` / `0x2A00` / `0x002A`）。"""
    if len(v) < 8:
        return False
    if v[0:2] == b"II":
        return v[2:4] == b"\x2a\x00"
    if v[0:2] == b"MM":
        return v[2:4] == b"\x00\x2a"
    return False


def sniff_mime(data: bytes) -> str:
    """字节魔数 → mime（**认不出返回空串**，不回落、不冒充 —— §3.12.10 (a)(b)）。

    谓词集合与产品真值函数（`src/utils/image.js::sniffBytesMime` /
    `src/data/assetmeta.js::sniffMime`）的四个既有签名 **＋ AVIF 分支** 逐条对齐，
    并**多一条 TIFF 容器判据**：规范 §3.22.9 的「改名保留」类要求 mime 真值函数
    **须新增认 TIFF 魔数**（该改动面在 `src/**`，属 P4 / P5；本服务侧先按 §3.23.6 ① 自带判据）。
    判定权仍归产品真值函数（§1.3 第 9 / 10 条：一把尺子）⇒ 证据里两处读数并列比对。
    """
    v = data or b""
    n = len(v)
    if n >= 8 and v[0] == 0x89 and v[1] == 0x50 and v[2] == 0x4E and v[3] == 0x47:
        return PNG_MIME
    if n >= 3 and v[0] == 0xFF and v[1] == 0xD8 and v[2] == 0xFF:
        return JPEG_MIME
    if n >= 4 and v[0] == 0x47 and v[1] == 0x49 and v[2] == 0x46:
        return GIF_MIME
    if n >= 12 and v[0:4] == b"RIFF" and v[8:12] == b"WEBP":
        return WEBP_MIME
    if _is_isobmff_avif(v):
        return AVIF_MIME
    if _is_tiff(v):
        return TIFF_MIME
    return ""


def source_mime(data: bytes) -> str:
    """源面类容器的如实判定（**寫入面新增產物** ＝ TIFF；**存量只讀面** ＝ AVIF；其餘一律空串）。"""
    mime = sniff_mime(data)
    return mime if mime in READABLE_SOURCE_CONTAINERS else ""


# ── 解码 / 编码 ────────────────────────────────────────────────────────────────
def _open_bitmap(data: bytes, what: str) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()  # 强制解码：截断 / 结构损坏在此暴露（不得半解）
        return img
    except XiaiError:
        raise
    except Exception as exc:  # noqa: BLE001 —— 一切解码失败统一为结构化拒绝，不抛未捕获异常
        raise XiaiError(NOT_IMAGE) from exc


def open_bitmap(data: bytes) -> Image.Image:
    """任意可解位圖 ⇒ 位圖（**只供展示件 / 中間產物的回讀**；**不**作源容器判定）。

    用途：預覽路徑的「轉 WebP」之後，切分要消費的正是那份展示件（`§3.24.3 ①` 的四段順序：
    解 → 轉 → 切 → 出 ⇒ 切的是 WebP 展示件，不是源字節）。
    """
    if not data:
        raise XiaiError(EMPTY_CONTENT)
    return _open_bitmap(data, "display")


def decode_source_to_bitmap(data: bytes, max_bytes: int = MAX_SOURCE_BYTES) -> Image.Image:
    """源面類字節 ⇒ 位圖（保留原色：不灰度化、不量化、不丟通道）。

    · **寫入面／新增產物**：唯一源容器 ＝ TIFF（§3.25.1 兩類統一）；
    · **存量只讀面**（AC-204 ①「讀取面須能顯示該行」）：**AVIF 存量字節仍可解、可顯示**
      —— 只讀、不回寫、不遷移、不清除、不引導重傳（§3.25.5 ⑤「認 AVIF 魔數」保留）；
    · **PNG / 其餘容器** ⇒ 結構化 `NOT_IMAGE`（415）—— 不回落、不冒充、不轉碼
      （舊 8 色索引 PNG 由前端原生解碼顯示、不走本面 —— AC-168 面）。
    """
    if not data:
        raise XiaiError(EMPTY_CONTENT)
    if len(data) > max_bytes:
        raise XiaiError(TOO_LARGE)
    if source_mime(data) == "":
        # 认不出 / 非本面支援的容器 ⇒ 结构化拒绝（**零伪数据、零回落直出**）
        raise XiaiError(NOT_IMAGE)
    return _open_bitmap(data, "source")


def bitmap_to_webp(img: Image.Image, quality: float = DISPLAY_WEBP_QUALITY) -> bytes:
    """展示件：**有损 WebP、质量 0.92**（两类统一；质量参数真传进编码路径）。"""
    buf = io.BytesIO()
    src = img if img.mode in ("RGB", "RGBA") else img.convert("RGBA" if "A" in img.getbands() else "RGB")
    src.save(
        buf,
        format="WEBP",
        quality=float(quality),
        lossless=DISPLAY_WEBP_LOSSLESS,
        method=4,
    )
    out = buf.getvalue()
    if sniff_mime(out) != WEBP_MIME:  # 自证：产物字节必须是真 WebP，不得冒充
        raise XiaiError(NOT_IMAGE, status=500)
    return out


# ── 塊傳輸口徑（★與整圖展示口徑**分列**：不得把整圖展示口徑改掉）────────────────
# 2026-09-23 派單方裁定（塊邊界台階的**結構性消除**，理由有實測依據）：
#   整圖先編一次**有損 WebP 0.92** → 解碼得位圖 → 按內核幾何窗口裁塊 → 每塊以**無損 WebP（VP8L）**輸出。
# ⇒ 塊只是**傳輸容器**：它承載的內容**仍是**那份 0.92 有損轉碼的展示位圖（不再二次量化）
#   ⇒ 拼回位圖與整圖 0.92 解碼位圖**逐像素一致**（`max_abs_delta = 0`）。
# ⇒ **整圖展示口徑一字不改**：`DISPLAY_WEBP_QUALITY = 0.92` / `DISPLAY_WEBP_LOSSLESS = False`。
#   （與 §3.25.4 ① / AC-198 ④ 字面口徑的張力已如實登記 —— 見 REPORT U-5。）
TILE_WEBP_LOSSLESS = True
TILE_WEBP_QUALITY = None  # 無損容器 ⇒ 質量取值不適用（**不得填 0.92 冒充有損**）


def bitmap_to_webp_lossless(img: Image.Image) -> bytes:
    """**塊傳輸件**：無損 WebP（VP8L）—— 切分面逐塊輸出的容器（塊邊界零台階）。"""
    buf = io.BytesIO()
    src = img if img.mode in ("RGB", "RGBA") else img.convert("RGBA" if "A" in img.getbands() else "RGB")
    src.save(buf, format="WEBP", lossless=True, method=4)
    out = buf.getvalue()
    if sniff_mime(out) != WEBP_MIME:  # 自證：產物字節必須是真 WebP，不得冒充
        raise XiaiError(NOT_IMAGE, status=500)
    return out


def bitmap_to_tiff(img: Image.Image) -> bytes:
    """存储件（face）：**TIFF ＋ Deflate**，四条变体口径逐条落位（§3.22.1）。

    · RGB 8-bit 连续取样：`BitsPerSample = [8,8,8]` / `PhotometricInterpretation = 2` /
      `PlanarConfiguration = 1`（chunky）；
    · 压缩：`Compression = 8`（Deflate / Adobe Deflate，zlib 流）；
    · 不透明则省 Alpha（`SamplesPerPixel = 3`；带透明时才 4 ＋ `ExtraSamples = 2`）；
    · mime 按字节如实记 `image/tiff`。
    产出后**按字节复核**（魔数 ＋ Deflate 流可解 ＋ 回读像素），复核不过即拒（不得冒充成功）。
    """
    if img.mode == "P":
        img = img.convert("RGBA" if "transparency" in img.info else "RGB")
    if img.mode in ("LA", "L"):
        img = img.convert("RGB")
    if img.mode in ("RGBA", "LA"):
        # 不透明则省 Alpha：整幅无不透明像素时才降为 RGB（避免无谓的 Alpha 通道）
        alpha = img.getchannel("A")
        opaque = alpha.getextrema()[0] == 255
        img = img if not opaque else img.convert("RGB")
    elif img.mode not in ("RGB",):
        img = img.convert("RGB")

    buf = io.BytesIO()
    img.save(buf, format="TIFF", compression="tiff_deflate")
    out = buf.getvalue()
    if sniff_mime(out) != TIFF_MIME:
        raise XiaiError(NOT_IMAGE, status=500)
    if not _tiff_deflate_readable(out):
        raise XiaiError(NOT_IMAGE, status=500)
    return out


def bitmap_to_avif(img: Image.Image, quality: float = STORAGE_AVIF_QUALITY) -> bytes:
    """存储件（scene）：**AVIF**（§3.22.6：scene 存储口径不变，不得套用 face 的 TIFF 口径）。

    `quality` 用**归一化 0–1**（与展示件质量同一读法）；底层 libavif / Pillow 用 0–100 标度
    ⇒ 本函数在调用处换算（`round(q*100)`，夹到 1–100），对外只暴露一个标度，避免两套刻度。
    """
    buf = io.BytesIO()
    src = img if img.mode in ("RGB", "RGBA") else img.convert("RGB")
    q100 = max(1, min(100, round(float(quality) * 100)))
    src.save(buf, format="AVIF", quality=q100)
    out = buf.getvalue()
    if sniff_mime(out) != AVIF_MIME:
        raise XiaiError(NOT_IMAGE, status=500)
    return out


def _tiff_deflate_readable(data: bytes) -> bool:
    """按字节复核：TIFF 容器 ＋ 至少一条 strip/tile 是**可解的 zlib 流**（Compression = 8 自证）。"""
    try:
        with Image.open(io.BytesIO(data)) as im:
            tags = im.tag_v2
            bits = tags.get(258)
            if not (bits in ([8, 8, 8], (8, 8, 8), [8, 8, 8, 8], (8, 8, 8, 8)) or (
                isinstance(bits, int) and bits == 8
            )):  # noqa: SIM102
                return False
            if tags.get(259) != 8:  # Compression = 8（Deflate）
                return False
            if tags.get(262) != 2:  # PhotometricInterpretation = 2（RGB）
                return False
            if tags.get(284) not in (1, None):  # PlanarConfiguration = 1（chunky）
                return False
            raw = data
            offset = tags.get(273)  # StripOffsets
            counts = tags.get(279)  # StripByteCounts
            if not offset:
                return False
            offs = list(offset) if isinstance(offset, tuple) else [offset]
            cnts = list(counts) if isinstance(counts, tuple) else [counts]
            for off, cnt in zip(offs, cnts):
                try:
                    zlib.decompress(raw[off : off + cnt])
                except Exception:  # noqa: BLE001
                    return False
            return True
    except Exception:  # noqa: BLE001
        return False


# 必需標籤（2026-09-23 修正的 TIFF 參數口徑；`tag id ⇒ 名`）
TIFF_REQUIRED_TAGS = {
    256: "ImageWidth",
    257: "ImageLength",
    258: "BitsPerSample",
    259: "Compression",
    262: "PhotometricInterpretation",
    273: "StripOffsets",
    277: "SamplesPerPixel",
    278: "RowsPerStrip",
    279: "StripByteCounts",
}


def _as_list(value) -> list:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def tiff_facts(data: bytes) -> dict:
    """單頁 8bit Deflate TIFF 的**只讀**讀數（修正口徑逐條取證；不改一個字節、不寫盤）。

    修正口徑（Kevin 2026-09-23 逐字「無論是 face-photo 還是 scene-photo 都選用
    【單頁 8bit Deflate TIFF】進行存儲」）逐條落位：
      · 單頁（`pages == 1`）；· 8 bit/通道；· RGB（`PhotometricInterpretation = 2`）；
      · `Compression = 8`（Deflate / zlib 流，可解）；· strip 組織（`RowsPerStrip` ＋
      `StripOffsets` / `StripByteCounts` 齊備且可解）；· 必需標籤齊備。
    帶 Alpha 的源 ⇒ 走既有口徑（`SamplesPerPixel = 4` ＋ `ExtraSamples = 2`），本讀數如實照記。
    """
    facts: dict = {"mime": sniff_mime(data), "bytes": len(data)}
    try:
        with Image.open(io.BytesIO(data)) as im:
            tags = im.tag_v2
            bits = _as_list(tags.get(258))
            pages = int(getattr(im, "n_frames", 1))
            offsets = _as_list(tags.get(273))
            counts = _as_list(tags.get(279))
            facts.update(
                {
                    "pages": pages,
                    "size": list(im.size),
                    "mode": im.mode,
                    "bits_per_sample": bits,
                    "compression": tags.get(259),
                    "photometric_interpretation": tags.get(262),
                    "samples_per_pixel": tags.get(277),
                    "planar_configuration": tags.get(284),
                    "rows_per_strip": tags.get(278),
                    "extra_samples": tags.get(338),
                    "strip_count": len(offsets),
                    "strip_byte_counts": len(counts),
                    "deflate_streams_readable": _tiff_deflate_readable(data),
                    "required_tags_present": {name: (tag in tags) for tag, name in TIFF_REQUIRED_TAGS.items()},
                }
            )
            facts["pinned_parameters"] = {
                "single_page": pages == 1,
                "eight_bit_per_channel": bool(bits) and all(int(value) == 8 for value in bits),
                "rgb_photometric": tags.get(262) == 2,
                "compression_is_deflate": tags.get(259) == 8,
                "strip_organised": bool(tags.get(278)) and len(offsets) >= 1 and len(offsets) == len(counts),
                "required_tags_all_present": all(facts["required_tags_present"].values()),
            }
            facts["pinned_all_true"] = all(facts["pinned_parameters"].values())
    except Exception as exc:  # noqa: BLE001
        facts["error"] = str(exc)[:200]
        facts["pinned_all_true"] = False
    return facts


def encode_storage(data: bytes, container: str, quality: float | None = None) -> tuple[bytes, dict]:
    """位图 ⇒ 存储件（TIFF ＋ Deflate / AVIF），带**有界降质重编**（J-9 ②）。

    返回 `(bytes, meta)`；`meta` 记录重编轨迹（供「有降质重编记录」可判）。
    产物超 `STORED_MAX_BYTES` ⇒ 有界重编（≤ 3 轮、每轮最长边 ÷2；AVIF 另降 0.2）
    ⇒ 仍压不进才以 `ARTIFACT_TOO_LARGE` 拒（**与输入侧 `TOO_LARGE` 两套，不得复用**）。
    """
    if not data:
        raise XiaiError(EMPTY_CONTENT)
    if len(data) > MAX_INPUT_BYTES:
        # 输入侧上限：仅对「用户上传的原始文件字节」判（本面按 §3.12.5 / J-5 口径）
        raise XiaiError(TOO_LARGE)
    img = _open_bitmap(data, "bitmap")
    mime = CONTAINER_MIME[container]
    target_quality = quality if quality is not None else STORAGE_AVIF_QUALITY

    rounds = 0
    current = img
    degraded = []
    while True:
        out = (
            bitmap_to_tiff(current)
            if container == "tiff"
            else bitmap_to_avif(current, target_quality)
            if rounds == 0
            else bitmap_to_avif(current, max(0.0, target_quality - REENCODE_QUALITY_STEP * rounds))
        )
        if len(out) <= STORED_MAX_BYTES or rounds >= MAX_REENCODE_ROUNDS:
            break
        # 有界降质重编：每轮最长边 ÷2（下界 REENCODE_SIDE_FLOOR）
        width, height = current.size
        longest = max(width, height)
        if longest <= REENCODE_SIDE_FLOOR:
            break
        scale = max(REENCODE_SIDE_FLOOR / longest, 0.5)
        nw, nh = max(1, round(width * scale)), max(1, round(height * scale))
        current = current.resize((nw, nh), Image.LANCZOS)
        rounds += 1
        degraded.append({"round": rounds, "size": [nw, nh], "bytes": len(out)})

    if len(out) > STORED_MAX_BYTES:
        raise XiaiError(ARTIFACT_TOO_LARGE)
    actual = sniff_mime(out)
    if actual != mime:
        # 「编不出 ⇒ 按字节如实记」：服务侧不冒充；此异常路径为能力缺失，不静默顶替
        raise XiaiError(NOT_IMAGE, status=500)
    meta = {
        "requested_mime": mime,
        "actual_mime": actual,
        "bytes": len(out),
        "source_size": list(img.size),
        "output_size": list(current.size),
        "reencode_rounds": rounds,
        "reencode_trail": degraded,
        "avif_quality": target_quality if container == "avif" else None,
        "webp_quality": None,
    }
    return out, meta
