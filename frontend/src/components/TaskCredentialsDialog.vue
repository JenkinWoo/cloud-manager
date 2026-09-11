<template>
  <dialog ref="dialog" class="credentials-dialog" aria-labelledby="credentials-title"
    @cancel.prevent="close" @close="$emit('close')">
    <div class="modal-header">
      <h3 id="credentials-title">查看创建密码</h3>
      <button class="btn btn-ghost" aria-label="关闭创建密码" autofocus @click="close">✕</button>
    </div>
    <p class="account-name">{{ accountName }}</p>
    <div v-if="loading" class="credentials-state" role="status">正在读取创建密码…</div>
    <div v-else-if="error" class="credentials-state" role="alert">
      <p>{{ error }}</p>
      <button class="btn btn-primary" @click="load">重试</button>
    </div>
    <template v-else-if="credentials">
      <dl class="credentials-info">
        <dt>实例 ID</dt><dd>{{ credentials.instanceId || '未记录' }}</dd>
        <dt>登录用户名</dt><dd>{{ credentials.username }}</dd>
      </dl>
      <div class="form-group">
        <label for="task-creation-password">创建时使用的密码</label>
        <div class="credentials-input">
          <input id="task-creation-password" :value="credentials.password" :type="visible ? 'text' : 'password'"
            class="form-control" readonly autocomplete="off" spellcheck="false" />
          <button class="btn btn-ghost" :aria-pressed="visible" @click="visible = !visible">{{ visible ? '隐藏' : '显示' }}</button>
        </div>
      </div>
      <p class="form-hint">这是创建时提交的密码；之后在实例内修改密码不会同步更新此记录。</p>
    </template>
    <div class="modal-footer">
      <button class="btn btn-ghost" @click="close">关闭</button>
      <button class="btn btn-primary" :disabled="!credentials || loading || copying" @click="copyPassword">
        {{ copying ? '复制中…' : '复制密码' }}
      </button>
    </div>
  </dialog>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { tasksApi } from '../api/index.js'

const props = defineProps({ taskId: { type: String, required: true }, accountName: { type: String, default: '' } })
const emit = defineEmits(['close'])
const dialog = ref(null)
const credentials = ref(null)
const loading = ref(false)
const copying = ref(false)
const visible = ref(false)
const error = ref('')
let controller

onMounted(() => {
  dialog.value.showModal()
  load()
})
onBeforeUnmount(() => {
  controller?.abort()
  credentials.value = null
})

function close() {
  controller?.abort()
  credentials.value = null
  emit('close')
}

async function load() {
  controller?.abort()
  const request = new AbortController()
  controller = request
  loading.value = true
  error.value = ''
  credentials.value = null
  try {
    const response = await tasksApi.credentials(props.taskId, { signal: request.signal })
    if (!request.signal.aborted) credentials.value = response.data
  } catch (err) {
    if (!request.signal.aborted) error.value = err.response?.data?.error || err.message
  } finally {
    if (!request.signal.aborted) loading.value = false
  }
}

async function copyPassword() {
  if (!credentials.value) return
  copying.value = true
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(credentials.value.password)
    } else {
      const previousFocus = document.activeElement
      const input = document.createElement('textarea')
      input.value = credentials.value.password
      input.style.cssText = 'position:fixed;opacity:0;pointer-events:none;'
      dialog.value.appendChild(input)
      try {
        input.select()
        if (!document.execCommand('copy')) throw new Error('复制失败')
      } finally {
        input.remove()
        previousFocus?.focus()
      }
    }
    window.$toast?.('密码已复制', 'success')
  } catch (_) {
    window.$toast?.('复制失败，请显示密码后手动选择复制', 'error')
  } finally {
    copying.value = false
  }
}
</script>

<style scoped>
.credentials-dialog {
  width: min(600px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px);
  margin: auto;
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  color: var(--text-primary);
  overflow: auto;
}
.credentials-dialog::backdrop { background: rgba(0, 0, 0, 0.65); }
.account-name, .credentials-info dt { color: var(--text-secondary); }
.credentials-info { margin: 20px 0; }
.credentials-info dt { font-size: 12px; }
.credentials-info dd { margin: 6px 0 14px; overflow-wrap: anywhere; }
.credentials-input { display: flex; gap: 8px; }
.credentials-input input { min-width: 0; font-family: ui-monospace, Consolas, monospace; }
.credentials-state { padding: 24px 0; }
.credentials-state p { margin-bottom: 12px; }
</style>
