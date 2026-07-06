<template>
  <router-view v-if="isPublicRoute" />

  <template v-else>
    <nav class="sidebar">
      <div>
        <div class="sidebar-brand">
          <span class="brand-icon">☁️</span>
          <div class="brand-copy">
            <span class="brand-text">云管理平台</span>
            <button
              class="brand-version"
              type="button"
              :class="{ 'brand-version-update': versionInfo.updateAvailable }"
              @click.stop="toggleVersionPopover"
            >
              v{{ displayVersion }}
              <span v-if="versionInfo.updateAvailable" class="brand-update-dot"></span>
            </button>
          </div>

          <div v-if="versionPopoverOpen" class="version-popover" @click.stop>
            <div class="version-popover-header">
              <span>{{ versionInfo.updateAvailable ? '发现新版本' : '当前版本' }}</span>
              <button
                class="version-refresh"
                type="button"
                :disabled="versionChecking"
                title="刷新版本检查"
                @click="checkVersion({ manual: true })"
              >
                ↻
              </button>
            </div>

            <div class="version-popover-body">
              <div class="version-main">
                v{{ versionInfo.updateAvailable ? versionInfo.latest : displayVersion }}
                <span :class="['version-status-dot', versionInfo.updateAvailable ? 'version-status-new' : 'version-status-ok']">
                  {{ versionInfo.updateAvailable ? '!' : '✓' }}
                </span>
              </div>
              <div class="version-status-text">
                {{ versionStatusText }}
              </div>
              <div v-if="versionInfo.updateAvailable" class="version-current">
                当前版本 v{{ displayVersion }}
              </div>
            </div>

            <button
              v-if="versionInfo.updateAvailable"
              class="version-update-button"
              type="button"
              :disabled="!versionInfo.updateSupported || versionUpdating"
              @click="triggerUpdate"
            >
              {{ versionUpdateButtonText }}
            </button>

            <div v-if="versionUpdating" class="version-progress">
              <div class="version-progress-meta">
                <span>{{ versionProgressText }}</span>
                <span>{{ versionUpdateProgress }}%</span>
              </div>
              <div class="version-progress-track">
                <div class="version-progress-bar" :style="{ width: `${versionUpdateProgress}%` }"></div>
              </div>
            </div>

            <a
              class="version-release-link"
              :href="versionInfo.releaseUrl"
              target="_blank"
              rel="noreferrer"
            >
              GitHub 查看发布
            </a>
          </div>
        </div>

        <div class="nav-section">
          <div class="nav-label">概览</div>
          <router-link to="/" class="nav-item">
            <span>📊</span> 仪表盘
          </router-link>
        </div>

        <div class="nav-section">
          <div class="nav-label">管理</div>
          <router-link to="/accounts" class="nav-item">
            <span>👤</span> 账户管理
          </router-link>
          <router-link to="/cloud" class="nav-item">
            <span>☁️</span> 云实例
          </router-link>
          <router-link to="/cloud-monitor" class="nav-item">
            <span>📡</span> 云流量统计
          </router-link>
          <router-link to="/dns" class="nav-item">
            <span>🌐</span> DNS 管理
          </router-link>
        </div>

        <div class="nav-section">
          <div class="nav-label">系统</div>
          <router-link to="/tasks" class="nav-item">
            <span>⚙️</span> 任务队列
            <span v-if="pendingCount > 0" class="nav-badge">{{ pendingCount }}</span>
          </router-link>
          <router-link to="/logs" class="nav-item">
            <span>🧾</span> 系统日志
          </router-link>
          <router-link to="/settings" class="nav-item">
            <span>🔧</span> 系统设置
          </router-link>
        </div>
      </div>

      <div class="sidebar-user">
        <div class="sidebar-user-meta">
          <div class="sidebar-user-name">{{ authState.user?.username || 'admin' }}</div>
          <div class="sidebar-user-hint">{{ authState.user?.mustChangePassword ? '需要修改密码' : '已登录' }}</div>
        </div>
        <button class="btn btn-ghost sidebar-logout" @click="handleLogout">退出登录</button>
      </div>
    </nav>

    <main class="main-content">
      <router-view />
    </main>
  </template>

  <div class="toast-container">
    <div v-for="t in toasts" :key="t.id" :class="['toast', `toast-${t.type}`]">
      {{ t.message }}
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getAuthToken, versionApi } from './api/index.js'
import { authState, initAuth, logout } from './auth.js'

