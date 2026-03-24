<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>系统设置</h1>
        <p>配置通知与账户安全信息</p>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3 style="font-size:15px;font-weight:600;margin-bottom:16px">Telegram 通知</h3>
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

    <div class="card" style="margin-bottom:16px">
      <h3 style="font-size:15px;font-weight:600;margin-bottom:16px">账户安全</h3>
      <div class="form-group">
        <label>用户名</label>
        <input v-model.trim="accountForm.username" class="form-control" placeholder="至少 3 个字符" />
      </div>
      <div class="form-group">
        <label>新密码</label>
        <input v-model="accountForm.newPassword" class="form-control" type="password" autocomplete="new-password"
          placeholder="留空则不修改密码" />
      </div>
      <div class="form-group">
        <label>确认新密码</label>
        <input v-model="accountForm.confirmPassword" class="form-control" type="password" autocomplete="new-password"
          placeholder="再次输入新密码" />
      </div>
      <div class="form-group">
        <label>当前密码</label>
        <input v-model="accountForm.currentPassword" class="form-control" type="password"
          autocomplete="current-password" placeholder="保存前请输入当前密码确认" />
      </div>
      <button class="btn btn-primary" @click="saveAccountSecurity" :disabled="savingAccount">
        {{ savingAccount ? '保存中...' : '保存账户信息' }}
      </button>
      <p style="margin-top:10px;font-size:12px;color:var(--text-secondary)">
        可以同时修改用户名和密码；如果本次修改了密码，保存后会自动退出并要求重新登录。
      </p>
    </div>

    <div class="card">
      <h3 style="font-size:15px;font-weight:600;margin-bottom:12px">关于</h3>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--text-secondary)">
        <div>版本: <span style="color:var(--text-primary)">1.1.0</span></div>
        <div>
          后端:
          <a :href="backendHealthUrl" target="_blank" rel="noreferrer" style="color:var(--accent)">
            {{ backendBaseUrl }}
          </a>
        </div>
        <div>
          GitHub:
          <a href="https://github.com/JenkinWoo/cloud-manager" target="_blank" rel="noreferrer"
            style="color:var(--accent)">
            https://github.com/JenkinWoo/cloud-manager
          </a>
        </div>
        <div>技术栈: Express.js / Vue 3 / Vite / lowdb</div>
        <div>支持的云: Oracle Cloud / AWS</div>
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
const savingTg = ref(false)
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
    const res = await settingsApi.get()
    const settings = res.data || {}
    tgForm.value.botToken = settings.telegram?.botToken || ''
    tgForm.value.chatId = settings.telegram?.chatId || ''
  } catch (_) {
  }
})

async function saveTg() {
  savingTg.value = true
  try {
    await settingsApi.updateTelegram(tgForm.value)
    window.$toast?.('Telegram 配置已保存', 'success')
  } catch (e) {
    window.$toast?.(e.response?.data?.error || e.message, 'error')
  } finally {
    savingTg.value = false
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
    const res = await authApi.updateAccount({
      newUsername: accountForm.value.username,
      newPassword: accountForm.value.newPassword,
      currentPassword: accountForm.value.currentPassword
    })

    if (res.data.requiresRelogin) {
      await logout()
      window.$toast?.('账户信息已更新，请重新登录', 'success')
      await router.replace('/login')
      return
    }

    setAuthUser({
      ...authState.user,
      ...res.data.user,
      authenticated: true
    })
    accountForm.value.currentPassword = ''
    accountForm.value.newPassword = ''
    accountForm.value.confirmPassword = ''
    window.$toast?.('账户信息已更新', 'success')
  } catch (e) {
    window.$toast?.(e.response?.data?.error || e.message, 'error')
  } finally {
    savingAccount.value = false
  }
}
</script>
