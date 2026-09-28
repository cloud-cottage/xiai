<template>
  <div>
    <!-- ===== 01-3 Hero（文案与既有 index.html 宣传口径逐字一致） ===== -->
    <section class="hero" id="hero">
      <div class="container">
        <h1>印源・兆级玺印数字引擎</h1>
        <p>
          以结构化玺印数据基座，赋能文博展陈应用。面向博物馆、古籍与篆刻研究机构的玺印结构化数字服务平台：
          收录十万方历代玺印，配套印面、边款多视角高清影像与完整著录元数据，
          通过标准化 REST API 对外提供检索与图像调用能力，支撑学术研究、线上展厅、数字化典藏项目。
        </p>
        <div class="hero-actions">
          <a class="btn" href="#resources" @click.prevent="scrollTo('#resources')">查看资源规格</a>
          <button class="btn ghost" type="button" @click="notify">获取技术白皮书</button>
        </div>
      </div>
    </section>

    <!-- ===== 01-4 资源总览（3 卡） ===== -->
    <section class="section" id="resources">
      <div class="container">
        <h2 class="section-title">资源总览</h2>
        <p class="section-sub">体量、著录与数据库底座</p>
        <div class="grid-3">
          <article class="card">
            <h3>资源体量</h3>
            <p><strong>玺印体量</strong>：100,000 方历代玺印，远期迈向兆级规模愿景。</p>
            <p><strong>影像素材</strong>：每方玺印配套 2–4 组影像（印面、边款特写），合计约 40 万张影像。</p>
          </article>
          <article class="card">
            <h3>结构化著录</h3>
            <p><strong>印名、释文、朝代、材质、玺印类型</strong>；类型支持姓名印、闲章、吉语印、官印、鉴藏印。</p>
            <p>多维度分类检索，适配学术著录规范。</p>
          </article>
          <article class="card">
            <h3>数据库底座</h3>
            <p><strong>PostgreSQL</strong>，支持古文释文、异体字检索。</p>
            <p>内置强数据校验，保障文博著录规范。</p>
          </article>
        </div>
      </div>
    </section>

    <!-- ===== 01-5 高清图像技术方案（4 块） ===== -->
    <section class="section" id="tech">
      <div class="container">
        <h2 class="section-title">高清图像技术方案</h2>
        <p class="section-sub">归档母版与在线预览分离，母版不外发</p>
        <div class="tech-block">
          <h3>归档母版</h3>
          <ul>
            <li>TIFF G4（CCITT Group4），无损压缩，文博标准归档格式；仅用于底层存档，不对外分发。</li>
            <li>朱文两色玺印采用 TIFF 调色板格式。</li>
          </ul>
        </div>
        <div class="tech-block">
          <h3>在线预览</h3>
          <ul>
            <li>预生成无损 WebP 优先，PNG 索引 2 色兜底；HTTP 内容协商自动适配客户端浏览器，原生支持透明底。</li>
          </ul>
        </div>
        <div class="tech-block">
          <h3>图像规格</h3>
          <ul>
            <li>2 cm 见方，400PPI 双色二值图像，印文线条锐利纯净，无多余灰度噪点，满足学术研究与数字展陈标准。</li>
          </ul>
        </div>
        <div class="tech-block">
          <h3>性能优势</h3>
          <ul>
            <li>高清预览图像仅数 KB，CDN 全球分发；批量一次性加载百方玺印，瞬时完成渲染，流量开销极低。</li>
          </ul>
        </div>
      </div>
    </section>

    <!-- ===== 01-6 API 查询服务（3 卡；场景数字由配置插值） ===== -->
    <section class="section" id="api">
      <div class="container">
        <h2 class="section-title">API 查询服务</h2>
        <p class="section-sub">标准化 REST 接口，机构包量套餐</p>
        <div class="grid-3">
          <article class="card">
            <h3>多维检索</h3>
            <p>关键词、朝代、材质、玺印类型多条件联合筛选；支持释文近似相似度检索。</p>
            <p class="note mono">GET /v1/seals?dynasty=&amp;material=&amp;type=</p>
          </article>
          <article class="card">
            <h3>图像资源输出</h3>
            <p>返回 WebP / PNG 高清预览图访问地址，归档 TIFF 母本隔离保护，保障原始档案安全。</p>
            <p>
              <router-link class="btn ghost sm" to="/pricing">查看计费规则</router-link>
            </p>
          </article>
          <article class="card">
            <h3>接入与计费</h3>
            <p>
              机构月度包量套餐，典型场景：{{ scenarioText }}。
              基础月度运维服务费，超额调用单独结算。
            </p>
            <p class="note">
              「展示切片」下发的图像不计调用次数；原图下载仅在主动请求时签发，且需登录态与额度校验。
            </p>
          </article>
        </div>
      </div>
    </section>

    <!-- ===== 01-7 玺印样例预览（4 卡）+ 图片双通道轻演示（R17） ===== -->
    <section class="section" id="seals">
      <div class="container">
        <h2 class="section-title">玺印样例预览</h2>
        <p class="section-sub">图占位为纯 CSS 示意，非真实藏品影像；首张卡例外 —— 该卡走 xiai-api 真源影像三面（真源输出，非示意图）</p>
        <div class="grid-4">
          <article v-for="sample in samples" :key="sample.label" class="seal-card">
            <SlicePreview
              :asset-id="sample.assetId"
              :label="sample.label"
              :text="sample.text"
              :seal-style="sample.sealStyle"
              :sha256="sample.sha256 || ''"
            />
            <h4>{{ sample.label }}</h4>
            <div class="meta"><small>{{ sample.meta }}</small></div>
          </article>
        </div>

        <!-- §1.6「图片双通道声明」/ §7.7-R17d 防护定性（须出现且不得夸大） -->
        <NoticeBar variant="tip" title="图片双通道 · 防护定性声明">
          本页样例为<b>纯 CSS 示意</b>；未带源件摘要的卡片，其切片地址为演示占位（<code class="mono">sig=</code> 假签名、零真实请求）；
          <b>带源件摘要的首张卡为 xiai-api 真源影像三面实测</b>（经本站同源代理转发，非占位、非外链）。
          <b>展示切片为辅助防护手段，无法阻止专业爬虫抓取切片后拼接</b>；原图访问权限<b>完全由后端鉴权控制</b>
          （CDN 签名 URL + 账号额度），前端展示层不做、也无法做真实防护。
          平台侧两条通道：① <b>展示通道</b>（展示切片，仅计图片流量、不计调用次数）；
          ② <b>下载通道</b>（高清原图，仅主动请求时签发，需登录态，按账号维度每日免费额度优先抵扣、超出部分按张从充值余额扣减）。
          TIFF G4 母版仅归档不外发，与原图、切片均不等价。
        </NoticeBar>
      </div>
    </section>

    <!-- ===== 01-8 接入入口区（4 入口；按注册开关态调整） ===== -->
    <section class="section" id="contact">
      <div class="container">
        <h2 class="section-title">合作咨询</h2>
        <p class="entry-lead">
          印源面向文博机构提供平台接入服务，项目分为一次性开通部署，以及月度 API 运维套餐。
          欢迎博物馆、考古与古籍研究机构对接演示环境，获取接口文档、完整项目测算与报价。
        </p>
        <div class="modal-acts entry-acts">
          <EntryLink class="btn" to="/console/login">机构登录</EntryLink>
          <EntryLink v-if="featureFlags.registerOpen" class="btn ghost" to="/console/register">注册开通</EntryLink>
          <router-link v-else class="btn ghost" to="/demo">申请演示</router-link>
          <router-link class="btn ghost" to="/pricing">查看计费规则</router-link>
          <router-link class="btn ghost" to="/demo">申请演示环境</router-link>
          <button class="btn ghost" type="button" @click="notify">发送咨询邮件</button>
        </div>
        <p class="hint" style="text-align:center;">
          注册开关状态：{{ featureFlags.registerOpen ? '注册开放中' : '注册已暂停，请走申请演示通道' }}
          （由后台统一配置，页面不硬编码开关态）
        </p>
      </div>
    </section>

    <!-- ===== 01-9 底部声明条 + 版权行 ===== -->
    <section class="section" id="statement">
      <div class="container">
        <NoticeBar variant="disclaimer">{{ disclaimer }}</NoticeBar>
        <p class="disclaimer" style="text-align:center;margin-top:10px;">
          {{ copyrightLine }}
        </p>
        <p class="disclaimer" style="text-align:center;">
          本页数字均来自统一数据源（当前：{{ dataSourceLabel }}），页面不直接持有数据；
          演示价与包量由统一计价配置提供，改一处全站生效。
        </p>
      </div>
    </section>
  </div>