const route = useRoute()
const router = useRouter()
const pendingCount = ref(0)
const toasts = ref([])
const appVersion = __APP_VERSION__
const versionInfo = ref({
  current: appVersion,
  latest: null,
  updateAvailable: false,
  updateSupported: false,
  updateMode: '',
  releaseUrl: 'https://github.com/JenkinWoo/cloud-manager/releases',
  error: null
})
const versionPopoverOpen = ref(false)
const versionChecking = ref(false)
const versionUpdating = ref(false)
const versionUpdateProgress = ref(0)
const versionProgressText = ref('')
const isPublicRoute = computed(() => Boolean(route.meta.public))
const displayVersion = computed(() => versionInfo.value.current || appVersion)
const versionStatusText = computed(() => {
  if (versionUpdating.value) return '正在触发自动更新'
  if (versionChecking.value) return '正在检查更新'
  if (versionInfo.value.error) return '暂时无法检查更新'
  if (versionInfo.value.updateAvailable) return `最新版本 v${versionInfo.value.latest} 可用`
  return '已是最新版本'
})
const versionUpdateButtonText = computed(() => {
  if (versionUpdating.value) return '正在更新...'
  if (!versionInfo.value.updateSupported) return '未配置自动更新'
  return '立即更新并重启'
})
let sseSource = null
let versionProgressTimer = null

onMounted(() => {
  initAuth()
  window.addEventListener('click', closeVersionPopover)
})

onUnmounted(() => {
  closeSSE()
  stopVersionProgress()
  window.removeEventListener('click', closeVersionPopover)
})

watch(
  () => authState.authenticated,
  (authenticated) => {
    if (authenticated && !isPublicRoute.value) {
      connectSSE()
      checkVersion()
    } else closeSSE()
  },
  { immediate: true }
)

watch(isPublicRoute, (publicRoute) => {
  if (publicRoute) closeSSE()
  else if (authState.authenticated) {
    connectSSE()
    checkVersion()
  }
})

async function checkVersion(options = {}) {
  versionChecking.value = true
  try {
    const response = await versionApi.get()
    versionInfo.value = {
      current: response.data.current || appVersion,
      latest: response.data.latest,
      updateAvailable: Boolean(response.data.updateAvailable),
      updateSupported: Boolean(response.data.updateSupported),
      updateMode: response.data.updateMode || '',
      releaseUrl: response.data.releaseUrl || versionInfo.value.releaseUrl,
      error: response.data.error || null
    }

    if (versionInfo.value.updateAvailable) {
      const seenKey = `cloud-manager-update-${versionInfo.value.latest}`
      if (options.manual || sessionStorage.getItem(seenKey) !== 'seen') {
        versionPopoverOpen.value = true
        sessionStorage.setItem(seenKey, 'seen')
      }
    }
  } catch (_) {
    versionInfo.value = {
      current: appVersion,
      latest: null,
      updateAvailable: false,
      updateSupported: false,
      updateMode: '',
      releaseUrl: versionInfo.value.releaseUrl,
      error: 'version-check-failed'
    }
  } finally {
    versionChecking.value = false
  }
}

function toggleVersionPopover() {
  versionPopoverOpen.value = !versionPopoverOpen.value
}

function closeVersionPopover() {
  versionPopoverOpen.value = false
}

async function triggerUpdate() {
  if (versionUpdating.value || !versionInfo.value.updateAvailable || !versionInfo.value.updateSupported) return

  versionUpdating.value = true
  startVersionProgress()
  try {
    const response = await versionApi.update()
    const reloadDelayMs = response.data.status === 'watching' ? 90000 : 30000
    startVersionProgress(reloadDelayMs)
    setVersionProgress(30, response.data.status === 'watching' ? '等待自动更新检查' : '更新请求已发送')
    showToast(
      response.data.status === 'watching'
        ? `正在等待自动更新到 v${response.data.latest}，服务稍后会自动重启`
        : `正在更新到 v${response.data.latest}，服务稍后会自动重启`,
      'success'
    )
    setTimeout(() => {
      setVersionProgress(100, '正在刷新页面')
      window.location.reload()
    }, reloadDelayMs)
  } catch (error) {
    const detail = error.response?.data?.detail
    const message = error.response?.data?.error || error.message || '更新触发失败'
    showToast(detail ? `${message}: ${detail}` : message, 'error')
    stopVersionProgress()
    versionUpdating.value = false
  }
}

function setVersionProgress(progress, text) {
  versionUpdateProgress.value = Math.max(versionUpdateProgress.value, Math.min(progress, 100))
  versionProgressText.value = text
}

function startVersionProgress(durationMs = 30000) {
  stopVersionProgress()
  versionUpdateProgress.value = 8
  versionProgressText.value = '正在触发更新'

  const startedAt = Date.now()
  versionProgressTimer = setInterval(() => {
    const elapsed = Date.now() - startedAt
    const progress = Math.min(96, 30 + Math.round((elapsed / durationMs) * 66))

    if (progress < 45) {
      setVersionProgress(progress, '正在拉取新镜像')
    } else if (progress < 78) {
      setVersionProgress(progress, '正在重启服务')
    } else {
      setVersionProgress(progress, '等待服务恢复')
    }
  }, 800)
}

