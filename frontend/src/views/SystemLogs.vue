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
          placeholder="搜索操作、目标、来源"
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
                <small v-if="log.error">{{ displayAction(log.error) }}</small>
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
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { logsApi } from '../api/index.js'

const logs = ref([])
const loading = ref(false)
const cleaning = ref(false)
const filters = reactive({
  result: '',
  resource: '',
  keyword: ''
})
const cleanupForm = reactive({
  olderThanDays: 30
})
const resources = ['认证', '系统设置', '云账户', '域名解析账户', '域名解析管理', '云资源', '任务队列', '系统']

onMounted(() => {
  loadLogs()
})

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
  width: 220px;
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
</style>
