<template>
  <div class="form-group">
    <label :for="inputId">{{ label }}</label>
    <div class="password-input-row">
      <input :id="inputId" :value="modelValue" :type="visible ? 'text' : 'password'" class="form-control"
        autocomplete="new-password" :disabled="disabled || generating" :placeholder="`请输入${label}`"
        @input="$emit('update:modelValue', $event.target.value)" />
      <button type="button" class="btn btn-ghost btn-sm" :disabled="disabled"
        :aria-label="visible ? '隐藏密码' : '显示密码'" :aria-pressed="visible" @click="visible = !visible">
        {{ visible ? '隐藏' : '显示' }}
      </button>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="disabled || generating" @click="generate">
        {{ generating ? '生成中…' : '随机生成' }}
      </button>
    </div>
    <small class="form-hint">{{ rule }} 随机生成 20 位，含大小写字母、数字和符号。</small>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref } from 'vue'
import { cloudApi } from '../api/index.js'

const props = defineProps({ modelValue: { type: String, default: '' }, accountId: { type: String, required: true },
  label: { type: String, default: '实例密码' }, inputId: { type: String, required: true },
  rule: { type: String, default: '8–100 位，包含大小写字母、数字和特殊字符。' }, disabled: Boolean })
const emit = defineEmits(['update:modelValue', 'generating'])
const visible = ref(false)
const generating = ref(false)
let controller

onBeforeUnmount(() => {
  controller?.abort()
  emit('generating', false)
})

async function generate() {
  const accountId = props.accountId
  controller = new AbortController()
  const request = controller
  generating.value = true
  emit('generating', true)
  try {
    const response = await cloudApi.generateInstancePassword(accountId, { signal: request.signal })
    if (!request.signal.aborted && props.accountId === accountId) {
      emit('update:modelValue', response.data.password)
      window.$toast?.('已生成随机密码', 'success')
    }
  } catch (error) {
    if (!request.signal.aborted) window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    if (!request.signal.aborted) {
      generating.value = false
      emit('generating', false)
    }
  }
}
</script>

<style scoped>
.password-input-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.password-input-row input { flex: 1 1 160px; min-width: 0; }
.password-input-row button { flex: 0 0 auto; white-space: nowrap; }
</style>
