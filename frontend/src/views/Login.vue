<template>
  <div class="auth-page">
    <div class="auth-shell">
      <div class="auth-panel auth-brand">
        <div>
          <div class="auth-kicker">Cloud Manager</div>
          <h1>登录云管理平台</h1>
          <p>统一管理 Oracle、AWS、DNS 与任务队列的云资源管理平台。</p>
        </div>

        <div class="auth-tips">
          <div class="auth-tip">
            <span>默认账号</span>
            <strong>{{ usernameHint }}</strong>
          </div>
          <div class="auth-tip">
            <span>默认密码</span>
            <strong>admin123</strong>
          </div>
          <div v-if="authState.user?.mustChangePassword" class="auth-note">
            当前仍是初始密码，登录后请到“系统设置”中修改。
          </div>
        </div>
      </div>

      <div class="auth-panel">
        <form class="auth-form" @submit.prevent="submitLogin">
          <div>
            <div class="auth-title">账户登录</div>
          </div>

          <div class="form-group">
            <label>用户名</label>
            <input v-model.trim="form.username" class="form-control" autocomplete="username" />
          </div>

          <div class="form-group">
            <label>密码</label>
            <input v-model="form.password" class="form-control" type="password" autocomplete="current-password"
              placeholder="请输入登录密码" />
          </div>

          <button class="btn btn-primary auth-submit" :disabled="submitting">
            {{ submitting ? '登录中...' : '登录' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authState, login } from '../auth.js'

const route = useRoute()
const router = useRouter()
const submitting = ref(false)
const usernameHint = 'admin'
const form = ref({
  username: '',
  password: ''
})

async function submitLogin() {
  submitting.value = true
  try {
    await login(form.value)
    window.$toast?.('登录成功', 'success')
    await router.replace(String(route.query.redirect || '/'))
  } catch (error) {
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.auth-page {
  width: 100vw;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background:
    radial-gradient(circle at top left, rgba(91, 140, 255, 0.2), transparent 28%),
    radial-gradient(circle at bottom right, rgba(52, 211, 153, 0.12), transparent 22%),
    linear-gradient(135deg, #070b15 0%, #0a0e1a 45%, #0d1224 100%);
}

.auth-shell {
  width: min(1040px, 100%);
  display: grid;
  grid-template-columns: 1.15fr 0.85fr;
  gap: 24px;
}

.auth-panel {
  background: rgba(13, 18, 36, 0.88);
  border: 1px solid var(--border);
  border-radius: 24px;
  backdrop-filter: blur(18px);
  box-shadow: var(--shadow);
}

.auth-brand {
  padding: 40px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;

}

.auth-kicker {
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.auth-brand h1 {
  margin-top: 18px;
  font-size: 40px;
  line-height: 1.1;
  letter-spacing: -0.03em;
}

.auth-brand p {
  margin-top: 16px;
  max-width: 460px;
  color: var(--text-secondary);
  font-size: 15px;
}

.auth-tips {
  display: grid;
  gap: 12px;
}

.auth-tip,
.auth-note {
  padding: 16px 18px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.03);
}

.auth-tip span,
.auth-note {
  color: var(--text-secondary);
  font-size: 13px;
}

.auth-tip strong {
  display: block;
  margin-top: 6px;
  color: var(--text-primary);
  font-size: 20px;
}

.auth-form {
  min-height: 520px;
  padding: 40px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 18px;
}

.auth-title {
  font-size: 26px;
  font-weight: 700;
}

.auth-submit {
  justify-content: center;
  min-height: 42px;
  margin-top: 8px;
}

@media (max-width: 900px) {
  .auth-shell {
    grid-template-columns: 1fr;
  }

  .auth-brand,
  .auth-form {
    min-height: auto;
  }

  .auth-brand h1 {
    font-size: 30px;
  }
}
</style>