</template>

<script setup>
/**
 * 首页（spec §1.3 P-M1-01，要素 01-1 ～ 01-10）
 *
 * - 01-1 品牌头 / 01-2 行动区：`@/components/MarketingHeader.vue`（全站共用，含 5 项锚点导航与开关态行动区）
 * - 01-3 ～ 01-9：本文件；01-10 页脚：`@/components/MarketingFooter.vue`
 * - 宣传文案与既有 `shu/index.html` 逐字一致；**唯一例外**是 01-6 的典型场景数字：
 *   spec §1.3 01-6 / §4.3 要求由 `getPricingTable().scenarioText` 插值（旧「按张调取高清原图」的 v1.1 口径已退役，§7.7-R17），
 *   页面内**零金额 / 零包量 / 零额度字面量**。
 * - 01-7 的 4 张样例卡走**图片双通道轻演示**（A27 两片切片 + 前端拼接还原 + 另存门槛 + 防护定性声明）。
 */
import { computed } from 'vue'
import EntryLink from '@/components/EntryLink.vue'
import NoticeBar from '@/components/NoticeBar.vue'
import SlicePreview from '@/components/SlicePreview.vue'
import { getPricingTable, listSeals, RESOLVED_DATA_SOURCE } from '@/data'
import { DEMO_SOURCE_SHA256 } from '@/config/xiai-image-demo.js'
import { useAsync } from '@/composables/useAsync.js'
import { useAppConfig } from '@/composables/useAppConfig.js'
import { toastNotConnected } from '@/composables/useToast.js'

