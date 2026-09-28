
<script setup>
/**
 * 轻量选择器（**「存入雲盤」的两处保存入口共用同一个选择器**｜v1.21 新增｜K-2）。
 *
 * 依据：规范 §3.21.4（两处保存入口 ＋ 轻量选择器 ＋ 可见反馈）＋ §3.21.11（钩子族
 * `data-drive-action` 七值）＋ §3.21.12（逐字文案表第 8 ～ 14 行）。
 * 契约：**只消费 K-1 的 `services/drive.js`**（本组件不直接 import `../data/*`，
 * 也不读写任何浏览器存储）。列表顺序即服务层给的顺序。
 *
 * 组成（恰＝ §3.21.4(d)）：**当前用户的資料夾清单（逐项可点；逐项带 `data-folder-id`）
 * ＋「新增資料夾」入口**。清单不含他人資料夾（服务层 `listMyFolders` 只返回
 * `owner_user_id` ＝ 当前用户的那些行）；**无資料夾时「新增資料夾」仍须在**（空态见下）。
 *
 * 交互纪律：
 *   - **选中即存**（§3.21.4(e)）：点选一项即完成写入，**不得再要求二次确认**；
 *   - **可见反馈（硬要求，§3.21.4(f)）**：每次点选都有可见反馈，且与写入结果一致 ——
 *     成功 / 幂等（已在夹内）/ 失败三类各有独立文案（逐字取 §3.21.12 第 11 ～ 13 行，
 *     成功与幂等两类的文案由服务层现场插值「資料夾名」后原样上屏）；
 *   - 新增資料夾：名称为空 ⇒ 「請先填寫資料夾名稱。」（§3.21.12 第 6 行）；
 *     名稱输入框旁挂**既有**一键转繁三按钮（复用 `TextTransformButtons.vue`，不另写一套）。
 *
 * 上屏文案一律繁体（`s2t(x) === x`），且**零「切分」措辞**。
 */
import { computed, ref } from 'vue'
import TextTransformButtons from './TextTransformButtons.vue'
import { drive } from '../services/index.js'

const props = defineProps({
  /** 被保存的印章编号（引用式：只传引用，**不复制印章字段**）。 */
  sealId: { type: String, required: true },
  /** 印章印文（仅用于标题旁的可读说明）。 */
  sealName: { type: String, default: '' }
})
const emit = defineEmits(['close', 'saved'])

/** 任何一次写入后 +1，使下面的派生读数立即重算（服务层读的是已落盘数据）。 */
const version = ref(0)

const listing = computed(() => {
  void version.value
  return drive.listMyFolders()
})
const folders = computed(() => (listing.value.ok ? listing.value.rows : []))
const listingDegraded = computed(() =>
  listing.value.ok ? '' : `資料夾清單暫不可用：${listing.value.message}`
)

/** 写入反馈（**三类各一句**；成功 / 幂等两类由服务层插值，失败用逐字文案）。 */
const FEEDBACK_FAIL = '存入失敗，請稍後再試。'
const feedback = ref('')
/** 反馈类别（供质检探针读稳定形状）：'' | 'ok' | 'idempotent' | 'failed'。 */
const feedbackKind = ref('')

/* ------------------------------ 新增資料夾 ------------------------------ */
const creating = ref(false)
const folderName = ref('')
const formError = ref('')

function openCreate() {
  creating.value = true
  folderName.value = ''
  formError.value = ''
  feedback.value = ''
  feedbackKind.value = ''
}

function cancelCreate() {
  creating.value = false
  folderName.value = ''
  formError.value = ''
}

function submitCreate() {
  /* 校验文案逐字（§3.21.12 第 6 行）；提交值 ＝ 用户所见的当前值（逐字，不做任何自动转换）。 */
  if (!String(folderName.value || '').trim()) {
    formError.value = '請先填寫資料夾名稱。'
    return
  }
  const result = drive.createFolder(folderName.value)
  if (!result.ok) {
    formError.value = result.message || FEEDBACK_FAIL
    return
  }
  formError.value = ''
  creating.value = false
  folderName.value = ''
  version.value += 1
  /* 新建成功也属可见反馈（可读、繁体；不静默）。 */
  feedback.value = result.message
  feedbackKind.value = 'ok'
}

/* ------------------------------ 选中即存 ------------------------------ */

/**
 * 点选一项 ⇒ **立即写入**（无二次确认）；然后**必给可见反馈**，且反馈与写入结果一致：
 *   - `created` ⇒ 成功类（`已存入「{資料夾名}」`）；
 *   - `idempotent` ⇒ 幂等类（`「{資料夾名}」中已有這枚印章。`，行数不变）；
 *   - `!ok` ⇒ 失败类（**未写入**）。
 * 三类文案的服务层取值与 §3.21.12 第 11 ～ 13 行逐字一致。
 */
