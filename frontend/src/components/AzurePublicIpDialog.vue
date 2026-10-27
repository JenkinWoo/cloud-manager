<template>
  <div class="modal-overlay" @click.self="close">
    <div class="modal public-ip-modal" role="dialog" aria-modal="true" aria-labelledby="public-ip-title">
      <div class="modal-header">
        <h3 id="public-ip-title">管理 Azure 公网 IP</h3>
        <button class="modal-close" :disabled="busy" aria-label="关闭" @click="close">x</button>
      </div>
      <p class="scope-label">{{ accountName }} / {{ subscriptionName || subscriptionId }}</p>
      <p class="scope-label">未关联的地址也可能有预留用途，请确认不再需要后删除。删除后原地址可能无法找回。</p>
      <p class="scope-label">关联到空闲网卡的 IP 可“解绑并删除”，系统会再次确认网卡未绑定实例。网卡本身会保留。</p>
      <div class="toolbar">
        <select v-model="region" class="form-control" aria-label="筛选区域" :disabled="loading || busy">
          <option value="">全部区域</option>
          <option v-for="item in regions" :key="item" :value="item">{{ item }}</option>
        </select>
        <button class="btn btn-ghost" :disabled="loading || busy" @click="loadIps">刷新</button>
        <button class="btn btn-primary" :disabled="busy" @click="openCreate">新建公网 IP</button>
        <span>共 {{ filteredIps.length }} 个，{{ filteredIps.filter(item => item.canDelete).length }} 个可直接删除，{{ filteredIps.filter(item => item.canDetach).length }} 个可解绑</span>
      </div>
      <form v-if="showCreate" class="create-ip-form" @submit.prevent="createIp">
        <div class="form-group">
          <label for="public-ip-create-region">创建区域</label>
          <select id="public-ip-create-region" v-model="createRegion" class="form-control" :disabled="loadingLocations || busy">
            <option value="" disabled>{{ loadingLocations ? '正在加载区域…' : '请选择区域' }}</option>
            <option v-for="location in locations" :key="location.name" :value="location.name">{{ location.displayName }}（{{ location.name }}）</option>
          </select>
        </div>
        <p class="scope-label">创建 Standard 静态公网 IPv4，按 Azure 定价单独收费；未绑定实例时也可能计费。创建后可到实例的“绑定 / 创建公网 IP”中选择此地址，请选择与实例相同的区域。</p>
        <p v-if="createError" class="error-message" role="alert">{{ createError }}</p>
        <div class="create-ip-actions">
          <button type="submit" class="btn btn-primary" :disabled="busy || loadingLocations || !createRegion">{{ creating ? '创建中…' : '创建公网 IP（收费）' }}</button>
          <button type="button" class="btn btn-ghost" :disabled="busy" @click="showCreate = false">取消</button>
          <button v-if="!locations.length && !loadingLocations" type="button" class="btn btn-ghost" :disabled="busy" @click="loadLocations">重试加载区域</button>
        </div>
      </form>
      <p v-if="success" class="success-message" role="status">{{ success }}</p>
      <p v-if="error" class="error-message" role="alert">{{ error }}</p>
      <div v-if="loading" class="loading-wrap"><div class="spinner"></div></div>
      <div v-else-if="!filteredIps.length" class="empty-state">{{ error ? '暂时无法显示公网 IP，请重试。' : '当前条件下没有公网 IP。' }}</div>
      <div v-else class="table-wrap">
        <table>
          <thead><tr><th>名称 / 资源组</th><th>IP 地址</th><th>区域</th><th>关联状态</th><th>资源状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="ip in filteredIps" :key="ip.id">
              <td :title="ip.id"><div>{{ ip.name }}</div><small>{{ ip.resourceGroup }}</small></td>
              <td>{{ ip.ipAddress || '尚未分配' }}<br /><small>{{ ip.version }} / {{ ip.sku || '未知 SKU' }} / {{ ip.allocationMethod || '未知分配方式' }}</small></td>
              <td>{{ ip.region }}</td>
              <td><span :class="['badge', ip.associated ? 'badge-pending' : 'badge-running']">{{ ip.canDetach ? '网卡未绑定实例' : (ip.associated ? '已关联' : '未关联') }}</span>
                <div v-if="ip.detachReason" class="association">{{ ip.detachReason }}</div>
                <div v-for="id in ip.associationIds" :key="id" class="association" :title="id">{{ id }}</div>
              </td>
              <td>{{ ip.state }}</td>
              <td><button class="btn btn-danger btn-sm" :disabled="(!ip.canDelete && !ip.canDetach) || busy"
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
  subscriptionName: { type: String, default: '' },
  initialCreate: { type: Boolean, default: false }
})
const emit = defineEmits(['close'])
const ips = ref([])
const region = ref('')
const loading = ref(false)
const deletingId = ref('')
const error = ref('')
const showCreate = ref(props.initialCreate)
const locations = ref([])
const createRegion = ref('')
const loadingLocations = ref(false)
const creating = ref(false)
const createError = ref('')
const success = ref('')
const busy = computed(() => creating.value || !!deletingId.value)
const regions = computed(() => [...new Set(ips.value.map(ip => ip.region).filter(Boolean))].sort())
const filteredIps = computed(() => ips.value.filter(ip => !region.value || ip.region === region.value))
let controller = null
let locationsController = null
let creationRequest = null
let active = true

