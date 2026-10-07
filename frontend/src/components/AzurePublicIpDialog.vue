<template>
  <div class="modal-overlay" @click.self="close">
    <div class="modal public-ip-modal" role="dialog" aria-modal="true" aria-labelledby="public-ip-title">
      <div class="modal-header">
        <h3 id="public-ip-title">管理 Azure 公网 IP</h3>
        <button class="modal-close" :disabled="!!deletingId" aria-label="关闭" @click="close">x</button>
      </div>
      <p class="scope-label">{{ accountName }} / {{ subscriptionName || subscriptionId }}</p>
      <p class="scope-label">未关联的地址也可能有预留用途，请确认不再需要后删除。删除后原地址可能无法找回。</p>
      <p class="scope-label">关联到空闲网卡的 IP 可“解绑并删除”，系统会再次确认网卡未绑定实例。网卡本身会保留。</p>
      <div class="toolbar">
        <select v-model="region" class="form-control" aria-label="筛选区域" :disabled="loading || !!deletingId">
          <option value="">全部区域</option>
          <option v-for="item in regions" :key="item" :value="item">{{ item }}</option>
        </select>
        <button class="btn btn-ghost" :disabled="loading || !!deletingId" @click="loadIps">刷新</button>
        <span>共 {{ filteredIps.length }} 个，{{ filteredIps.filter(item => item.canDelete).length }} 个可直接删除，{{ filteredIps.filter(item => item.canDetach).length }} 个可解绑</span>
      </div>
      <p v-if="error" class="error-message" role="alert">{{ error }}</p>
      <div v-if="loading" class="loading-wrap"><div class="spinner"></div></div>
      <div v-else-if="!filteredIps.length" class="empty-state">{{ error ? '暂时无法显示公网 IP，请重试。' : '当前条件下没有公网 IP。' }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead><tr><th>名称 / 资源组</th><th>IP 地址</th><th>区域</th><th>关联状态</th><th>资源状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="ip in filteredIps" :key="ip.id">
              <td :title="ip.id"><div>{{ ip.name }}</div><small>{{ ip.resourceGroup }}</small></td>
              <td>{{ ip.ipAddress || '尚未分配' }}<br /><small>{{ ip.version }}</small></td>
              <td>{{ ip.region }}</td>
              <td><span :class="['badge', ip.associated ? 'badge-pending' : 'badge-running']">{{ ip.canDetach ? '网卡未绑定实例' : (ip.associated ? '已关联' : '未关联') }}</span>
                <div v-if="ip.detachReason" class="association">{{ ip.detachReason }}</div>
                <div v-for="id in ip.associationIds" :key="id" class="association" :title="id">{{ id }}</div>
              </td>
              <td>{{ ip.state }}</td>
              <td><button class="btn btn-danger btn-sm" :disabled="(!ip.canDelete && !ip.canDetach) || !!deletingId"
                :title="ip.canDetach ? '解除空闲网卡上的公网 IP 关联并删除 IP' : (ip.detachReason || (ip.canDelete ? '删除此公网 IP' : '资源状态暂不允许删除'))"
                @click="deleteIp(ip)">{{ deletingId === ip.id ? '处理中...' : (ip.canDetach ? '解绑并删除' : '删除') }}</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { cloudApi } from '../api/index.js'

const props = defineProps({
  accountId: { type: String, required: true },
  subscriptionId: { type: String, required: true },
  accountName: { type: String, default: '' },
  subscriptionName: { type: String, default: '' }
})
const emit = defineEmits(['close'])
const ips = ref([])
const region = ref('')
const loading = ref(false)
const deletingId = ref('')
const error = ref('')
const regions = computed(() => [...new Set(ips.value.map(ip => ip.region).filter(Boolean))].sort())
const filteredIps = computed(() => ips.value.filter(ip => !region.value || ip.region === region.value))
let controller = null
let active = true

onMounted(loadIps)
onBeforeUnmount(() => { active = false; controller?.abort() })

function close() {
  if (!deletingId.value) emit('close')
}

async function loadIps() {
  controller?.abort()
  const request = new AbortController()
  controller = request
  loading.value = true
  error.value = ''
  try {
    const { data } = await cloudApi.listPublicIps(props.accountId, { subscriptionId: props.subscriptionId }, { signal: request.signal })
    if (!active || request.signal.aborted) return
    ips.value = data || []
    if (region.value && !regions.value.includes(region.value)) region.value = ''
  } catch (err) {
    if (!active || request.signal.aborted) return
    ips.value = []
    error.value = err.response?.data?.error || err.message
  } finally {
    if (active && controller === request) loading.value = false
  }
}

async function deleteIp(ip) {
  if ((!ip.canDelete && !ip.canDetach) || deletingId.value) return
  const action = ip.canDetach ? `解除未绑定实例的网卡「${ip.nicName}」与此 IP 的关联，并删除公网 IP` : '删除公网 IP'
  if (!window.confirm(`确认${action}「${ip.name}」（${ip.ipAddress || '尚未分配'}，${ip.region}）？删除后原地址可能无法找回。`)) return
  deletingId.value = ip.id
  error.value = ''
  try {
    const remove = ip.canDetach ? cloudApi.detachAndDeletePublicIp : cloudApi.deletePublicIp
    await remove(props.accountId, ip.id, { subscriptionId: props.subscriptionId }, {
      accountName: props.accountName, targetName: ip.name
    })
    if (active) await loadIps()
  } catch (err) {
    if (!active) return
    const message = err.response?.data?.error || err.message
    await loadIps()
    if (active) error.value = message
  } finally {
    if (active) deletingId.value = ''
  }
}
</script>

<style scoped>
.public-ip-modal { width: min(1100px, 94vw); max-width: 1100px; }
.scope-label { color: var(--text-secondary); margin-bottom: 12px; overflow-wrap: anywhere; }
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.toolbar select { width: 220px; }
.error-message { color: var(--red); margin-bottom: 12px; }
small { color: var(--text-secondary); }
.association { max-width: 240px; overflow-wrap: anywhere; font-size: 11px; color: var(--text-secondary); }
</style>
