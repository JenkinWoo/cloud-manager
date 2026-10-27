<template>
  <div class="modal-overlay" @click.self="close">
    <form class="modal" role="dialog" aria-modal="true" aria-labelledby="bind-public-ip-title" @submit.prevent="bind">
      <div class="modal-header">
        <h3 id="bind-public-ip-title">绑定 Azure 公网 IP</h3>
        <button type="button" class="modal-close" :disabled="saving" aria-label="关闭" @click="close">x</button>
      </div>
      <p class="form-hint">{{ accountName }} / {{ instance.displayName || instance.id }} / {{ instance.region }}</p>
      <div class="form-group">
        <label for="azure-bind-ip-mode">公网 IP 来源</label>
        <select id="azure-bind-ip-mode" v-model="mode" class="form-control" :disabled="saving">
          <option value="new">创建并绑定新的 Standard 静态公网 IPv4（收费）</option>
          <option value="existing">绑定未使用的公网 IPv4</option>
        </select>
      </div>
      <div v-if="mode === 'existing'" class="form-group">
        <label for="azure-bind-ip-id">同区域的空闲地址</label>
        <select id="azure-bind-ip-id" v-model="publicIpId" class="form-control" :disabled="loading || saving">
          <option value="" disabled>{{ loading ? '正在查询公网 IP…' : '请选择公网 IP' }}</option>
          <option v-for="ip in availableIps" :key="ip.id" :value="ip.id">{{ ip.name }} · {{ ip.ipAddress || '尚未分配' }} · {{ ip.resourceGroup }}</option>
        </select>
        <p class="form-hint">仅显示当前订阅内同区域、未关联、状态正常的 Standard 区域静态 IPv4；可用区兼容性会在绑定时检查。</p>
        <p v-if="!loading && !availableIps.length" class="form-hint">暂无可用地址，可以选择创建新 IP。</p>
        <p v-if="listError" class="error-message" role="alert">{{ listError }}</p>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="loading || saving" @click="loadIps">刷新地址</button>
      </div>
      <p class="form-hint">公网 IPv4 单独计费，免费出站流量不包含 IP 费用；实例停止后仍可能计费。删除此实例时，也会删除这里绑定的 IP，包括已有地址。</p>
      <p v-if="error" class="error-message" role="alert">{{ error }}</p>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" :disabled="saving" @click="close">取消</button>
        <button type="submit" class="btn btn-primary" :disabled="saving || (mode === 'existing' && (!publicIpId || loading))">
          {{ saving ? '绑定中…' : (mode === 'new' ? '创建并绑定（收费）' : '绑定所选 IP') }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { cloudApi } from '../api/index.js'

const props = defineProps({
  accountId: { type: String, required: true },
  subscriptionId: { type: String, required: true },
  accountName: { type: String, default: '' },
  instance: { type: Object, required: true }
})
const emit = defineEmits(['close', 'bound'])
const mode = ref('new')
const publicIpId = ref('')
const ips = ref([])
const loading = ref(false)
const saving = ref(false)
const listError = ref('')
const error = ref('')
const availableIps = computed(() => ips.value.filter(ip => ip.canBind &&
  ip.region?.toLowerCase() === props.instance.region?.toLowerCase()))
let controller = null
let active = true

onMounted(loadIps)
onBeforeUnmount(() => { active = false; controller?.abort() })

function close() {
  if (!saving.value) emit('close')
}

async function loadIps() {
  controller?.abort()
  const request = new AbortController()
  controller = request
  loading.value = true
  listError.value = ''
  try {
    const { data } = await cloudApi.listPublicIps(props.accountId, { subscriptionId: props.subscriptionId }, { signal: request.signal })
    if (!active || request.signal.aborted) return
    ips.value = data || []
    if (!availableIps.value.some(ip => ip.id === publicIpId.value)) publicIpId.value = ''
  } catch (failure) {
    if (active && !request.signal.aborted) {
      ips.value = []
      publicIpId.value = ''
      listError.value = failure.response?.data?.error || failure.message
    }
  } finally {
    if (active && controller === request) loading.value = false
  }
}

async function bind() {
  if (saving.value || (mode.value === 'existing' && !publicIpId.value)) return
  saving.value = true
  error.value = ''
  try {
    await cloudApi.bindPublicIp(props.accountId, props.instance.id, {
      subscriptionId: props.subscriptionId, mode: mode.value,
      ...(mode.value === 'existing' ? { publicIpId: publicIpId.value } : {})
    }, { accountName: props.accountName, instanceName: props.instance.displayName || props.instance.id })
    if (active) emit('bound')
  } catch (failure) {
    if (active) {
      error.value = failure.response?.data?.error || failure.message
      await loadIps()
    }
  } finally {
    if (active) saving.value = false
  }
}
</script>

<style scoped>
.error-message { color: var(--red); margin-top: 12px; overflow-wrap: anywhere; }
.form-hint { margin-bottom: 12px; overflow-wrap: anywhere; }
</style>
