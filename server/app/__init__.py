"""xiai-api（读取面）· 服务骨架（P2）

本包只承担 **图像编解码面** 的两件事（规范 §3.24.3 / §3.23.6）：

  · `POST /api/image/decode` —— 源面类字节（TIFF / AVIF）⇒ 展示件（有损 WebP，质量 0.92）
  · `POST /api/image/encode` —— 位图 ⇒ 存储件（TIFF ＋ Deflate / AVIF）
  · `GET  /api/health`       —— 健康检查

**本包不含任何切分 / 几何 / 切位派生实现**（真源仍恰 1 处 ＝ `xiai/src/tilesplicer/`，
见 §3.24.6 ③(a) 与 AC-177）；读路径零回写（§3.24.3 ⑦ / AC-158）。
"""

__all__ = ["main"]
