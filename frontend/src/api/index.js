import axios from 'axios'

const AUTH_TOKEN_KEY = 'cloud-manager-auth-token'

const api = axios.create({ baseURL: '/api' })

export function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || ''
}

export function setAuthToken(token) {
  if (token) localStorage.setItem(AUTH_TOKEN_KEY, token)
  else localStorage.removeItem(AUTH_TOKEN_KEY)
}

api.interceptors.request.use((config) => {
  const token = getAuthToken()
  if (token) {
    config.headers = config.headers || {}
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && !String(error.config?.url || '').startsWith('/auth/')) {
      setAuthToken('')
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export const accountsApi = {
  list: () => api.get('/accounts'),
  create: (data) => api.post('/accounts', data),
  update: (id, data) => api.put(`/accounts/${id}`, data),
  delete: (id) => api.delete(`/accounts/${id}`),
  test: (id) => api.post(`/accounts/${id}/test`),
  listDns: () => api.get('/accounts/dns'),
  createDns: (data) => api.post('/accounts/dns', data),
  updateDns: (id, data) => api.put(`/accounts/dns/${id}`, data),
  deleteDns: (id) => api.delete(`/accounts/dns/${id}`),
  testDns: (id) => api.post(`/accounts/dns/${id}/test`)
}

export const cloudApi = {
  listInstances: (accountId) => api.get(`/cloud/${accountId}/instances`),
  getInstance: (accountId, instanceId) => api.get(`/cloud/${accountId}/instances/${instanceId}`),
  createInstance: (accountId, data) => api.post(`/cloud/${accountId}/instances`, data),
  instanceAction: (accountId, instanceId, action) =>
    api.post(`/cloud/${accountId}/instances/${instanceId}/action`, { action }),
  deleteInstance: (accountId, instanceId) => api.delete(`/cloud/${accountId}/instances/${instanceId}`),
  switchIp: (accountId, instanceId, data) =>
    api.post(`/cloud/${accountId}/instances/${instanceId}/switch-ip`, data),
  addIpv6: (accountId, instanceId) => api.post(`/cloud/${accountId}/instances/${instanceId}/add-ipv6`),
  listElasticIps: (accountId) => api.get(`/cloud/${accountId}/elastic-ips`),
  releaseUnused: (accountId) => api.post(`/cloud/${accountId}/elastic-ips/release-unused`),
  capabilities: (accountId) => api.get(`/cloud/${accountId}/capabilities`),
  modifyShape: (accountId, instanceId, data) =>
    api.put(`/cloud/${accountId}/instances/${instanceId}/shape`, data),
  allowAllFirewall: (accountId, instanceId) =>
    api.post(`/cloud/${accountId}/instances/${instanceId}/firewall/allow-all`),
  listVolumes: (accountId) => api.get(`/cloud/${accountId}/volumes`),
  deleteVolume: (accountId, volumeId) => api.delete(`/cloud/${accountId}/volumes/${volumeId}`),
  setupNetwork: (accountId) => api.post(`/cloud/${accountId}/network/setup`)
}

export const dnsApi = {
  listRecords: (dnsAccountId, filters) => api.get(`/dns/${dnsAccountId}/records`, { params: filters }),
  upsertRecord: (dnsAccountId, data) => api.post(`/dns/${dnsAccountId}/records`, data),
  deleteRecord: (dnsAccountId, data) => api.delete(`/dns/${dnsAccountId}/records`, { data })
}

export const tasksApi = {
  list: (params) => api.get('/tasks', { params }),
  cancel: (id) => api.delete(`/tasks/${id}`)
}

export const settingsApi = {
  get: () => api.get('/settings'),
  updateTelegram: (data) => api.put('/settings/telegram', data)
}

export const authApi = {
  status: () => api.get('/auth/status'),
  login: (data) => api.post('/auth/login', data),
  logout: () => api.post('/auth/logout'),
  updateAccount: (data) => api.post('/auth/update-account', data)
}

export const providersApi = {
  list: () => api.get('/providers')
}
