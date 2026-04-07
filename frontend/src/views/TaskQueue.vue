<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>任务队列</h1>
        <p>实时监控所有后台任务状态</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted)">
          <span :style="{ width:'8px', height:'8px', borderRadius:'50%', background: connected ? 'var(--green)' : 'var(--red)', display:'inline-block' }"></span>
          {{ connected ? '实时连接' : '已断开' }}
        </div>
        <select v-model="filterStatus" class="form-control" style="width:120px;padding:6px 10px">
          <option value="">全部状态</option>
          <option value="pending">等待中</option>
          <option value="running">运行中</option>
          <option value="done">已完成</option>
          <option value="failed">失败</option>
          <option value="cancelled">已取消</option>
        </select>
      </div>
    </div>

    <div v-if="filteredTasks.length === 0" class="card empty-state">
      <div class="empty-icon">📋</div>
      <p>暂无任务记录</p>
    </div>

    <div v-else class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>任务类型</th><th>账户</th><th>状态</th><th>进度/结果</th><th>重试次数</th><th>创建时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in filteredTasks" :key="task.id">
            <td>
              <code style="font-size:12px;background:var(--bg-input);padding:2px 8px;border-radius:4px">{{ task.type }}</code>
            </td>
            <td style="font-size:12px;color:var(--text-secondary)">{{ accountName(task.accountId) }}</td>
            <td><span :class="['badge', `badge-${task.status}`]">{{ statusLabel(task.status) }}</span></td>
            <td style="font-size:12px;color:var(--text-secondary);max-width:220px">
              <div v-if="task.status === 'running'" style="display:flex;align-items:center;gap:8px">
                <div class="spinner" style="width:12px;height:12px;border-width:1.5px"></div>
                <span>{{ task.statusMessage || '处理中...' }}</span>
              </div>
              <div v-else-if="task.status === 'done' && task.result" style="color:var(--green)">
                {{ task.result.instanceId?.slice(-10) || '成功' }}
              </div>
              <div v-else-if="task.status === 'failed'" style="color:var(--red)">{{ task.error }}</div>
              <div v-else>{{ task.statusMessage || '—' }}</div>
            </td>
            <td style="text-align:center;color:var(--text-muted)">{{ task.retries || 0 }}</td>
            <td style="font-size:11px;color:var(--text-muted)">{{ fmtDate(task.createdAt) }}</td>
            <td>
              <button
                v-if="['pending','running'].includes(task.status)"
                class="btn btn-danger btn-sm"
                @click="cancelTask(task)"
              >取消</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { tasksApi, accountsApi, getAuthToken } from '../api/index.js'

const tasks = ref([])
const accounts = ref([])
const filterStatus = ref('')
const connected = ref(false)
let sseSource = null
let reconnectTimer = null

const filteredTasks = computed(() => {
  if (!filterStatus.value) return tasks.value
  return tasks.value.filter(t => t.status === filterStatus.value)
})

onMounted(async () => {
  const r = await accountsApi.list()
  accounts.value = r.data
  connectSSE()
})

onUnmounted(() => {
  closeSSE()
})

function connectSSE() {
  const token = getAuthToken()
  if (!token) {
    connected.value = false
    return
  }

  closeSSE()
  sseSource = new EventSource(`/api/tasks/stream?token=${encodeURIComponent(token)}`)
  sseSource.onopen = () => { connected.value = true }
  sseSource.onmessage = (e) => {
    const data = JSON.parse(e.data)
    if (data.event === 'init') {
      tasks.value = data.tasks
    } else if (data.event === 'task:created') {
      tasks.value.unshift(data.task)
    } else if (data.event === 'task:updated') {
      const i = tasks.value.findIndex(t => t.id === data.task.id)
      if (i !== -1) tasks.value[i] = { ...data.task }
      else tasks.value.unshift(data.task)
    }
  }
  sseSource.onerror = () => {
    closeSSE()
    reconnectTimer = setTimeout(connectSSE, 5000)
  }
}

function closeSSE() {
  connected.value = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (sseSource) {
    sseSource.close()
    sseSource = null
  }
}

async function cancelTask(task) {
  try {
    await tasksApi.cancel(task.id)
    window.$toast?.('任务已取消', 'success')
  } catch (e) {
    window.$toast?.(e.response?.data?.error || e.message, 'error')
  }
}

function accountName(id) {
  return accounts.value.find(a => a.id === id)?.name || id?.slice(0,8) || '—'
}

function statusLabel(s) {
  return { pending:'等待中', running:'运行中', done:'已完成', failed:'失败', cancelled:'已取消' }[s] || s
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' })
}
</script>
