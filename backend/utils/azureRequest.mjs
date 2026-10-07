const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'])
const RETRY_DELAYS_MS = [2000, 4000, 8000]

export function isAzureSkuUnavailableError(error) {
  return /^SkuNotAvailable$/i.test(error?.code || '') ||
    /Capacity Restrictions|requested VM size[\s\S]*currently not available/i.test(error?.message || '')
}

export function isAzureResourceGroupLocationError(error) {
  return error?.code === 'InvalidResourceGroupLocation' || /invalid resource group location/i.test(error?.message || '')
}

export function isAzureQuotaError(error) {
  const code = String(error?.code || '')
  return /^(PublicIPCountLimitReached|PublicIPAddressCountLimitReached|QuotaExceeded|ResourceQuotaExceeded|SubscriptionIsOverQuota)$/i.test(code) ||
    /cannot create more than \d+ public ip addresses|exceed(?:ed|s|ing)?[^.\n]*\bquota\b/i.test(error?.message || '')
}

export function isAzureNetworkError(error) {
  // Explicit cancellation and certificate/authentication errors must not be retried.
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ERR_CANCELED') return false
  return NETWORK_CODES.has(error?.code) ||
    /Error reading response as text: (aborted|terminated|premature close)/i.test(error?.message || '') ||
    /socket disconnected before secure TLS connection was established|socket hang up/i.test(error?.message || '') ||
    (error?.cause && error.cause !== error ? isAzureNetworkError(error.cause) : false)
}

// Only use for reads and operations that are safe to repeat with identical IDs.
export async function withAzureNetworkRetry(stage, operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const networkError = Boolean(isAzureNetworkError(error))
      if (networkError && attempt < RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
        continue
      }
      const failure = new Error(`Azure ${stage}失败：${error.message}` +
        (networkError ? '（连接中断，短暂重试后仍失败，请检查后端网络或代理）' : ''), { cause: error })
      failure.code = error.code
      failure.statusCode = error.statusCode
      failure.retryable = isAzureResourceGroupLocationError(error) ? false : error.retryable
      failure.networkError = networkError
      throw failure
    }
  }
}
