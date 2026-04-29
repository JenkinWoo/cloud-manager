<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>系统设置</h1>
        <p>配置通知与账户安全信息。</p>
      </div>
    </div>

    <div class="card section-card">
      <h3 class="section-title">Telegram 通知</h3>
      <div class="form-group">
        <label>Bot Token</label>
        <input v-model="tgForm.botToken" class="form-control" type="password" placeholder="请输入 Telegram Bot Token" />
      </div>
      <div class="form-group">
        <label>Chat ID</label>
        <input v-model="tgForm.chatId" class="form-control" placeholder="请输入个人或群组 Chat ID" />
      </div>
      <button class="btn btn-primary" @click="saveTg" :disabled="savingTg">
        {{ savingTg ? '保存中...' : '保存 Telegram 配置' }}
      </button>
    </div>

    <div class="card section-card">
      <h3 class="section-title">账户安全</h3>
      <div class="form-group">
        <label>用户名</label>
        <input v-model.trim="accountForm.username" class="form-control" placeholder="至少 3 个字符" />
      </div>
      <div class="form-group">
        <label>新密码</label>
        <input
          v-model="accountForm.newPassword"
          class="form-control"
          type="password"
          autocomplete="new-password"
          placeholder="留空则不修改密码"
        />
      </div>
      <div class="form-group">
        <label>确认新密码</label>
        <input
          v-model="accountForm.confirmPassword"
          class="form-control"
          type="password"
          autocomplete="new-password"
          placeholder="再次输入新密码"
        />
      </div>
      <div class="form-group">
        <label>当前密码</label>
        <input
          v-model="accountForm.currentPassword"
          class="form-control"
          type="password"
          autocomplete="current-password"
          placeholder="保存前请输入当前密码确认"
        />
      </div>
      <button class="btn btn-primary" @click="saveAccountSecurity" :disabled="savingAccount">
        {{ savingAccount ? '保存中...' : '保存账户信息' }}
      </button>
      <p class="hint-text">
        可以同时修改用户名和密码；如果本次修改了密码，保存后会自动退出并要求重新登录。
      </p>
    </div>

    <div class="card section-card">
      <h3 class="section-title">系统日志</h3>
      <div class="form-group">
        <label>日志保留天数</label>
        <input
          v-model.number="logForm.retentionDays"
          class="form-control"
          type="number"
          min="1"
          max="3650"
          step="1"
          placeholder="30"
        />
      </div>
      <button class="btn btn-primary" @click="saveLogRule" :disabled="savingLogRule">
        {{ savingLogRule ? '保存中...' : '保存日志规则' }}
      </button>
      <p class="hint-text">
        默认保留最近 30 天日志；保存后会立即清理超过保留天数的旧日志。
      </p>
    </div>

    <div class="card">
      <h3 class="section-title">关于</h3>
      <div class="about-list">
        <div>版本: <span class="about-value">1.1.0</span></div>
        <div>
          后端:
          <a :href="backendHealthUrl" target="_blank" rel="noreferrer" class="about-link">{{ backendBaseUrl }}</a>
        </div>
        <div>
          GitHub:
          <a href="https://github.com/JenkinWoo/cloud-manager" target="_blank" rel="noreferrer" class="about-link">
            https://github.com/JenkinWoo/cloud-manager
          </a>
        </div>
        <div>技术栈: Express.js / Vue 3 / Vite / lowdb</div>
        <div>支持的云: Oracle Cloud / AWS / Azure</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authApi, settingsApi } from '../api/index.js'
import { authState, logout, setAuthUser } from '../auth.js'

const router = useRouter()
const tgForm = ref({ botToken: '', chatId: '' })
const logForm = ref({ retentionDays: 30 })
const savingTg = ref(false)
const savingLogRule = ref(false)
const savingAccount = ref(false)
const accountForm = ref({
  username: '',
  newPassword: '',
  confirmPassword: '',
  currentPassword: ''
})

const backendBaseUrl = computed(() => window.location.origin)
const backendHealthUrl = computed(() => `${backendBaseUrl.value}/api/health`)

onMounted(async () => {
  accountForm.value.username = authState.user?.username || ''

  try {
    const response = await settingsApi.get()
    const settings = response.data || {}
    tgForm.value.botToken = settings.telegram?.botToken || ''
    tgForm.value.chatId = settings.telegram?.chatId || ''
    logForm.value.retentionDays = settings.operationLogs?.retentionDays || 30
  } catch (_) {
  }
})

async function saveTg() {
  savingTg.value = true
  try {
    await settingsApi.updateTelegram(tgForm.value)
    window.$toast?.('Telegram 配置已保存', 'success')
  } catch (error) {
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    savingTg.value = false
  }
}

async function saveLogRule() {
  const retentionDays = Number(logForm.value.retentionDays)
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    return window.$toast?.('日志保留天数必须是 1 到 3650 之间的整数', 'error')
  }

  savingLogRule.value = true
  try {
    const response = await settingsApi.updateOperationLogs({ retentionDays })
    window.$toast?.(`日志规则已保存，已清理 ${response.data.deleted || 0} 条旧日志`, 'success')
  } catch (error) {
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    savingLogRule.value = false
  }
}

async function saveAccountSecurity() {
  if (accountForm.value.username.length < 3) {
    return window.$toast?.('用户名至少需要 3 个字符', 'error')
  }
  if (!accountForm.value.currentPassword) {
    return window.$toast?.('请输入当前密码', 'error')
  }
  if (accountForm.value.newPassword && accountForm.value.newPassword.length < 8) {
    return window.$toast?.('新密码至少需要 8 位', 'error')
  }
  if (accountForm.value.newPassword !== accountForm.value.confirmPassword) {
    return window.$toast?.('两次输入的新密码不一致', 'error')
  }

  savingAccount.value = true
  try {
    const response = await authApi.updateAccount({
      newUsername: accountForm.value.username,
      newPassword: accountForm.value.newPassword,
      currentPassword: accountForm.value.currentPassword
    })

    if (response.data.requiresRelogin) {
      await logout()
      window.$toast?.('账户信息已更新，请重新登录', 'success')
      await router.replace('/login')
      return
    }

    setAuthUser({
      ...authState.user,
      ...response.data.user,
      authenticated: true
    })

    accountForm.value.currentPassword = ''
    accountForm.value.newPassword = ''
    accountForm.value.confirmPassword = ''
    window.$toast?.('账户信息已更新', 'success')
  } catch (error) {
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    savingAccount.value = false
  }
}
</script>

<style scoped>
.section-card {
  margin-bottom: 16px;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 16px;
}

.hint-text {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-secondary);
}

.about-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

.about-link {
  color: var(--accent);
}

.about-value {
  color: var(--text-primary);
}
</style>
