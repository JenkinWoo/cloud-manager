<template>
  <router-view v-if="isPublicRoute" />

  <template v-else>
    <nav class="sidebar">
      <div>
        <div class="sidebar-brand">
          <span class="brand-icon">☁️</span>
          <span class="brand-text">云管理平台</span>
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
import { getAuthToken } from './api/index.js'
import { authState, initAuth, logout } from './auth.js'

const route = useRoute()
const router = useRouter()
const pendingCount = ref(0)
const toasts = ref([])
const isPublicRoute = computed(() => Boolean(route.meta.public))
let sseSource = null

onMounted(() => {
  initAuth()
})

onUnmounted(() => {
  closeSSE()
})

watch(
  () => authState.authenticated,
  (authenticated) => {
    if (authenticated && !isPublicRoute.value) connectSSE()
    else closeSSE()
  },
  { immediate: true }
)

watch(isPublicRoute, (publicRoute) => {
  if (publicRoute) closeSSE()
  else if (authState.authenticated) connectSSE()
})

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
}

.brand-icon {
  font-size: 24px;
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
