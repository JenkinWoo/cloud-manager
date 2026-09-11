<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>系统日志</h1>
        <p>查看登录、配置、账户和云资源操作记录。</p>
      </div>
      <div class="log-toolbar">
        <select v-model="filters.result" class="form-control toolbar-select" @change="loadLogs">
          <option value="">全部结果</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
        </select>
        <select v-model="filters.resource" class="form-control toolbar-select" @change="loadLogs">
          <option value="">全部模块</option>
          <option v-for="resource in resources" :key="resource" :value="resource">{{ resource }}</option>
        </select>
        <input
          v-model.trim="filters.keyword"
          class="form-control toolbar-keyword"
          placeholder="搜索日志 ID、操作、目标、来源"
          @keyup.enter="loadLogs"
        />
        <button class="btn btn-primary" :disabled="loading" @click="loadLogs">
          {{ loading ? '刷新中...' : '刷新' }}
        </button>
        <div class="cleanup-tools">
          <input
            v-model.number="cleanupForm.olderThanDays"
            class="form-control cleanup-input"
            type="number"
            min="1"
            max="3650"
            step="1"
            :disabled="cleaning"
            aria-label="清理多少天前日志"
          />
          <button class="btn btn-danger" :disabled="cleaning" @click="cleanupLogs">
            {{ cleaning ? '清理中...' : '清理天前日志' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="loading && logs.length === 0" class="card empty-state">
      <div class="spinner"></div>
      <p>正在加载日志</p>
    </div>

    <div v-else-if="logs.length === 0" class="card empty-state">
      <div class="empty-icon">🧾</div>
      <p>暂无系统日志</p>
    </div>

    <div v-else class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>操作者</th>
            <th>模块</th>
            <th>操作</th>
            <th>目标</th>
            <th>结果</th>
            <th>耗时</th>
            <th>来源</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in logs" :key="log.id">
            <td class="log-time">{{ fmtDate(log.createdAt) }}</td>
            <td>{{ log.operator || '—' }}</td>
            <td><span class="resource-pill">{{ displayResource(log.resource) }}</span></td>
            <td>
              <div class="action-cell">
                <span>{{ displayAction(log.action) }}</span>
                <small v-if="log.error">{{ formatValue(log.error) }}</small>
              </div>
            </td>
            <td class="target-cell">{{ displayTarget(log) }}</td>
            <td><span :class="['badge', resultClass(log.result)]">{{ resultLabel(log.result) }}</span></td>
            <td>
              <div class="duration-cell">
                <span>状态码 {{ log.statusCode }}</span>
                <span>{{ log.durationMs }} 毫秒</span>
              </div>
            </td>
            <td class="source-cell">
              {{ log.ip || '—' }}
            </td>
            <td>
              <button class="btn btn-ghost detail-button" @click="openDetails(log.id)">查看详情</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <dialog ref="detailDialog" class="log-detail-dialog" aria-labelledby="log-detail-title"
      @cancel.prevent="closeDetails" @close="resetDetails">
      <div class="modal-header">
        <h3 id="log-detail-title">日志详情</h3>
        <button class="btn btn-ghost" aria-label="关闭日志详情" autofocus @click="closeDetails">✕</button>
      </div>
      <div class="detail-body" :aria-busy="detailLoading">
        <div v-if="detailLoading" class="detail-state" role="status">正在查询日志详情…</div>
        <div v-else-if="detailError" class="detail-state" role="alert">
          <p>{{ detailError }}</p>
          <button class="btn btn-primary" @click="openDetails(selectedLogId)">重新查询</button>
        </div>
        <template v-else-if="detail">
          <dl class="detail-grid">
            <div class="detail-wide"><dt>日志 ID</dt><dd class="monospace">{{ detail.id }}</dd></div>
            <div><dt>时间</dt><dd>{{ fmtDetailDate(detail.createdAt) }}</dd></div>
            <div><dt>结果</dt><dd><span :class="['badge', resultClass(detail.result)]">{{ resultLabel(detail.result) }}</span></dd></div>
            <div><dt>操作者</dt><dd>{{ detail.operator || '未记录' }}</dd></div>
            <div><dt>模块</dt><dd>{{ displayResource(detail.resource) }}</dd></div>
            <div class="detail-wide"><dt>操作</dt><dd>{{ displayAction(detail.action) }}</dd></div>
            <div class="detail-wide"><dt>目标</dt><dd>{{ detail.target || '未记录' }}</dd></div>
            <div><dt>请求方法</dt><dd>{{ detail.method || '未记录' }}</dd></div>
            <div><dt>HTTP 状态码</dt><dd>{{ detail.statusCode ?? '未记录' }}</dd></div>
            <div class="detail-wide"><dt>请求路径</dt><dd class="monospace">{{ detail.path || '未记录' }}</dd></div>
            <div><dt>耗时</dt><dd>{{ detail.durationMs == null ? '未记录' : `${detail.durationMs} 毫秒` }}</dd></div>
            <div><dt>来源地址</dt><dd>{{ detail.ip || '未记录' }}</dd></div>
            <div class="detail-wide"><dt>客户端（User-Agent）</dt><dd>{{ detail.userAgent || '未记录' }}</dd></div>
          </dl>
          <section class="detail-section">
            <h4>错误信息</h4>
            <pre v-if="detail.error" class="detail-code error-code">{{ formatValue(detail.error) }}</pre>
            <p v-else class="detail-hint">{{ detail.result === 'failed' ? '这条日志未记录具体错误信息。' : '未记录错误。' }}</p>
          </section>
          <section v-if="detail.metadata && Object.keys(detail.metadata).length" class="detail-section">
            <h4>关联信息</h4>
            <pre class="detail-code">{{ formatValue(detail.metadata) }}</pre>
          </section>
          <details class="detail-section">
            <summary>日志 JSON</summary>
            <pre class="detail-code">{{ formatValue(detail) }}</pre>
          </details>
          <p class="detail-hint">详情展示当时已记录的信息；历史日志缺失的字段无法补回。</p>
        </template>
      </div>
      <div class="detail-footer">
        <button class="btn btn-ghost" @click="closeDetails">关闭</button>
        <button class="btn btn-primary" :disabled="!detail || detailLoading || copying" @click="copyDetails">
          {{ copying ? '复制中…' : '复制详情' }}
        </button>
      </div>
    </dialog>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { logsApi } from '../api/index.js'

const logs = ref([])
const loading = ref(false)
const cleaning = ref(false)
const detailDialog = ref(null)
const detail = ref(null)
const detailLoading = ref(false)
const detailError = ref('')
const selectedLogId = ref('')
const copying = ref(false)
let detailController
const filters = reactive({
  result: '',
  resource: '',
  keyword: ''
})
const cleanupForm = reactive({
  olderThanDays: 30
})
const resources = ['认证', '系统日志', '系统设置', '云账户', '域名解析账户', '域名解析管理', '云资源', '任务队列', '系统']

onMounted(() => {
  loadLogs()
})

onBeforeUnmount(() => {
  detailController?.abort()
})

async function openDetails(id) {
  detailController?.abort()
  const controller = new AbortController()
  detailController = controller
  selectedLogId.value = id
  detail.value = null
  detailError.value = ''
  detailLoading.value = true
  if (!detailDialog.value.open) detailDialog.value.showModal()
  try {
    const response = await logsApi.get(id, { signal: controller.signal })
    if (!controller.signal.aborted) detail.value = response.data
  } catch (error) {
    if (!controller.signal.aborted) {
      detailError.value = error.response?.data?.error || error.message || '查询日志详情失败'
    }
  } finally {
    if (!controller.signal.aborted) detailLoading.value = false
  }
}

function resetDetails() {
  detailController?.abort()
  detail.value = null
  detailLoading.value = false
  detailError.value = ''
  selectedLogId.value = ''
}

function closeDetails() {
  detailController?.abort()
  detailDialog.value?.close()
}

async function copyDetails() {
  if (!detail.value) return
  copying.value = true
  try {
    const text = formatValue(detail.value)
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      // HTTP deployments may not expose the Clipboard API. Keep the fallback
      // inside the modal so the browser's focus trap still permits selection.
      const previousFocus = document.activeElement
      const input = document.createElement('textarea')
      input.value = text
      input.style.cssText = 'position:fixed;opacity:0;pointer-events:none;'
      detailDialog.value.appendChild(input)
      try {
        input.select()
        if (!document.execCommand('copy')) throw new Error('请展开“日志 JSON”后手动选择复制')
      } finally {
        input.remove()
        previousFocus?.focus()
      }
    }
    window.$toast?.('日志详情已复制', 'success')
  } catch (_) {
    window.$toast?.('复制失败，请展开“日志 JSON”后手动选择复制', 'error')
  } finally {
    copying.value = false
  }
}

function formatValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function fmtDetailDate(value) {
  if (!value) return '未记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

async function loadLogs() {
  loading.value = true
  try {
    const response = await logsApi.list({
      result: filters.result || undefined,
      resource: filters.resource || undefined,
      keyword: filters.keyword || undefined,
      limit: 200
    })
    logs.value = response.data || []
  } catch (error) {
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    loading.value = false
  }
}

async function cleanupLogs() {
  const olderThanDays = Number(cleanupForm.olderThanDays)
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650) {
    return window.$toast?.('清理天数必须是 1 到 3650 之间的整数', 'error')
  }

  const ok = window.confirm(`确认清理 ${olderThanDays} 天前的系统日志吗？`)
  if (!ok) return

  cleaning.value = true
  try {
    const response = await logsApi.cleanup({ olderThanDays })
    window.$toast?.(`已清理 ${response.data.deleted || 0} 条系统日志`, 'success')
    await loadLogs()
  } catch (error) {
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    cleaning.value = false
  }
}

function resultClass(result) {
  return result === 'failed' ? 'badge-failed' : 'badge-done'
}

function resultLabel(result) {
  return result === 'failed' ? '失败' : '成功'
}

function displayResource(resource) {
  if (resource === 'DNS 账户') return '域名解析账户'
  if (resource === 'DNS 管理') return '域名解析管理'
  return resource || '系统'
}

function displayAction(value) {
  const text = String(value || '—')
  if (/^(POST|PUT|PATCH|DELETE)\s+\/api\//.test(text)) return '系统操作'

  return text
    .replace(/执行实例操作:\s*START/g, '执行实例启动操作')
    .replace(/执行实例操作:\s*STOP/g, '执行实例停止操作')
    .replace(/执行实例操作:\s*REBOOT/g, '执行实例重启操作')
    .replace(/执行实例操作:\s*HARD_REBOOT/g, '执行实例强制重启操作')
    .replace(/Telegram/g, '通知')
    .replace(/DNS/g, '域名解析')
    .replace(/IPv6/g, '第六版公网地址')
    .replace(/\bIP\b/g, '公网地址')
}

function displayTarget(log) {
  const target = String(log.target || '')
  if (!target) return '—'
  if (log.resource === '云资源' && looksLikeTechnicalId(target)) return '未记录名称'
  return target
}

function looksLikeTechnicalId(value) {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value) ||
    /^ocid1\./i.test(value) ||
    (value.length > 24 && /^[a-z0-9._:-]+$/i.test(value))
}

function fmtDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}
</script>

