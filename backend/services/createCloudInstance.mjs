import { createTask } from '../queue.mjs'
import { getComputeProvider } from '../providers/registry.mjs'
import { validateOracleInstancePassword } from '../utils/oraclePassword.mjs'
import { generateInstancePassword, validateAwsInstancePassword } from '../utils/instancePassword.mjs'
import { validateAzureFreeCreateParams } from '../utils/azureCostPolicy.mjs'

// Shared by HTTP and MCP: both creation entry points use the same validation,
// free-resource preflight and persisted task queue.
export async function createCloudInstance(account, input) {
  const { delay = 60, ...params } = input
  if (account.computeProvider === 'azure') validateAzureFreeCreateParams(params)
  if (account.computeProvider === 'oracle') validateOracleInstancePassword(params.rootPassword)
  if (account.computeProvider === 'aws') {
    if (!params.rootPassword) params.rootPassword = generateInstancePassword()
    validateAwsInstancePassword(params.rootPassword)
  }
  if (account.computeProvider === 'azure') {
    if (!params.adminPassword) throw new Error('Azure 实例创建需要 adminPassword')
    const provider = getComputeProvider(account)
    provider.useSubscription(params.subscriptionId)
    Object.assign(params, await provider.prepareFreeCreate(params))
  }
  const task = await createTask('cloud:createInstance', account.id, { ...params, delay, provider: account.computeProvider })
  return { taskId: task.id, message: '创建任务已加入队列' }
}
