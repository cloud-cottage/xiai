<template>
  <div class="container ad">
    <template v-for="(b, i) in apidocBlocks" :key="i">
      <h1 v-if="b.type === 'h1'" class="ad-h1">{{ b.t }}</h1>

      <h2 v-else-if="b.type === 'h2'" class="ad-h2">{{ b.t }}</h2>

      <h3 v-else-if="b.type === 'h3'" class="ad-h3">{{ b.t }}</h3>

      <p v-else-if="b.type === 'p'" class="ad-p" :class="{ 'ad-p-strong': b.strong }">
        <Parts :v="b.parts" />
      </p>

      <div v-else-if="b.type === 'code'" class="ad-pre-wrap">
        <pre class="ad-pre"><code>{{ b.t }}</code></pre>
      </div>

      <blockquote v-else-if="b.type === 'quote'" class="ad-quote">
        <template v-for="(l, j) in b.lines" :key="j">
          <div v-if="l.kind === 'blank'" class="ad-qgap"></div>
          <div v-else-if="l.kind === 'li'" class="ad-qli"><Parts :v="l.parts" /></div>
          <div v-else class="ad-qtext"><Parts :v="l.parts" /></div>
        </template>
      </blockquote>

      <div v-else-if="b.type === 'table'" class="table-wrap ad-tbl">
        <table class="tbl">
          <thead>
            <tr>
              <th v-for="(h, j) in b.head" :key="j"><Parts :v="h" /></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, j) in b.rows" :key="j">
              <td v-for="(c, k) in r" :key="k"><Parts :v="c" /></td>
            </tr>
          </tbody>
        </table>
      </div>

      <component :is="b.type" v-else-if="b.type === 'ul' || b.type === 'ol'" class="ad-list">
        <li v-for="(it, j) in b.items" :key="j" class="ad-li">
          <Parts :v="it.parts" />
          <component :is="b.type" v-if="it.sub" class="ad-sub">
            <li v-for="(sl, k) in it.sub" :key="k" class="ad-li"><Parts :v="sl" /></li>
          </component>
          <div v-if="it.tail" class="ad-tail"><Parts :v="it.tail" /></div>
        </li>
      </component>

      <hr v-else-if="b.type === 'hr'" class="ad-hr" />
    </template>
  </div>
</template>

<script setup>
/**
 * API 文档页（营销入口 `/docs`）。
 *
 * 内容**只**来自 `@/config/apidoc.js`（结构化块数组），本页不含任何文档文本副本，
 * 也不解析 markdown：块类型（h1/h2/h3/p/code/quote/ul/ol/table/hr）与行内片段类型
 * （纯文本 / 行内代码 / 加粗）都是数据里已有的字段，模板按字段展开即可。
 * 表格渲染为真实 `table`，代码块渲染为 `pre > code`。
 */
import { h } from 'vue'
import { apidocBlocks } from '@/config/apidoc.js'

/** 行内片段 → 节点：{ t } 纯文本 · { c } 行内代码 · { b } 加粗。 */
const Parts = (props) =>
  (props.v || []).map((s, i) =>
    s.c
      ? h('code', { class: 'ad-code', key: i }, s.c)
      : s.b
        ? h('b', { class: 'ad-b', key: i }, s.b)
        : h('span', { key: i }, s.t ?? ''),
  )
Parts.props = ['v']
</script>

<style scoped>
.ad {
  padding-top: var(--sp-17);
  padding-bottom: var(--sp-19);
  font-size: var(--fs-body);
  color: var(--ink-2);
}

.ad-h1 {
  font-size: var(--fs-30);
  letter-spacing: var(--ls-3);
  color: var(--ink);
  margin: 0 0 var(--sp-3);
}

.ad-h2 {
  font-size: var(--fs-25);
  letter-spacing: var(--ls-2);
  color: var(--ink);
  margin: var(--sp-15) 0 var(--sp-6);
  padding-bottom: var(--sp-2);
  border-bottom: var(--border);
}

.ad-h3 {
  font-size: var(--fs-18);
  letter-spacing: var(--ls-2);
  color: var(--ink);
  margin: var(--sp-13) 0 var(--sp-4);
}

.ad-p {
  margin: 0 0 var(--sp-5);
  line-height: var(--lh-body);
}

.ad-p-strong {
  font-weight: bold;
  color: var(--ink);
  margin-bottom: var(--sp-3);
}

.ad-code {
  font-family: var(--font-mono);
  font-size: var(--fs-13);
  color: var(--ink);
  background: var(--panel-alt);
  border: var(--border);
  border-radius: var(--radius-sm);
  padding: 1px var(--sp-1);
  word-break: break-all;
}

.ad-pre-wrap {
  margin: 0 0 var(--sp-6);
}

.ad-pre {
  margin: 0;
  padding: var(--sp-6) var(--sp-8);
  background: var(--panel-alt);
  border: var(--border);
  border-left: var(--border-accent);
  border-radius: var(--radius);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-13);
  line-height: var(--lh-ui);
  color: var(--ink);
}

.ad-quote {
  margin: 0 0 var(--sp-6);
  padding: var(--sp-5) var(--sp-8);
  background: var(--panel-alt);
  border-left: var(--border-accent);
  border-radius: var(--radius);
  color: var(--ink-4);
  font-size: var(--fs-14);
  line-height: var(--lh-body);
}

.ad-qgap {
  height: var(--sp-2);
}

.ad-qtext {
  margin: 0;
}

.ad-qli {
  position: relative;
  padding-left: var(--sp-6);
}

.ad-qli::before {
  content: "—";
  position: absolute;
  left: 0;
  color: var(--brand);
}

.ad-tbl {
  margin: 0 0 var(--sp-6);
}

.ad-tbl table.tbl {
  min-width: 640px;
}

.ad-list {
  margin: 0 0 var(--sp-6);
  padding-left: var(--sp-11);
  line-height: var(--lh-body);
}

.ad-li {
  margin-bottom: var(--sp-2);
}

.ad-sub {
  margin: var(--sp-2) 0 0;
  padding-left: var(--sp-11);
}

.ad-tail {
  margin-top: var(--sp-2);
}

.ad-b {
  color: var(--ink);
}

.ad-hr {
  border: 0;
  border-top: var(--border);
  margin: var(--sp-15) 0;
}
</style>