function pickFolder(row) {
  const result = drive.addSealToFolder(row.id, props.sealId)
  if (!result.ok) {
    feedback.value = FEEDBACK_FAIL
    feedbackKind.value = 'failed'
    return
  }
  feedback.value = result.message
  feedbackKind.value = result.idempotent ? 'idempotent' : 'ok'
  version.value += 1
  emit('saved', result)
}

defineExpose({ feedbackKind, folders })
</script>

<template>
  <div
    class="picker-mask"
    role="dialog"
    aria-modal="true"
    aria-label="存入雲盤"
    data-drive-dialog="save-seal"
  >
    <div class="picker-box">
      <h3 class="picker-box__title">存入雲盤</h3>
      <p class="picker-box__lede">
        將印章「{{ sealName || '佚名' }}」（<span class="picker-box__code">{{ sealId }}</span>）存入資料夾；
        點選一項即完成保存。
      </p>

      <p v-if="listingDegraded" class="picker-box__degraded" data-drive-degraded="save-seal">
        {{ listingDegraded }}
      </p>

      <!-- 当前用户的資料夾清单（逐项可点、逐项带 `data-folder-id`）；**选中即存**。 -->
      <ul v-if="folders.length" class="picker-list" data-drive-folders="save-seal">
        <li v-for="row in folders" :key="row.id">
          <button
            class="picker-list__item"
            type="button"
            data-drive-action="pick-folder"
            :data-folder-id="row.id"
            @click="pickFolder(row)"
          >
            <span class="picker-list__name">{{ row.name }}</span>
            <span class="picker-list__meta">{{ row.code }}｜共 {{ row.item_count }} 枚印章</span>
          </button>
        </li>
      </ul>

      <!-- 空态（零資料夾）：文案逐字；**「新增資料夾」入口仍须在**（在下一条按钮上）。 -->
      <p v-else class="picker-box__empty" data-drive-empty="save-seal">尚無資料夾，先新增一個。</p>

      <p v-if="feedback" class="picker-box__feedback" data-drive-feedback="save-seal" :data-drive-feedback-kind="feedbackKind">
        {{ feedback }}
      </p>

      <!-- 新增資料夾（逐字标题 / 占位符 / 提交钮 / 校验；名稱旁复用既有三动作钮）。 -->
      <div v-if="creating" class="picker-create" data-drive-create="new-folder">
        <h4 class="picker-create__title">新增資料夾</h4>
        <div class="field">
          <label for="drive-folder-name">資料夾名稱</label>
          <input
            id="drive-folder-name"
            v-model="folderName"
            type="text"
            maxlength="60"
            placeholder="請輸入資料夾名稱（建議使用繁體字）"
          />
          <!-- 复用既有的一键转繁三按钮（`data-transform` 三值；不新造第二套实现、不加到提交钮）。 -->
          <TextTransformButtons
            v-model="folderName"
            field-key="drive-folder-name"
            field-label="資料夾名稱"
          />
          <span v-if="formError" class="picker-create__error">{{ formError }}</span>
        </div>
        <div class="picker-create__foot">
          <button class="btn btn--ghost" type="button" @click="cancelCreate">取消</button>
          <button class="btn btn--primary" type="button" @click="submitCreate">新增</button>
        </div>
      </div>

      <div class="picker-box__foot">
        <button
          class="btn btn--ghost"
          type="button"
          data-drive-action="new-folder"
          @click="openCreate"
        >
          新增資料夾
        </button>
        <button class="btn btn--ghost" type="button" @click="emit('close')">關閉</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
  overflow: auto;
}

.picker-box {
  width: 100%;
  max-width: 460px;
  max-height: 88vh;
  overflow: auto;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.picker-box__title {
  margin-bottom: var(--s-2);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.picker-box__lede {
  margin-bottom: var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.picker-box__code {
  color: var(--c-text);
}

.picker-box__empty {
  margin-bottom: var(--s-4);
  padding: var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.picker-box__degraded {
  margin-bottom: var(--s-3);
  color: var(--c-danger);
  font-size: var(--t-xs);
}

.picker-list {
  margin: 0 0 var(--s-4);
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.picker-list__item {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
  width: 100%;
  padding: var(--s-3);
  text-align: left;
  background: var(--c-surface-sunken);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  cursor: pointer;
  color: var(--c-text);
}

.picker-list__item:hover {
  border-color: var(--c-brand);
}

.picker-list__name {
  font-size: var(--t-md);
}

.picker-list__meta {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.picker-box__feedback {
  margin-bottom: var(--s-4);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
}

.picker-create {
  margin-bottom: var(--s-4);
  padding: var(--s-3);
  border: 1px dashed var(--c-line);
  border-radius: var(--r-md);
}

.picker-create__title {
  margin-bottom: var(--s-3);
  font-size: var(--t-md);
}

.picker-create__error {
  display: block;
  margin-top: var(--s-1);
  color: var(--c-danger);
  font-size: var(--t-xs);
}

.picker-create__foot,
.picker-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
}

.picker-create__foot {
  margin-top: var(--s-3);
}
</style>
