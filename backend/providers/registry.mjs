/**
 * Provider Registry - 按需实例化 compute 和 DNS Provider
 * 
 * 新增 Provider 只需：
 * 1. 在对应目录增加实现文件
 * 2. 在下方 computeProviders / dnsProviders 中注册一行
 * 3. 其余路由/前端代码无需改动
 */

import OracleProvider from './compute/OracleProvider.mjs'
import AwsProvider from './compute/AwsProvider.mjs'
import AzureProvider from './compute/AzureProvider.mjs'

import CloudflareProvider from './dns/CloudflareProvider.mjs'
import AliyunProvider from './dns/AliyunProvider.mjs'

// ============================================================
// 注册表（在此处添加新 Provider）
// ============================================================

const computeProviders = {
  oracle: OracleProvider,
  aws:    AwsProvider,
  azure:  AzureProvider,
  // gcp:   GcpProvider,
}

const dnsProviders = {
  cloudflare: CloudflareProvider,
  aliyun:     AliyunProvider,
  // tencent: TencentDnsProvider,
}

// ============================================================
// 工厂方法
// ============================================================

/**
 * 通过账户对象实例化对应的计算 Provider
 * @param {object} account - 来自 accountsDb 的账户记录
 * @returns {BaseComputeProvider}
 */
export function getComputeProvider(account) {
  const Cls = computeProviders[account.computeProvider]
  if (!Cls) throw new Error(`未知计算 Provider: "${account.computeProvider}"，已注册: ${Object.keys(computeProviders).join(', ')}`)
  return new Cls(account)
}

/**
 * 通过 DNS 账户对象实例化对应的 DNS Provider
 * @param {object} dnsAccount - 来自 dnsAccountsDb 的 DNS 账户记录
 * @returns {BaseDnsProvider}
 */
export function getDnsProvider(dnsAccount) {
  const Cls = dnsProviders[dnsAccount.dnsProvider]
  if (!Cls) throw new Error(`未知 DNS Provider: "${dnsAccount.dnsProvider}"，已注册: ${Object.keys(dnsProviders).join(', ')}`)
  return new Cls(dnsAccount)
}

/**
 * 获取所有已注册的 Provider 元信息（供前端展示）
 */
export function listProviders() {
  return {
    compute: Object.entries(computeProviders).map(([key, Cls]) => ({
      key,
      name: Cls.providerName,
      capabilities: Cls.capabilities
    })),
    dns: Object.entries(dnsProviders).map(([key, Cls]) => ({
      key,
      name: Cls.providerName
    }))
  }
}
