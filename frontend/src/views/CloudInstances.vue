<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>云实例</h1>
        <p>统一管理 Oracle、AWS、Azure 等计算实例。</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-ghost" :disabled="!selectedAccountId || loading" @click="refreshCurrent">刷新</button>
        <button class="btn btn-primary" :disabled="!selectedAccountId || !canCreate" @click="openCreate">新建实例</button>
      </div>
    </div>

    <div class="account-selector">
      <button v-for="account in accounts" :key="account.id"
        :class="['account-chip', selectedAccountId === account.id ? 'active' : '']" @click="selectAccount(account.id)">
        <span class="chip-provider">{{ providerToken(account.computeProvider) }}</span>
        <span>{{ providerLabel(account.computeProvider) }} / {{ account.name }}</span>
      </button>
    </div>

    <div v-if="!selectedAccountId" class="card empty-state">
      <div class="empty-icon">!</div>
      <p>请选择一个计算账户。</p>
    </div>

    <template v-else>
      <div v-if="loading" class="card loading-wrap">
        <div class="spinner"></div>
      </div>

      <template v-else>
        <div class="card summary-card">
          <div class="summary-item">
            <span class="summary-label">账户</span>
            <span class="summary-value">{{ selectedAccount?.name || '-' }}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">厂商</span>
            <span class="summary-value">{{ providerLabel(selectedAccount?.computeProvider) }}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">实例数量</span>
            <span class="summary-value">{{ instances.length }}</span>
          </div>
        </div>

        <div v-if="isAzureAccount" class="card azure-filter-card">
          <div class="section-header">
            <h2>Azure 订阅</h2>
          </div>
          <div class="form-group">
            <label>订阅</label>
            <select v-model="azureSubscriptionId" class="form-control" :disabled="loadingAzureSubscriptions"
              @change="handleAzureSubscriptionChange">
              <option value="" disabled>
                {{ loadingAzureSubscriptions ? '正在加载订阅...' : '当前账号下没有符合条件的订阅' }}
              </option>
              <option v-for="subscription in azureSubscriptions" :key="subscription.subscriptionId"
                :value="subscription.subscriptionId">
                {{ subscription.displayName }}
              </option>
            </select>
          </div>
        </div>

        <div v-if="isAzureAccount && !azureSubscriptionId" class="card empty-state">
          <div class="empty-icon">-</div>
          <p>当前 Azure 账户下没有可用的学生优惠 / 免费订阅。</p>
        </div>

        <div v-else-if="instances.length === 0" class="card empty-state">
          <div class="empty-icon">-</div>
          <p>当前账户下还没有实例。</p>
        </div>

        <div v-else class="instances-grid">
          <div v-for="instance in instances" :key="instance.id" class="card instance-card">
            <div class="instance-card-header">
              <div>
                <div class="instance-name">{{ instance.displayName || instance.id }}</div>
                <div class="instance-subtitle">{{ instance.region || '-' }} / {{ instance.shape || '-' }}</div>
              </div>
              <span :class="['badge', stateClass(instance.state)]">{{ stateLabel(instance.state) }}</span>
            </div>

            <div class="instance-info">
              <div class="info-row">
                <span class="info-label">实例 ID</span>
                <span class="info-value info-mono" :title="instance.id">{{ shortText(instance.id) }}</span>
              </div>
              <div class="info-row" v-if="instance.cpu || instance.memoryGb">
                <span class="info-label">配置</span>
                <span class="info-value">{{ formatConfig(instance) }}</span>
              </div>
              <div class="info-row" v-if="instance.publicIps?.length">
                <span class="info-label">公网 IP</span>
                <div class="ip-list">
                  <span v-for="ip in instance.publicIps" :key="ip" class="ip-tag">{{ ip }}</span>
                </div>
              </div>
              <div class="info-row" v-if="instance.privateIps?.length">
                <span class="info-label">私网 IP</span>
                <div class="ip-list">
                  <span v-for="ip in instance.privateIps" :key="ip" class="ip-tag ip-tag-muted">{{ ip }}</span>
                </div>
              </div>
              <div class="info-row" v-if="instance.ipv6Addresses?.length">
                <span class="info-label">IPv6</span>
                <span class="info-value" :title="instance.ipv6Addresses[0]">{{ shortText(instance.ipv6Addresses[0], 26)
                  }}</span>
              </div>
            </div>

            <div class="divider"></div>

            <div class="action-row">
              <button v-if="['STOPPED', 'TERMINATED'].includes(normalizeState(instance.state))"
                class="btn btn-success btn-sm" @click="runAction(instance, 'START')">
                启动
              </button>
              <button v-if="normalizeState(instance.state) === 'RUNNING'" class="btn btn-warning btn-sm"
                @click="runAction(instance, 'STOP')">
                停止
              </button>
              <button v-if="normalizeState(instance.state) === 'RUNNING'" class="btn btn-ghost btn-sm"
                @click="runAction(instance, 'REBOOT')">
                重启
              </button>
              <button v-if="hasCapability('switch_ip') || hasCapability('elastic_ip')" class="btn btn-ghost btn-sm"
                @click="openSwitchIp(instance)">
                切换 IP
              </button>
              <button v-if="hasCapability('ipv6') && !instance.ipv6Addresses?.length" class="btn btn-ghost btn-sm"
                @click="addIpv6(instance)">
                添加 IPv6
              </button>
              <button v-if="hasCapability('modify_config')" class="btn btn-ghost btn-sm"
                @click="openModifyShape(instance)">
                修改配置
              </button>
              <button v-if="hasCapability('allow_all_inbound_traffic')" class="btn btn-ghost btn-sm"
                @click="allowAllFirewall(instance)">
                放通防火墙
              </button>
              <button class="btn btn-danger btn-sm" @click="terminate(instance)">删除</button>
            </div>
          </div>
        </div>

        <div v-if="hasCapability('elastic_ip') && elasticIps.length" class="card section-card">
          <div class="section-header">
            <h2>弹性 IP</h2>
            <button class="btn btn-warning btn-sm" @click="releaseUnusedAwsIps">释放空闲 IP</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>公网 IP</th>
                  <th>Allocation ID</th>
                  <th>关联实例</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in elasticIps" :key="item.allocationId">
                  <td>{{ item.publicIp }}</td>
                  <td class="info-mono">{{ shortText(item.allocationId) }}</td>
                  <td>{{ item.instanceId || '-' }}</td>
                  <td>{{ item.associated ? '已关联' : '空闲' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="hasCapability('create_network') || hasCapability('list_boot_volumes')" class="card section-card">
          <div class="section-header">
            <h2>高级功能</h2>
          </div>
          <div class="header-actions">
            <button v-if="hasCapability('create_network')" class="btn btn-primary" :disabled="settingUpNetwork"
              @click="setupNetwork">
              {{ settingUpNetwork ? '创建中...' : '自动创建网络' }}
            </button>
            <button v-if="hasCapability('list_boot_volumes')" class="btn btn-ghost"
              @click="openVolumesModal">管理引导卷</button>
          </div>
        </div>
      </template>
    </template>

    <div v-if="showCreateModal" class="modal-overlay" @click.self="closeCreate">
      <div class="modal">
        <div class="modal-header">
          <h3>创建 {{ providerLabel(selectedAccount?.computeProvider) }} 实例</h3>
          <button class="modal-close" @click="closeCreate">x</button>
        </div>

        <template v-if="selectedAccount?.computeProvider === 'oracle'">
          <div class="form-group">
            <label>实例规格</label>
            <select v-model="createForm.shape" class="form-control">
              <option value="VM.Standard.A1.Flex">VM.Standard.A1.Flex</option>
              <option value="VM.Standard.E2.1.Micro">VM.Standard.E2.1.Micro</option>
              <option value="VM.Standard3.Flex">VM.Standard3.Flex</option>
            </select>
          </div>
          <div class="form-grid">
            <div class="form-group">
              <label>OCPU</label>
              <input v-model.number="createForm.ocpus" type="number" min="1" class="form-control" />
            </div>
            <div class="form-group">
              <label>内存 (GB)</label>
              <input v-model.number="createForm.memoryGb" type="number" min="1" class="form-control" />
            </div>
          </div>
          <div class="form-group">
            <label>root 密码</label>
            <input v-model="createForm.rootPassword" type="password" class="form-control"
              placeholder="请输入 Oracle root 密码" />
            <small class="form-hint">8-100 位，至少包含大小写、数字和特殊字符。</small>
          </div>
          <div class="form-group">
            <label>重试间隔 (秒)</label>
            <input v-model.number="createForm.delay" type="number" min="10" max="300" class="form-control" />
          </div>
        </template>

        <template v-else-if="selectedAccount?.computeProvider === 'aws'">
          <div class="form-group">
            <label>实例规格</label>
            <input v-model="createForm.instanceType" class="form-control" placeholder="t2.micro" />
          </div>
          <div class="form-group">
            <label>AMI ID</label>
            <input v-model="createForm.imageId" class="form-control" placeholder="留空则自动选择默认镜像" />
          </div>
        </template>

        <template v-else-if="selectedAccount?.computeProvider === 'azure'">
          <div class="form-group">
            <label>订阅</label>
            <select v-model="createForm.subscriptionId" class="form-control" disabled>
              <option :value="createForm.subscriptionId">{{ selectedAzureSubscription?.displayName || '未选择订阅' }}
              </option>
            </select>
          </div>
          <div class="form-grid">
            <div class="form-group">
              <label>Location</label>
              <select v-model="createForm.location" class="form-control"
                :disabled="loadingAzureLocations || !createForm.subscriptionId" @change="handleAzureLocationChange">
                <option value="" disabled>
                  {{ loadingAzureLocations ? '正在加载 Location...' : '请选择 Location' }}
                </option>
                <option v-for="location in azureLocations" :key="location.name" :value="location.name">
                  {{ location.displayName }} ({{ location.name }})
                </option>
              </select>
            </div>
            <div class="form-group">
              <label>VM Size</label>
              <select v-model="createForm.vmSize" class="form-control"
                :disabled="loadingAzureVmSizes || !createForm.location">
                <option value="" disabled>
                  {{ loadingAzureVmSizes ? '正在加载 VM Size...' : '请选择 VM Size' }}
                </option>
                <option v-for="size in azureVmSizes" :key="size.name" :value="size.name">
                  {{ size.label || size.name }}
                </option>
              </select>
            </div>
          </div>
          <div class="form-grid">
            <div class="form-group">
              <label>Admin Username</label>
              <input v-model="createForm.adminUsername" class="form-control" placeholder="azureuser" />
            </div>
            <div class="form-group">
              <label>Admin Password</label>
              <input v-model="createForm.adminPassword" type="password" class="form-control" />
            </div>
          </div>
          <div class="form-hint">
            默认镜像使用 Ubuntu 22.04 LTS Gen2，资源组和网络会按当前框架自动创建并复用。
          </div>
        </template>

        <div class="modal-footer">
          <button class="btn btn-ghost" @click="closeCreate">取消</button>
          <button class="btn btn-primary" :disabled="creating" @click="submitCreate">
            {{ creating ? '提交中...' : '加入任务队列' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showSwitchIpModal" class="modal-overlay" @click.self="closeSwitchIp">
      <div class="modal">
        <div class="modal-header">
          <h3>切换公网 IP</h3>
          <button class="modal-close" @click="closeSwitchIp">x</button>
        </div>
        <p class="modal-desc">实例：{{ selectedInstance?.displayName || selectedInstance?.id || '-' }}</p>
        <div class="form-group">
          <label>同步更新 DNS 账户（可选）</label>
          <select v-model="switchIpForm.dnsAccountId" class="form-control">
            <option value="">不更新 DNS</option>
            <option v-for="account in dnsAccounts" :key="account.id" :value="account.id">{{ account.name }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>记录名</label>
          <input v-model="switchIpForm.dnsRecord" class="form-control" placeholder="例如 www.frp.gs" />
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="closeSwitchIp">取消</button>
          <button class="btn btn-primary" :disabled="switchingIp" @click="confirmSwitchIp">
            {{ switchingIp ? '执行中...' : '确认切换' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showShapeModal" class="modal-overlay" @click.self="closeShape">
      <div class="modal">
        <div class="modal-header">
          <h3>修改实例配置</h3>
          <button class="modal-close" @click="closeShape">x</button>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>OCPU</label>
            <input v-model.number="shapeForm.ocpus" type="number" min="1" class="form-control" />
          </div>
          <div class="form-group">
            <label>内存 (GB)</label>
            <input v-model.number="shapeForm.memoryGb" type="number" min="1" class="form-control" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="closeShape">取消</button>
          <button class="btn btn-primary" :disabled="modifyingShape" @click="confirmModifyShape">
            {{ modifyingShape ? '提交中...' : '确认修改' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showVolumesModal" class="modal-overlay" @click.self="closeVolumes">
      <div class="modal modal-wide">
        <div class="modal-header">
          <h3>引导卷列表</h3>
          <button class="modal-close" @click="closeVolumes">x</button>
        </div>
        <div v-if="loadingVolumes" class="loading-wrap">
          <div class="spinner"></div>
        </div>
        <div v-else-if="!volumes.length" class="empty-state">
          <p>没有可管理的引导卷。</p>
        </div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>容量</th>
                <th>状态</th>
                <th>ID</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="volume in volumes" :key="volume.id">
                <td>{{ volume.displayName }}</td>
                <td>{{ volume.sizeInGBs }} GB</td>
                <td>{{ volume.state }}</td>
                <td class="info-mono">{{ shortText(volume.id) }}</td>
                <td><button class="btn btn-danger btn-sm" @click="deleteVolume(volume.id)">删除</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { accountsApi, cloudApi } from '../api/index.js'

const accounts = ref([])
const dnsAccounts = ref([])
const selectedAccountId = ref('')
const instances = ref([])
const elasticIps = ref([])
const capabilities = ref([])
const loading = ref(false)

const azureSubscriptions = ref([])
const azureSubscriptionId = ref('')
const azureLocations = ref([])
const azureVmSizes = ref([])
const loadingAzureSubscriptions = ref(false)
const loadingAzureLocations = ref(false)
const loadingAzureVmSizes = ref(false)

const showCreateModal = ref(false)
const showSwitchIpModal = ref(false)
const showShapeModal = ref(false)
const showVolumesModal = ref(false)

const selectedInstance = ref(null)
const creating = ref(false)
const switchingIp = ref(false)
const modifyingShape = ref(false)
const settingUpNetwork = ref(false)
const loadingVolumes = ref(false)

const volumes = ref([])
const createForm = ref({})
const switchIpForm = ref({ dnsAccountId: '', dnsRecord: '' })
const shapeForm = ref({ ocpus: 1, memoryGb: 6 })

const selectedAccount = computed(() => accounts.value.find((item) => item.id === selectedAccountId.value) || null)
const isAzureAccount = computed(() => selectedAccount.value?.computeProvider === 'azure')
const selectedAzureSubscription = computed(
  () => azureSubscriptions.value.find((item) => item.subscriptionId === azureSubscriptionId.value) || null
)
const canCreate = computed(() => {
  if (!selectedAccount.value) return false
  if (selectedAccount.value.computeProvider === 'azure') return Boolean(azureSubscriptionId.value)
  return ['oracle', 'aws', 'azure'].includes(selectedAccount.value.computeProvider)
})

onMounted(async () => {
  await loadAccounts()
})

async function loadAccounts() {
  const [accountRes, dnsRes] = await Promise.all([accountsApi.list(), accountsApi.listDns()])
  accounts.value = (accountRes.data || []).filter((item) => item.computeProvider)
  dnsAccounts.value = dnsRes.data || []

  if (accounts.value.length && !selectedAccountId.value) {
    await selectAccount(accounts.value[0].id)
  }
}

async function selectAccount(id) {
  selectedAccountId.value = id
  resetTransientState()

  if (selectedAccount.value?.computeProvider === 'azure') {
    await loadAzureSubscriptions()
  } else {
    resetAzureState()
  }

  await refreshCurrent()
}

function resetTransientState() {
  showCreateModal.value = false
  showSwitchIpModal.value = false
  showShapeModal.value = false
  showVolumesModal.value = false
  selectedInstance.value = null
  createForm.value = {}
  switchIpForm.value = { dnsAccountId: '', dnsRecord: '' }
  shapeForm.value = { ocpus: 1, memoryGb: 6 }
  volumes.value = []
}

function resetAzureState() {
  azureSubscriptions.value = []
  azureSubscriptionId.value = ''
  azureLocations.value = []
  azureVmSizes.value = []
}

function getAzureSubscriptionStorageKey() {
  return `cloud-manager:azure-subscription:${selectedAccountId.value}`
}

function getRequestParams(extra = {}) {
  if (isAzureAccount.value && azureSubscriptionId.value) {
    return { ...extra, subscriptionId: azureSubscriptionId.value }
  }
  return extra
}

function getRequestBody(extra = {}) {
  if (isAzureAccount.value && azureSubscriptionId.value) {
    return { ...extra, subscriptionId: azureSubscriptionId.value }
  }
  return extra
}

function pickDefaultLocation(locations = []) {
  const preferred = ['eastasia', 'southeastasia', 'japaneast']
  const matched = preferred.find((name) => locations.some((item) => item.name === name))
  return matched || locations[0]?.name || ''
}

function pickDefaultVmSize(sizes = []) {
  const preferred = ['Standard_B1s', 'Standard_B2s', 'Standard_A1_v2']
  const matched = preferred.find((name) => sizes.some((item) => item.name === name))
  return matched || sizes[0]?.name || ''
}

async function loadAzureSubscriptions() {
  if (!selectedAccountId.value) return

  loadingAzureSubscriptions.value = true
  resetAzureState()

  try {
    const response = await cloudApi.listAzureSubscriptions(selectedAccountId.value)
    azureSubscriptions.value = response.data || []

    const savedSubscriptionId = localStorage.getItem(getAzureSubscriptionStorageKey()) || ''
    const selected =
      azureSubscriptions.value.find((item) => item.subscriptionId === savedSubscriptionId) || azureSubscriptions.value[0] || null

    azureSubscriptionId.value = selected?.subscriptionId || ''
    if (azureSubscriptionId.value) {
      localStorage.setItem(getAzureSubscriptionStorageKey(), azureSubscriptionId.value)
      await loadAzureLocations()
    }
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  } finally {
    loadingAzureSubscriptions.value = false
  }
}

async function loadAzureLocations() {
  azureLocations.value = []
  azureVmSizes.value = []

  if (!selectedAccountId.value || !azureSubscriptionId.value) {
    return
  }

  loadingAzureLocations.value = true
  try {
    const response = await cloudApi.listAzureLocations(selectedAccountId.value, {
      subscriptionId: azureSubscriptionId.value
    })
    azureLocations.value = response.data || []

    const hasCurrentLocation = azureLocations.value.some((item) => item.name === createForm.value.location)
    createForm.value.location = hasCurrentLocation ? createForm.value.location : pickDefaultLocation(azureLocations.value)

    await loadAzureVmSizes()
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  } finally {
    loadingAzureLocations.value = false
  }
}

async function loadAzureVmSizes() {
  azureVmSizes.value = []

  if (!selectedAccountId.value || !azureSubscriptionId.value || !createForm.value.location) {
    createForm.value.vmSize = ''
    return
  }

  loadingAzureVmSizes.value = true
  try {
    const response = await cloudApi.listAzureVmSizes(selectedAccountId.value, {
      subscriptionId: azureSubscriptionId.value,
      location: createForm.value.location
    })
    azureVmSizes.value = response.data || []

    const hasCurrentVmSize = azureVmSizes.value.some((item) => item.name === createForm.value.vmSize)
    createForm.value.vmSize = hasCurrentVmSize ? createForm.value.vmSize : pickDefaultVmSize(azureVmSizes.value)
  } catch (error) {
    createForm.value.vmSize = ''
    toast(error.response?.data?.error || error.message, 'error')
  } finally {
    loadingAzureVmSizes.value = false
  }
}

async function handleAzureSubscriptionChange() {
  if (!azureSubscriptionId.value) {
    azureLocations.value = []
    azureVmSizes.value = []
    instances.value = []
    elasticIps.value = []
    capabilities.value = []
    return
  }

  localStorage.setItem(getAzureSubscriptionStorageKey(), azureSubscriptionId.value)

  if (showCreateModal.value) {
    createForm.value.subscriptionId = azureSubscriptionId.value
    createForm.value.location = ''
    createForm.value.vmSize = ''
  }

  await loadAzureLocations()
  await refreshCurrent()
}

async function handleAzureLocationChange() {
  createForm.value.vmSize = ''
  await loadAzureVmSizes()
}

async function refreshCurrent() {
  if (!selectedAccountId.value) return
  if (isAzureAccount.value && !azureSubscriptionId.value) {
    loading.value = false
    instances.value = []
    elasticIps.value = []
    capabilities.value = []
    return
  }

  loading.value = true
  instances.value = []
  elasticIps.value = []
  capabilities.value = []

  try {
    const [capabilitiesRes, instanceRes] = await Promise.all([
      cloudApi.capabilities(selectedAccountId.value, getRequestParams()),
      cloudApi.listInstances(selectedAccountId.value, getRequestParams())
    ])

    capabilities.value = capabilitiesRes.data.capabilities || []
    instances.value = instanceRes.data || []

    if (hasCapability('elastic_ip')) {
      const eipRes = await cloudApi.listElasticIps(selectedAccountId.value, getRequestParams())
      elasticIps.value = eipRes.data || []
    }
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  } finally {
    loading.value = false
  }
}

function providerLabel(provider) {
  if (provider === 'oracle') return 'Oracle'
  if (provider === 'aws') return 'AWS'
  if (provider === 'azure') return 'Azure'
  return provider || '-'
}

function providerToken(provider) {
  if (provider === 'oracle') return 'OCI'
  if (provider === 'aws') return 'AWS'
  if (provider === 'azure') return 'AZ'
  return '--'
}

function hasCapability(capability) {
  return capabilities.value.includes(capability)
}

async function openCreate() {
  if (!selectedAccount.value) {
    toast('请先选择计算账户', 'error')
    return
  }

  if (selectedAccount.value.computeProvider === 'oracle') {
    createForm.value = {
      shape: 'VM.Standard.A1.Flex',
      ocpus: 1,
      memoryGb: 6,
      rootPassword: '',
      delay: 60
    }
  } else if (selectedAccount.value.computeProvider === 'aws') {
    createForm.value = {
      instanceType: 't2.micro',
      imageId: ''
    }
  } else {
    if (!azureSubscriptionId.value) {
      toast('当前 Azure 账户没有可用的学生优惠 / 免费订阅', 'error')
      return
    }

    createForm.value = {
      subscriptionId: azureSubscriptionId.value,
      location: '',
      vmSize: '',
      adminUsername: 'azureuser',
      adminPassword: ''
    }

    await loadAzureLocations()
  }

  showCreateModal.value = true
}

function closeCreate() {
  showCreateModal.value = false
}

async function submitCreate() {
  if (selectedAccount.value?.computeProvider === 'oracle') {
    const passwordError = validateOraclePassword(createForm.value.rootPassword)
    if (passwordError) {
      toast(passwordError, 'error')
      return
    }
  }

  if (selectedAccount.value?.computeProvider === 'azure') {
    if (!createForm.value.subscriptionId) {
      toast('请选择 Azure 订阅', 'error')
      return
    }
    if (!createForm.value.location) {
      toast('请选择 Location', 'error')
      return
    }
    if (!createForm.value.vmSize) {
      toast('请选择 VM Size', 'error')
      return
    }
    if (!createForm.value.adminUsername) {
      toast('Azure 实例创建需要 adminUsername', 'error')
      return
    }
    if (!createForm.value.adminPassword) {
      toast('Azure 实例创建需要 adminPassword', 'error')
      return
    }
  }

  creating.value = true
  try {
    await cloudApi.createInstance(selectedAccountId.value, getRequestBody(createForm.value))
    toast('创建任务已加入队列，请到任务队列查看进度', 'success')
    closeCreate()
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  } finally {
    creating.value = false
  }
}

async function runAction(instance, action) {
  try {
    await cloudApi.instanceAction(selectedAccountId.value, instance.id, action, getRequestBody())
    toast(`${actionLabel(action)}指令已发送`, 'success')
    setTimeout(refreshCurrent, 1500)
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  }
}

async function terminate(instance) {
  const ok = window.confirm(`确认删除实例「${instance.displayName || instance.id}」吗？此操作不可恢复。`)
  if (!ok) return

  try {
    await cloudApi.deleteInstance(selectedAccountId.value, instance.id, getRequestParams())
    toast('实例删除请求已发送', 'success')
    await refreshCurrent()
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  }
}

function openSwitchIp(instance) {
  selectedInstance.value = instance
  switchIpForm.value = { dnsAccountId: '', dnsRecord: '' }
  showSwitchIpModal.value = true
}

function closeSwitchIp() {
  showSwitchIpModal.value = false
}

async function confirmSwitchIp() {
  switchingIp.value = true
  try {
    const payload = getRequestBody()
    if (switchIpForm.value.dnsAccountId && switchIpForm.value.dnsRecord) {
      payload.dnsAccountId = switchIpForm.value.dnsAccountId
      payload.dnsRecord = switchIpForm.value.dnsRecord
    }

    const response = await cloudApi.switchIp(selectedAccountId.value, selectedInstance.value.id, payload)
    toast(`IP 已切换为 ${response.data.newIp || response.data.newPublicIp}`, 'success')
    closeSwitchIp()
    await refreshCurrent()
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  } finally {
    switchingIp.value = false
  }
}

async function addIpv6(instance) {
  try {
    await cloudApi.addIpv6(selectedAccountId.value, instance.id, getRequestBody())
    toast('IPv6 已添加', 'success')
    await refreshCurrent()
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  }
}

function openModifyShape(instance) {
  selectedInstance.value = instance
  shapeForm.value = {
    ocpus: instance.cpu || 1,
    memoryGb: instance.memoryGb || 6
  }
  showShapeModal.value = true
}

function closeShape() {
  showShapeModal.value = false
}

async function confirmModifyShape() {
  const ok = window.confirm('确认修改实例配置吗？该操作可能导致实例短暂中断。')
  if (!ok) return

  modifyingShape.value = true
  try {
    await cloudApi.modifyShape(selectedAccountId.value, selectedInstance.value.id, getRequestBody(shapeForm.value))
    toast('配置修改请求已发送', 'success')
    closeShape()
    await refreshCurrent()
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  } finally {
    modifyingShape.value = false
  }
}

async function allowAllFirewall(instance) {
  const ok = window.confirm(`确认放通实例「${instance.displayName || instance.id}」的全部入站规则吗？`)
  if (!ok) return

  try {
    await cloudApi.allowAllFirewall(selectedAccountId.value, instance.id, getRequestBody())
    toast('防火墙规则已放通', 'success')
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  }
}

async function releaseUnusedAwsIps() {
  const ok = window.confirm('确认释放所有空闲弹性 IP 吗？')
  if (!ok) return

  try {
    const response = await cloudApi.releaseUnused(selectedAccountId.value, getRequestBody())
    toast(`已释放 ${response.data.released || 0} 个空闲 IP`, 'success')
    await refreshCurrent()
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  }
}

async function setupNetwork() {
  const ok = window.confirm('确认自动创建当前账户所需的网络资源吗？')
  if (!ok) return

  settingUpNetwork.value = true
  try {
    await cloudApi.setupNetwork(selectedAccountId.value, getRequestBody())
    toast('网络资源创建完成', 'success')
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  } finally {
    settingUpNetwork.value = false
  }
}

async function openVolumesModal() {
  showVolumesModal.value = true
  loadingVolumes.value = true
  volumes.value = []

  try {
    const response = await cloudApi.listVolumes(selectedAccountId.value, getRequestParams())
    volumes.value = response.data || []
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  } finally {
    loadingVolumes.value = false
  }
}

function closeVolumes() {
  showVolumesModal.value = false
}

async function deleteVolume(volumeId) {
  const ok = window.confirm('确认删除该引导卷吗？')
  if (!ok) return

  try {
    await cloudApi.deleteVolume(selectedAccountId.value, volumeId, getRequestParams())
    toast('引导卷删除请求已发送', 'success')
    await openVolumesModal()
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  }
}

function toast(message, type = 'info') {
  window.$toast?.(message, type)
}

function normalizeState(state) {
  return String(state || '').toUpperCase()
}

function stateClass(state) {
  const current = normalizeState(state)
  if (current === 'RUNNING') return 'badge-running'
  if (['STOPPED', 'TERMINATED'].includes(current)) return 'badge-stopped'
  return 'badge-pending'
}

function stateLabel(state) {
  const current = normalizeState(state)
  const labels = {
    RUNNING: '运行中',
    STOPPED: '已停止',
    STOPPING: '停止中',
    STARTING: '启动中',
    PROVISIONING: '创建中',
    TERMINATED: '已终止',
    TERMINATING: '终止中',
    REBOOTING: '重启中',
    PENDING: '等待中'
  }
  return labels[current] || current || '未知'
}

function actionLabel(action) {
  const labels = {
    START: '启动',
    STOP: '停止',
    REBOOT: '重启',
    HARD_REBOOT: '强制重启'
  }
  return labels[action] || action
}

function formatConfig(instance) {
  const parts = []
  if (instance.cpu) parts.push(`${instance.cpu} vCPU`)
  if (instance.memoryGb) parts.push(`${instance.memoryGb} GB`)
  return parts.join(' / ')
}

function shortText(text, length = 18) {
  if (!text) return '-'
  if (text.length <= length) return text
  return `${text.slice(0, length)}...`
}

function validateOraclePassword(password) {
  const allowedSpecials = /[!#$%&'()*+,\-./:;<=>?@[\\\]^_{|}~]/
  const invalidChars = /[^A-Za-z\d!#$%&'()*+,\-./:;<=>?@[\\\]^_{|}~]/

  if (!password) return '请输入 Oracle 实例 root 密码'
  if (password.length < 8 || password.length > 100) return 'Oracle 实例密码长度必须在 8 到 100 位之间'
  if (!/[a-z]/.test(password)) return 'Oracle 实例密码至少包含 1 个小写字母'
  if (!/[A-Z]/.test(password)) return 'Oracle 实例密码至少包含 1 个大写字母'
  if (!/\d/.test(password)) return 'Oracle 实例密码至少包含 1 个数字'
  if (!allowedSpecials.test(password)) return 'Oracle 实例密码至少包含 1 个特殊字符'
  if (invalidChars.test(password)) return 'Oracle 实例密码包含不支持的字符'
  return ''
}
</script>

<style scoped>
.header-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.chip-provider {
  font-family: Consolas, monospace;
  font-size: 11px;
  opacity: 0.8;
}

.loading-wrap {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 140px;
}

.summary-card {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.summary-label {
  font-size: 12px;
  color: var(--text-muted);
}

.summary-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.azure-filter-card {
  margin-bottom: 20px;
}

.subscription-tip {
  font-size: 12px;
  color: var(--text-muted);
}

.instances-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}

.instance-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.instance-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.instance-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.instance-subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.instance-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.info-label {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}

.info-value {
  font-size: 12px;
  color: var(--text-secondary);
  text-align: right;
  word-break: break-all;
}

.info-mono {
  font-family: Consolas, monospace;
}

.ip-list {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}

.ip-tag-muted {
  background: var(--bg-input);
  color: var(--text-muted);
}

.section-card {
  margin-top: 24px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.section-header h2 {
  margin: 0;
  font-size: 15px;
}

.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.form-hint {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.modal-desc {
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--text-secondary);
}

.modal-wide {
  width: min(960px, 92vw);
  max-width: 960px;
}

@media (max-width: 768px) {
  .form-grid {
    grid-template-columns: 1fr;
  }

  .instances-grid {
    grid-template-columns: 1fr;
  }
}
</style>