<style scoped>
.log-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.toolbar-select {
  width: 120px;
}

.toolbar-keyword {
  width: 260px;
}

.cleanup-tools {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.cleanup-input {
  width: 96px;
}

.log-time {
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 11px;
}

.resource-pill {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 2px 9px;
  color: var(--text-secondary);
  font-size: 11px;
  white-space: nowrap;
}

.action-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 150px;
}

.action-cell small {
  color: var(--red);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target-cell {
  max-width: 180px;
  color: var(--text-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.duration-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.source-cell {
  max-width: 160px;
  color: var(--text-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-state .spinner {
  margin: 0 auto 16px;
}

.detail-button {
  white-space: nowrap;
}

.log-detail-dialog {
  width: min(760px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px);
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--bg-surface);
  color: var(--text-primary);
  margin: auto;
  overflow: auto;
}

.log-detail-dialog::backdrop {
  background: rgba(0, 0, 0, 0.65);
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px 24px;
  margin: 0;
}

.detail-grid dt,
.detail-hint {
  color: var(--text-secondary);
  font-size: 12px;
}

.detail-grid dd {
  margin: 6px 0 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.detail-wide {
  grid-column: 1 / -1;
}

.monospace,
.detail-code {
  font-family: ui-monospace, Consolas, monospace;
}

.detail-section {
  margin-top: 24px;
}

.detail-section h4 {
  margin: 0 0 10px;
  font-size: 13px;
}

.detail-section summary {
  cursor: pointer;
}

.detail-code {
  padding: 14px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.7;
}

.error-code {
  color: var(--red);
}

.detail-state {
  padding: 32px 0;
  text-align: center;
}

.detail-state p {
  margin-bottom: 16px;
}

.detail-hint {
  margin-top: 16px;
}

.detail-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
}

@media (max-width: 600px) {
  .log-detail-dialog { padding: 18px; }
  .detail-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
