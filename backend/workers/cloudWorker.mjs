/**
 * Cloud Worker - 统一处理所有计算 Provider 的异步任务
 */
import { accountsDb, tasksDb } from '../db.mjs'
import { getComputeProvider } from '../providers/registry.mjs'
import { queueEmitter, updateTask } from '../queue.mjs'
import { generateInstancePassword } from '../utils/instancePassword.mjs'
import { isAzureQuotaError, isAzureSkuUnavailableError } from '../utils/azureRequest.mjs'

queueEmitter.on('task:new', async (task) => {
  if (task.type !== 'cloud:createInstance') return

  const account = accountsDb.data.accounts.find(a => a.id === task.accountId)
  if (!account) {
    await updateTask(task.id, { status: 'failed', error: '账户不存在' })
    return
  }

  await handleCreateInstance(task, account)
})

async function handleCreateInstance(task, account) {
  // Upgrade pending legacy AWS jobs before the first attempt. Persist once so
  // retries and process restarts use the same password shown after completion.
  if (account.computeProvider === 'aws' && !task.params.rootPassword) {
    await updateTask(task.id, { params: { ...task.params, provider: 'aws', rootPassword: generateInstancePassword() } })
  }
  const { delay = 60, ...params } = task.params
  let _index = task.retries || 0

  await updateTask(task.id, { status: 'running' })

  const attempt = async () => {
    // Check if cancelled
    const currentTask = tasksDb.data.tasks.find(t => t.id === task.id)
    if (!currentTask || ['cancelled', 'done', 'failed'].includes(currentTask.status)) return

    _index++
    await updateTask(task.id, { retries: _index, statusMessage: `第 ${_index} 次尝试创建中...` })

    try {
      const provider = getComputeProvider(account)
      const result = await provider.createInstance(params, { creationId: task.id })

      await updateTask(task.id, {
        status: 'done',
        statusMessage: '实例创建成功',
        result
      })
    } catch (err) {
      const msg = err.message || ''

      if (account.computeProvider === 'azure' && isAzureSkuUnavailableError(err)) {
        const error = `Azure 规格不可用（${params.location || 'eastasia'} / ${params.vmSize || 'Standard_B1s'}）：${msg}。请更换规格或区域后重新创建。`
        await updateTask(task.id, { status: 'failed', error, statusMessage: error })
        return
      }

      if (account.computeProvider === 'azure' && isAzureQuotaError(err)) {
        const hint = /public.?ip|public ip addresses/i.test(`${err.code || ''} ${msg}`)
          ? '请在 Azure 门户核实并释放当前区域不再使用的公网 IP，或更换区域、申请提高配额后重新创建。'
          : '请调整区域或申请提高配额后重新创建。'
        const error = `Azure 配额超限：${msg}。${hint}`
        await updateTask(task.id, { status: 'failed', error, statusMessage: error })
        return
      }

      if (err.retryable === false) {
        await updateTask(task.id, { status: 'failed', error: msg, statusMessage: msg })
        return
      }

      // Out of capacity - retry
      if (
        msg.includes('Out of host capacity') ||
        msg.includes('InsufficientInstanceCapacity') ||
        msg.includes('AllocationFailed') ||
        msg.includes('OverconstrainedAllocationRequest')
      ) {
        await updateTask(task.id, { statusMessage: `资源不足，${delay}s 后重试 (第 ${_index} 次)` })
        setTimeout(attempt, delay * 1000)
        return
      }

      // Rate limited
      if (msg.includes('Too many requests') || msg.includes('RequestLimitExceeded') || err.statusCode === 429) {
        await updateTask(task.id, { statusMessage: `请求频繁，${delay * 2}s 后重试` })
        setTimeout(attempt, delay * 2 * 1000)
        return
      }

      // Quota exceeded - fatal
      if (
        msg.includes('limit') ||
        msg.includes('LimitExceeded') ||
        msg.includes('quota') ||
        msg.includes('QuotaExceeded') ||
        msg.includes('OperationNotAllowed')
      ) {
        await updateTask(task.id, { status: 'failed', error: `配额超限：${msg}` })
        return
      }

      // Unknown error - retry
      await updateTask(task.id, { statusMessage: `错误: ${msg}，${delay}s 后重试 (第 ${_index} 次)` })
      setTimeout(attempt, delay * 1000)
    }
  }

  // Start first attempt
  attempt()
}
