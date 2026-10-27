import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { parse, compileScript } = require('@vue/compiler-sfc')
const { ref, computed } = require('vue')
const source = readFileSync(new URL('../frontend/src/views/CloudInstances.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: 'loading-test', genDefaultAs: 'component' }).content
  .replace(/^import (.+) from '([^']+)'\r?$/gm, (_, binding, path) => {
    if (path === 'vue') return `const ${binding} = deps.vue`
    if (path.endsWith('/api/index.js')) return `const ${binding} = deps.api`
    if (path.endsWith('/dnsRecordName.js')) return `const ${binding} = deps.dns`
    return `const ${binding} = {}`
  })

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const azure = { id: 'azure', name: 'Azure test', computeProvider: 'azure' }
const subscriptions = { data: [{ subscriptionId: 'sub', displayName: 'Subscription' }] }
function fixture(overrides = {}) {
  const api = {
    accountsApi: { list: async () => ({ data: [azure] }), listDns: async () => ({ data: [] }) },
    cloudApi: { listAzureSubscriptions: async () => subscriptions,
      capabilities: async () => ({ data: { capabilities: [] } }), listInstances: async () => ({ data: [] }),
      listAzureLocations: async () => assert.fail('instance browsing must not wait for creation locations') },
    dnsApi: {}
  }
  for (const [key, value] of Object.entries(overrides)) Object.assign(api[key], value)
  const component = new Function('deps', 'window', 'localStorage', compiled + '\nreturn component')({
    vue: { ref, computed, onMounted() {}, onBeforeUnmount() {} }, api, dns: { toFullRecordName() {} }
  }, { $toast() {} }, { getItem() {}, setItem() {} })
  return { page: component.setup({}, { expose() {} }), api }
}

test('loading covers account discovery, Azure subscription discovery and instance requests before showing an empty result', async () => {
  const account = deferred(), subscription = deferred(), instances = deferred()
  const { page } = fixture({ accountsApi: { list: () => account.promise }, cloudApi: {
    listAzureSubscriptions: () => subscription.promise, listInstances: () => instances.promise
  } })
  assert.equal(page.pageLoading.value, true)
  const loading = page.loadAccounts()
  assert.match(page.loadingMessage.value, /计算账户/)
  account.resolve({ data: [azure] })
  await tick()
  assert.match(page.loadingMessage.value, /订阅/)
  assert.equal(page.instancesLoaded.value, false)
  subscription.resolve(subscriptions)
  await tick()
  assert.equal(page.pageLoading.value, true)
  assert.match(page.loadingMessage.value, /实例/)
  instances.resolve({ data: [] })
  await loading
  assert.equal(page.pageLoading.value, false)
  assert.equal(page.instancesLoaded.value, true)
  assert.deepEqual(page.instances.value, [])
})

test('account and subscription failures remain visible and subscription retry reloads discovery', async () => {
  const { page, api } = fixture({ accountsApi: { list: async () => { throw new Error('account timeout') } } })
  await page.loadAccounts()
  assert.equal(page.pageLoading.value, false)
  assert.equal(page.accountsError.value, 'account timeout')
  api.accountsApi.list = async () => ({ data: [azure] })
  api.cloudApi.listAzureSubscriptions = async () => { throw new Error('subscription denied') }
  await page.loadAccounts()
  assert.equal(page.accountsError.value, '')
  assert.equal(page.resourceError.value, 'subscription denied')
  assert.equal(page.instancesLoaded.value, false)
  api.cloudApi.listAzureSubscriptions = async () => subscriptions
  await page.retryResources()
  assert.equal(page.resourceError.value, '')
  assert.equal(page.instancesLoaded.value, true)
})

test('failed instance request is not a successful empty list and can be retried', async () => {
  const { page, api } = fixture({ cloudApi: { listInstances: async () => { throw new Error('instance timeout') } } })
  await page.loadAccounts()
  assert.equal(page.pageLoading.value, false)
  assert.equal(page.resourceError.value, 'instance timeout')
  assert.equal(page.instancesLoaded.value, false)
  api.cloudApi.listInstances = async () => ({ data: [{ id: 'vm' }] })
  await page.retryResources()
  assert.equal(page.resourceError.value, '')
  assert.equal(page.instances.value[0].id, 'vm')
})

test('switching accounts ignores a late failed request without hiding the new loading state', async () => {
  const old = deferred(), next = deferred()
  const { page } = fixture({ accountsApi: { list: async () => ({ data: [
    { id: 'a', computeProvider: 'aws' }, { id: 'b', computeProvider: 'aws' }
  ] }) }, cloudApi: { listInstances: id => id === 'a' ? old.promise : next.promise } })
  const first = page.loadAccounts()
  await tick()
  const second = page.selectAccount('b')
  old.reject(new Error('stale failure'))
  await first
  assert.equal(page.pageLoading.value, true)
  assert.equal(page.resourceError.value, '')
  next.resolve({ data: [{ id: 'b-vm' }] })
  await second
  assert.equal(page.pageLoading.value, false)
  assert.equal(page.instances.value[0].id, 'b-vm')
})

test('public IP loading has its own stage and a partial failure preserves the instance result', async () => {
  const ips = deferred()
  const { page } = fixture({ accountsApi: { list: async () => ({ data: [{ id: 'aws', computeProvider: 'aws' }] }) },
    cloudApi: { capabilities: async () => ({ data: { capabilities: ['elastic_ip'] } }),
      listInstances: async () => ({ data: [{ id: 'vm' }] }), listElasticIps: () => ips.promise } })
  const loading = page.loadAccounts()
  await tick()
  assert.match(page.loadingMessage.value, /公网 IP/)
  ips.reject(new Error('IP timeout'))
  await loading
  assert.equal(page.resourceError.value, 'IP timeout')
  assert.equal(page.instancesLoaded.value, true)
  assert.equal(page.instances.value[0].id, 'vm')
})
