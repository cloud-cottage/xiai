"""xiai-api · 失败形态与冻结 reason 字面值

判据真源：
  · 规范 §3.12.10(c) 及其表下注（v1.5 / v1.6 / v1.7 追加）—— **reason 字面值冻结表**；
  · 规范 §3.23.4（结构化失败 · 零伪数据 · 零回落直出）；
  · 规范 §10.21 AC-157 / §10.22 AC-184（失败形态）＋ AC-162（message 不泄漏内部标识）。

纪律（本模块自限，逐条可机械判）：
  ① 一切拒绝须为**结构化拒绝** —— 形状 `{ok:false, reason, message}`；
     **不得抛未捕获异常冒充拒绝**（§3.12.10 (e)⑥ / §10.8 v1.6 修正注）；
  ② **本模块不新增任何 reason 字面值** —— 全部取值来自既有冻结集合
     （§3.12.10(c) 表 ＋ 既有 tilesplicer 中间件已用的传输层三值）。
     新增 reason 须走 §1.3 变更流程 ⇒ 本单不做；
  ③ `message` 一律为**可读繁體**（须 `s2t(x) === x`；检测器 ＝ `src/utils/traditional.js::toTraditionalText`），
     且**不得泄漏内部标识**：内部字段名 / IFD tag 名 / 压缩常量 / 端点路径 / 端口数值（§3.23.4 ④ / AC-162）。
"""

# ── 内容面（§3.12.10(c) 冻结表）────────────────────────────────────────────────
# 数据层内部值：本服务**不对外使用**（两层不得互相冒充）。
UNRECOGNIZED_IMAGE = "UNRECOGNIZED_IMAGE"
# 对外面（服务层）唯一「认不出 / 影像无效」值。
NOT_IMAGE = "NOT_IMAGE"
EMPTY_CONTENT = "EMPTY_CONTENT"
TOO_LARGE = "TOO_LARGE"                    # 仅输入侧（原始文件字节超上限）
ARTIFACT_TOO_LARGE = "ARTIFACT_TOO_LARGE"  # 仅产物侧；与 TOO_LARGE 不得互相复用
MISSING_REQUIRED = "MISSING_REQUIRED"      # 必填缺失面
INVALID_FIELD = "INVALID_FIELD"            # 字段面（多给了不该给的键）
INVALID_VALUE = "INVALID_VALUE"            # 值域面（值不在允许集合内）
STORAGE_UNAVAILABLE = "STORAGE_UNAVAILABLE"  # 存储失败 / 服务不可用兜底

# ── 传输层面（沿用既有 tilesplicer 只读中间件已用的字面值，不另立）──────────────
NOT_FOUND = "NOT_FOUND"  # 未知路径 / 未定义方法（既有先例：src/tilesplicer/server.js）

# 可读繁體文案（无简体、无内部标识；逐条经产品 s2t 检测器验证见 REPORT 取证 §9）
MESSAGES = {
    NOT_IMAGE: "這份內容不是可用的圖片，或格式不在本面支援的範圍內（本面只處理 TIFF，另可讀取既有的 AVIF）。",
    EMPTY_CONTENT: "沒有收到任何內容，請重新選擇檔案再試一次。",
    TOO_LARGE: "所選檔案過大，已超過單檔上限，請換一張較小的圖。",
    ARTIFACT_TOO_LARGE: "本機影像生成失敗：處理後的圖片仍超過產物上限，與輸入檔案的上限是兩回事，請換一張再試。",
    MISSING_REQUIRED: "缺少必要的參數，請補齊後再試一次。",
    INVALID_FIELD: "請求中含有不接受的欄位，請確認後再試一次。",
    INVALID_VALUE: "某個參數的取值不在允許的範圍內，請確認後再試一次。",
    STORAGE_UNAVAILABLE: "服務暫時無法完成這個請求，請稍後再試一次。",
    NOT_FOUND: "找不到這個位址或方法。",
}

# reason ⇒ 默认 HTTP 码（可机械比对；证据里逐例给原始读数）
DEFAULT_STATUS = {
    NOT_IMAGE: 415,
    EMPTY_CONTENT: 400,
    TOO_LARGE: 413,
    ARTIFACT_TOO_LARGE: 413,
    MISSING_REQUIRED: 400,
    INVALID_FIELD: 400,
    INVALID_VALUE: 400,
    STORAGE_UNAVAILABLE: 500,
    NOT_FOUND: 404,
}


class XiaiError(Exception):
    """结构化失败（`{ok:false, reason, message}`）——**不得**以未捕获异常冒充拒绝。"""

    def __init__(self, reason: str, status: int | None = None, message: str | None = None):
        if reason not in MESSAGES:  # 冻结纪律：不在集合内 ⇒ 编程错误（不是可接受的拒绝形态）
            raise AssertionError(f"reason not in frozen set: {reason!r}")
        self.reason = reason
        self.status = int(status if status is not None else DEFAULT_STATUS.get(reason, 500))
        self.message = message or MESSAGES[reason]
        super().__init__(f"{reason}: {self.message}")

    def body(self) -> dict:
        return {"ok": False, "reason": self.reason, "message": self.message}
