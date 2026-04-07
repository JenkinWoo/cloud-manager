function normalizeValue(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

export function normalizeAzureCredentials(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  let cliConfig = {}

  if (source.cliConfigText) {
    try {
      cliConfig = JSON.parse(source.cliConfigText)
    } catch (error) {
      throw new Error('Azure CLI 配置 JSON 解析失败，请检查粘贴内容')
    }
  }

  const merged = { ...cliConfig, ...source }
  const appId = normalizeValue(merged.appId || merged.clientId)
  const password = normalizeValue(merged.password || merged.clientSecret)
  const tenant = normalizeValue(merged.tenant || merged.tenantId)

  if (!appId || !password || !tenant) {
    throw new Error('Azure 账户缺少 appId、password 或 tenant')
  }

  return {
    appId,
    password,
    tenant,
    displayName: normalizeValue(merged.displayName),
    cliConfigText: normalizeValue(source.cliConfigText)
  }
}