const { featureFlags, config } = useAppConfig()

/** 01-6 典型场景文案：由定价配置插值，页面不书写任何数字（spec §4.3）。 */
const pricing = useAsync(getPricingTable, { immediate: true })
const scenarioText = computed(
  () => pricing.data.value?.scenarioText || '包量与场景数字读取中…',
)
const disclaimer = computed(
  () => pricing.data.value?.disclaimer || '本页金额、单价、用量数字均为界面示意值，非报价',
)
const copyrightLine = computed(
  () => config.value?.site?.footerLine || '印源 © 2026 兆级玺印数字引擎｜文博玺印 API 图像服务平台',
)
const dataSource = RESOLVED_DATA_SOURCE
/** 对客口径：不暴露实现名（mock / api 为内部标识），只说明数据状态。 */
const dataSourceLabel = computed(() => (dataSource === 'api' ? '线上数据' : '演示数据'))

/**
 * 01-7 四张样例卡（标题与说明与 v1 / index.html 一致）；切片取真实种子资源的资源 ID（A25 → A27）。
 *
 * **阶段 P5c**：首张卡另带**源件摘要**（`sha256`）⇒ 该卡走 **xiai-api 影像三面**（块面 ＋ 縮略面），
 * 其余三张不带摘要 ⇒ 維持既有 A27 路徑（mock 可運行）。摘要來源與缺口登記見
 * `src/config/xiai-image-demo.js`（A26 接入後由 `assets[].sha256` 透傳替換）。
 */
const SAMPLE_DEFS = [
  { label: '白文印', text: 'XX之印', sealStyle: 'BAI_WEN', meta: '汉 · 姓名印｜白文，黑字白底', sha256: DEMO_SOURCE_SHA256 },
  { label: '朱文印', text: '长乐', sealStyle: 'ZHU_WEN', meta: '汉 · 吉语印｜朱文，红字透明底' },
  { label: '边款', text: '款识', sealStyle: 'BAI_WEN', meta: '明清 · 玺印边款影像' },
  { label: '闲章', text: '山水知己', sealStyle: 'ZHU_WEN', meta: '清 · 闲章｜朱文，红字透明底' },
]
const sealList = useAsync(() => listSeals({}, { page: 1, pageSize: SAMPLE_DEFS.length }), { immediate: true })
const samples = computed(() => SAMPLE_DEFS.map((def, i) => ({
  ...def,
  assetId: sealList.data.value?.items?.[i]?.assets?.[0]?.assetId || '',
})))

/** 站内锚点平滑滚动（不跳转、不刷新；spec §1.3 交互 1）。 */
function scrollTo(hash) {
  const el = document.querySelector(hash)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 未接入后端的按钮统一提示（spec §1.3 交互 3）。 */
function notify() {
  toastNotConnected('演示环境：该功能未接入')
}
</script>

<style scoped>
/* 版式沿用 v1 定稿（§11.1-①）；颜色一律取 tokens，不新增颜色字面量 */
.hero { padding: var(--sp-20) 0 var(--sp-19); text-align: center; }
.hero h1 { font-size: var(--fs-42); letter-spacing: var(--ls-5); margin-bottom: var(--sp-6); }
.hero p { font-size: var(--fs-17); color: var(--ink-2); max-width: 820px; margin: 0 auto; }
.hero-actions { display: flex; gap: var(--sp-5); justify-content: center; flex-wrap: wrap; margin-top: var(--sp-11); }
.tech-block {
  background: var(--card); border: var(--border); border-radius: var(--radius); padding: var(--sp-12) var(--sp-13);
}
.tech-block + .tech-block { margin-top: var(--sp-6); }
.tech-block h3 { color: var(--brand); font-size: var(--fs-18); margin-bottom: var(--sp-3); letter-spacing: var(--ls-3); }
.tech-block ul { padding-left: var(--sp-9); }
.tech-block li { margin-bottom: var(--sp-2); }
.entry-lead { text-align: center; max-width: 820px; margin: 0 auto var(--sp-12); color: var(--ink-2); }
.entry-acts { justify-content: center; }
.meta small { color: var(--faint); }
</style>
