/**
 * xiai-api **影像三面**演示用的源件摘要（**缺口登記**，不在本單代裁）。
 *
 * 為何需要硬編碼一份摘要：xiai-api 三面的源字節取得形態只有兩種 ——
 * ① `?sha256=<hex>`（從服務端權威存儲按摘要取件）、② 請求載荷直傳字節。
 * yinsuo 側 A25/A26（影像資源面）在 **api 模式**下尚未接入 ⇒ **瀏覽器端拿不到源件字節**，
 * 也沒有摘要字段可透傳 ⇒ 三面演示必須以登記常量補上這一份「源件引用」。
 *
 * 登記值（**現算，逐字可復跑**）：
 *   · 摘要 ＝ xiai 服務端權威存儲裡一件演示 TIFF 的 `sha256`；
 *   · 文件形狀 ＝ `<XIAI_AUTHORITY_ROOT>/bb/<sha256>.tiff`（root 默認 `xiai/data/originals`）；
 *   · 復跑判據（只讀）：`shasum -a 256 xiai/data/originals/bb/<sha256>.tiff`（與本報文面摘要逐字一致）；
 *   · 該件實測 320×320 px / 307,511 B，`kind=face` 走內核 2 刀 / **4 塊**（塊數由真源讀取，此處不寫死）。
 *
 * **接入後改法**：把 A26 的 `assets[].sha256` 透傳進 `SlicePreview` 的 `sha256` prop，
 * 刪掉本常量，其餘不動（三面封裝與組件均不依賴此文件）。
 */
export const DEMO_SOURCE_SHA256 = 'bb82ec1d5cbfcde7ead9cd3841d58602c15634ca2b44e6597b8048479a24f238'

/** 演示用影像類別（xiai-api 客戶面值域 `face|scene`；此件為印面）。 */
export const DEMO_SOURCE_KIND = 'face'
