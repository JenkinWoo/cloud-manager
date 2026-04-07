/**
 * Cloud Worker - 统一处理所有计算 Provider 的异步任务
 */
import { accountsDb, tasksDb } from '../db.mjs'
import { getComputeProvider } from '../providers/registry.mjs'
import { queueEmitter, updateTask } from '../queue.mjs'

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
      const result = await provider.createInstance(params)

      await updateTask(task.id, {
        status: 'done',
        statusMessage: '实例创建成功',
        result
      })
    } catch (err) {
      const msg = err.message || ''

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
