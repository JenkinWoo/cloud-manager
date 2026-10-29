import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { parse, compileScript } = require('@vue/compiler-sfc')
const { ref, computed } = require('vue')
const source = readFileSync(new URL('../frontend/src/views/CloudShell.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: 'rescue-selection-test', genDefaultAs: 'component' }).content
  .replace(/^import (.+) from '([^']+)'\r?$/gm, (_, binding, path) => {
    if (path === 'vue') return `const ${binding} = deps.vue`
    if (path === 'vue-router') return `const ${binding} = deps.router`
    if (path.endsWith('/api/index.js')) return `const ${binding} = deps.api`
    return `const ${binding} = {}`
  })

const oracle = { id: 'oracle', name: 'Singapore', provider: 'oracle', capabilities: { serial: true } }
const azure = { id: 'azure', name: 'Azure', provider: 'azure', capabilities: { serial: true } }
const target = { id: 'ocid1.instance.oc1.ap-singapore-1.target', displayName: 'Singapore AMD', publicIps: ['192.0.2.1'] }
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture({ query = {}, accounts = [oracle], listInstances = async () => ({ data: [target] }), listAzureSubscriptions } = {}) {
  const requests = []
  const api = {
    cloudShellApi: { list: async () => ({ data: { accounts } }) },
    cloudApi: { listInstances, listAzureSubscriptions }
  }
  const component = new Function('deps', compiled + '\nreturn component')({
    vue: { ref, computed, onMounted() {}, onUnmounted() {} },
    router: { useRoute: () => ({ query }) }, api
  })
  const page = component.setup({}, { expose() {} })
  page.terminalPanel.value = { connect: request => requests.push(request) }
  return { page, requests, api }
}

test('choosing an instance by name connects with its exact ID and serial mode', async () => {
  const { page, requests } = fixture()
  await page.loadAccounts()
  assert.equal(page.canConnect.value, false)
  assert.match(page.instanceLabel(target), /Singapore AMD/)
  page.instanceId.value = target.id
  assert.equal(page.canConnect.value, true)
  page.connect()
  assert.deepEqual(requests, [{ accountId: oracle.id, instanceId: target.id, mode: 'serial' }])
})

test('a link from an instance card selects the instance after discovery, but a missing target cannot connect', async () => {
  const { page, api } = fixture({ query: { accountId: oracle.id, instanceId: target.id } })
  await page.loadAccounts()
  assert.equal(page.selectedInstance.value.id, target.id)
  assert.equal(page.canConnect.value, true)
  api.cloudApi.listInstances = async () => ({ data: [] })
  await page.refreshInstances()
  assert.equal(page.instanceId.value, '')
  assert.equal(page.canConnect.value, false)
})

test('late responses from the previous account cannot change the new selection', async () => {
  let finishOld
  const old = new Promise(resolve => { finishOld = resolve })
  const nextTarget = { id: 'i-0123456789abcdef0', displayName: 'AWS instance' }
  const { page } = fixture({ accounts: [oracle, { id: 'aws', provider: 'aws', capabilities: { serial: true } }],
    listInstances: id => id === oracle.id ? old : Promise.resolve({ data: [nextTarget] }) })
  const loading = page.loadAccounts()
  await tick()
  page.accountId.value = 'aws'
  await page.selectAccount()
  page.instanceId.value = nextTarget.id
  finishOld({ data: [target] })
  await loading
  assert.equal(page.selectedInstance.value.id, nextTarget.id)
  assert.equal(page.canConnect.value, true)
})

test('a failed refresh blocks connection and retry preserves a still-existing selected instance', async () => {
  const { page, api, requests } = fixture({ query: { accountId: oracle.id, instanceId: target.id } })
  await page.loadAccounts()
  api.cloudApi.listInstances = async () => { throw new Error('network unavailable') }
  await page.refreshInstances()
  assert.equal(page.canConnect.value, false)
  page.connect()
  assert.equal(requests.length, 0)
  api.cloudApi.listInstances = async () => ({ data: [target] })
  await page.refreshInstances()
  assert.equal(page.instanceId.value, target.id)
  assert.equal(page.canConnect.value, true)
})

test('Azure card links discover the matching subscription and changing subscription clears the old target', async () => {
  const vm = { id: '/subscriptions/SUB-B/resourceGroups/test/providers/Microsoft.Compute/virtualMachines/server', displayName: 'Azure server' }
  const calls = []
  const { page } = fixture({ accounts: [azure], query: { accountId: azure.id, instanceId: vm.id.toLowerCase() },
    listAzureSubscriptions: async () => ({ data: [{ subscriptionId: 'sub-a' }, { subscriptionId: 'sub-b' }] }),
    listInstances: async (account, params) => { calls.push([account, params]); return { data: params.subscriptionId === 'sub-b' ? [vm] : [] } } })
  await page.loadAccounts()
  assert.deepEqual(calls[0], ['azure', { subscriptionId: 'sub-b' }])
  assert.equal(page.instanceId.value, vm.id)
  assert.equal(page.canConnect.value, true)
  page.subscriptionId.value = 'sub-a'
  await page.changeSubscription()
  assert.equal(page.instanceId.value, '')
  assert.equal(page.canConnect.value, false)
})

test('refresh retries Azure subscription discovery after a failure', async () => {
  const { page, api } = fixture({ accounts: [azure], listAzureSubscriptions: async () => { throw new Error('timeout') } })
  await page.loadAccounts()
  assert.ok(page.instanceError.value)
  api.cloudApi.listAzureSubscriptions = async () => ({ data: [{ subscriptionId: 'sub' }] })
  await page.refreshInstances()
  assert.equal(page.instanceError.value, '')
  assert.equal(page.instances.value[0].id, target.id)
})