function stopVersionProgress() {
  if (versionProgressTimer) {
    clearInterval(versionProgressTimer)
    versionProgressTimer = null
  }
  versionUpdateProgress.value = 0
  versionProgressText.value = ''
}

function connectSSE() {
  const token = getAuthToken()
  if (!token) return

  closeSSE()
  sseSource = new EventSource(`/api/tasks/stream?token=${encodeURIComponent(token)}`)
  sseSource.onmessage = (e) => {
    const data = JSON.parse(e.data)
    if (data.event === 'init') {
      pendingCount.value = data.tasks.filter((t) => ['pending', 'running'].includes(t.status)).length
    } else if (data.event === 'task:created') {
      pendingCount.value++
    } else if (data.event === 'task:updated') {
      const task = data.task
      if (['done', 'failed', 'cancelled'].includes(task.status)) {
        pendingCount.value = Math.max(0, pendingCount.value - 1)
        if (task.status === 'done') showToast(`任务完成: ${task.type}`, 'success')
        if (task.status === 'failed') showToast(`任务失败: ${task.error || task.type}`, 'error')
      }
    }
  }
  sseSource.onerror = () => {
    closeSSE()
    if (authState.authenticated && !isPublicRoute.value) {
      setTimeout(connectSSE, 5000)
    }
  }
}

function closeSSE() {
  if (sseSource) {
    sseSource.close()
    sseSource = null
  }
}

function showToast(message, type = 'info') {
  const id = Date.now()
  toasts.value.push({ id, message, type })
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, 4000)
}

async function handleLogout() {
  await logout()
  pendingCount.value = 0
  showToast('已退出登录', 'info')
  router.replace('/login')
}

window.$toast = showToast
</script>

<style>
.sidebar {
  width: 220px;
  min-width: 220px;
  height: 100vh;
  overflow-y: auto;
  background: var(--bg-surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 16px 12px;
  gap: 4px;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px 20px;
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.3px;
  position: relative;
}

.brand-icon {
  font-size: 24px;
}

.brand-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.brand-version {
  align-self: flex-start;
  border: 1px solid var(--border);
  background: var(--bg-card);
  border-radius: 8px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  line-height: 1.25;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s, color 0.2s;
}

.brand-version:hover,
.brand-version-update {
  border-color: rgba(91, 140, 255, 0.45);
  background: var(--accent-dim);
  color: var(--accent);
}

.brand-update-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 5px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 10px rgba(52, 211, 153, 0.7);
}

.version-popover {
  position: fixed;
  top: 58px;
  left: 60px;
  width: 256px;
  z-index: 1200;
  background: #172033;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  box-shadow: 0 18px 45px rgba(0, 0, 0, 0.42);
  overflow: hidden;
}

.version-popover-header {
  height: 52px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.version-refresh {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
}

.version-refresh:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-card);
}

.version-refresh:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.version-popover-body {
  padding: 24px 16px 18px;
  text-align: center;
}

.version-main {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 24px;
  font-weight: 800;
  line-height: 1.1;
  color: var(--text-primary);
}

.version-status-dot {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 800;
}

.version-status-ok {
  color: var(--green);
  background: var(--green-dim);
}

.version-status-new {
  color: var(--yellow);
  background: var(--yellow-dim);
}

.version-status-text {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.version-current {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-muted);
}

.version-update-button {
  width: calc(100% - 32px);
  margin: 0 16px 12px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.2s, opacity 0.2s;
}

.version-update-button:hover:not(:disabled) {
  background: #7aa3ff;
}

.version-update-button:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

.version-progress {
  margin: 0 16px 14px;
}

.version-progress-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 7px;
  font-size: 11px;
  color: var(--text-secondary);
}

.version-progress-track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}

.version-progress-bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), var(--green));
  transition: width 0.45s ease;
}

.version-release-link {
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-top: 1px solid var(--border);
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
}

.version-release-link:hover {
  color: var(--accent);
  background: rgba(255, 255, 255, 0.03);
}

.nav-section {
  margin-bottom: 8px;
}

.nav-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 8px 8px 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius);
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s;
  position: relative;
}

.nav-item:hover {
  background: var(--bg-card);
  color: var(--text-primary);
}

.nav-item.router-link-active {
  background: var(--accent-dim);
  color: var(--accent);
}

.nav-badge {
  margin-left: auto;
  background: var(--accent);
  color: white;
  font-size: 11px;
  font-weight: 700;
  border-radius: 10px;
  padding: 1px 7px;
  min-width: 20px;
  text-align: center;
}

.main-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.sidebar-user {
  padding: 12px 8px 4px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sidebar-user-meta {
  padding: 0 4px;
}

.sidebar-user-name {
  font-size: 13px;
  font-weight: 600;
}

.sidebar-user-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.sidebar-logout {
  width: 100%;
  justify-content: center;
}
</style>