onMounted(() => {
  loadIps()
  if (showCreate.value) loadLocations()
})
onBeforeUnmount(() => { active = false; controller?.abort(); locationsController?.abort() })

function close() {
  if (!busy.value) emit('close')
}

function openCreate() {
  showCreate.value = true
  success.value = ''
  if (!locations.value.length && !loadingLocations.value) loadLocations()
}

async function loadLocations() {
  locationsController?.abort()
  const request = new AbortController()
  locationsController = request
  loadingLocations.value = true
  createError.value = ''
  try {
    const { data } = await cloudApi.listAzureLocations(props.accountId, { subscriptionId: props.subscriptionId }, { signal: request.signal })
    if (!active || request.signal.aborted) return
    locations.value = data || []
    if (!locations.value.some(location => location.name === createRegion.value)) {
      createRegion.value = locations.value.some(location => location.name === region.value) ? region.value : (locations.value[0]?.name || '')
    }
  } catch (failure) {
    if (active && !request.signal.aborted) createError.value = failure.response?.data?.error || failure.message
  } finally {
    if (active && locationsController === request) loadingLocations.value = false
  }
}

async function createIp() {
  if (busy.value || !createRegion.value) return
  const location = createRegion.value
  if (!creationRequest || creationRequest.location !== location) {
    const requestId = crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
    creationRequest = { location, requestId }
  }
  creating.value = true
  createError.value = ''
  success.value = ''
  try {
    const { data } = await cloudApi.createPublicIp(props.accountId, {
      subscriptionId: props.subscriptionId, ...creationRequest
    }, { accountName: props.accountName, targetName: '新建公网 IP' })
    if (!active) return
    creationRequest = null
    region.value = location
    showCreate.value = false
    await loadIps()
    if (!active) return
    // Keep the returned resource visible even if a following list read fails.
    if (!ips.value.some(ip => ip.id === data.id)) ips.value = [...ips.value, data]
    region.value = location
    success.value = `公网 IP「${data.name}」（${data.ipAddress || '地址分配中'}）已创建，可到实例卡片选择绑定。`
  } catch (failure) {
    if (!active) return
    await loadIps()
    if (active) createError.value = `${failure.response?.data?.error || failure.message}。可刷新列表确认是否已创建；重试当前请求会复用同一 IP。`
  } finally {
    if (active) creating.value = false
  }
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
  if ((!ip.canDelete && !ip.canDetach) || busy.value) return
  const action = ip.canDetach ? `解除未绑定实例的网卡「${ip.nicName}」与此 IP 的关联，并删除公网 IP` : '删除公网 IP'
  if (!window.confirm(`确认${action}「${ip.name}」（${ip.ipAddress || '尚未分配'}，${ip.region}）？删除后原地址可能无法找回。`)) return
  deletingId.value = ip.id
  error.value = ''
  success.value = ''
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
.success-message { color: var(--green); margin-bottom: 12px; overflow-wrap: anywhere; }
.create-ip-form { padding: 16px; border: 1px solid var(--border-color, #d6d9e0); border-radius: 8px; margin-bottom: 16px; }
.create-ip-actions { display: flex; flex-wrap: wrap; gap: 8px; }
small { color: var(--text-secondary); }
.association { max-width: 240px; overflow-wrap: anywhere; font-size: 11px; color: var(--text-secondary); }
</style>
