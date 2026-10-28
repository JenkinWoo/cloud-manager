# 远程 MCP 接入

Cloud Manager 提供 `/mcp` 接口，使用官方 MCP SDK 的 **Streamable HTTP** 无会话模式。AI 可以查询云资源；另外创建有操作权限的令牌后，可管理实例、任务和 DNS。

## 开始使用

1. 登录管理页面，打开 **系统设置 → 远程 MCP · AI 接入**。
2. 勾选“启用远程 MCP”，保存设置。新安装默认关闭。
3. 输入令牌用途名称，默认选择“只读”，生成令牌。有效期默认 90 天，可选 1–365 天。
4. 保存一次性显示的令牌，点击“复制客户端配置”，填写到 AI 客户端中。

连接地址为 `https://你的域名/mcp`，请求头为 `Authorization: Bearer <令牌>`。以下适用于支持 `url` 和 `headers` 配置的客户端；其他客户端请在界面中填写对应字段：

```json
{
  "mcpServers": {
    "cloud-manager": {
      "url": "https://cloud.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_MCP_TOKEN>"
      }
    }
  }
}
```

客户端必须支持 Streamable HTTP 和自定义 Bearer 请求头。此接口不提供 OAuth 授权流程，也不提供旧式 `/sse` 传输；仅支持 OAuth 的客户端不能直接使用此配置。

令牌覆盖**所有已启用的计算和 DNS 账户**，目前没有逐账户授权。只读令牌不能创建其他令牌、登录管理后台或调用修改工具。服务端只保存令牌的 SHA-256 摘要；遗失后需重新生成。最多保留 20 个有效令牌。

在同一设置页撤销令牌或关闭 MCP 后，后续请求会立即拒绝。已提交的云操作不会因此回滚，也不会自动取消任务。

## 工具

| 权限 | 工具 | 用途 |
| --- | --- | --- |
| 只读 | `list_accounts` | 启用的计算和 DNS 账户，不含凭证 |
| 只读 | `list_instances` / `get_instance` | 实例列表与详情，不含 SDK 原始数据 |
| 只读 | `azure_subscriptions` | Azure 可用订阅 |
| 只读 | `azure_create_options` | 免费配置候选、配额及校验结果 |
| 只读 | `get_billing` | 账户账单，默认当前 UTC 月份，可按月或起止日期查询；结束日期不包含在区间内 |
| 只读 | `list_tasks` / `get_task` | 任务状态、结果和错误，不含创建密码 |
| 只读 | `list_dns_records` | DNS 记录 |
| 允许操作 | `create_instance` | 按现有校验规则创建任务，返回 `taskId` |
| 允许操作 | `instance_action` | `START` / `STOP` / `REBOOT` / `HARD_REBOOT` |
| 允许操作 | `delete_instance` | 删除实例，按云平台规则处理关联资源 |
| 允许操作 | `upsert_dns_record` / `delete_dns_record` | 新增、更新、删除 DNS 记录 |
| 允许操作 | `cancel_task` | 取消待执行或运行中的任务；已提交的云请求可能继续完成 |

操作令牌包含全部只读工具。只读令牌的 `tools/list` 不会列出修改工具。各工具的参数由 `tools/list` 的 JSON Schema 提供，不支持任意 HTTP 转发或任意方法调用。

Azure 实例查询和操作需提供 `subscriptionId`；可先调用 `azure_subscriptions`。创建 Azure 实例需要 `adminPassword`，先通过 `azure_create_options` 查询合适配置；留空区域和规格时由后端选择。创建继续使用网页的免费实例/硬盘校验和任务队列，默认不创建公网 IPv4。`createPublicIp: true` 表示创建收费 IPv4。配额中的 CPU 核数不是剩余免费小时，账单中的免费用量记录也不是未来免费权益保证。

Oracle 创建需要 `rootPassword`；AWS 可提供 `rootPassword` 或由后端生成。Oracle/AWS 沿用现有平台默认配置，不能承诺免费。创建凭证仍通过管理页面查看，不通过 MCP 返回。创建返回 `taskId` 后，使用 `get_task` 跟踪状态；遇到网络超时先检查任务，重复调用创建可能生成多个任务。

每次工具执行都记录 MCP 令牌名称、ID、工具名称、目标和执行结果到系统日志，不记录完整参数、令牌或密码。敏感字段及已知凭证在返回结果和错误中进行过滤。

## 部署与浏览器来源

`/mcp` 与现有网页/API 共用后端端口（默认 3001），无需增加 Docker 端口。外网接入应通过 HTTPS 反向代理；确保代理转发 `/mcp` 和 `Authorization` 请求头，并为较慢的云请求设置足够的超时时间。例如现有 Nginx 站点可增加：

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 300s;
    proxy_buffering off;
}
```

桌面或服务端客户端通常不带 `Origin`，持有效令牌即可访问。带 `Origin` 的浏览器客户端必须在设置页的“浏览器客户端来源”中登记精确来源，如 `https://ai.example.com`；不支持通配符或路径。浏览器来源许可不能代替令牌。开发模式的 Vite 已将 `/mcp` 转发到后端。

接口支持 `POST`，无独立 SSE 流或会话 ID；`GET` / `DELETE` 返回 405，`OPTIONS` 用于预检。服务关闭或令牌无效返回 401，来源不允许返回 403；每令牌每分钟最多 120 个 POST 请求、同时最多 8 个请求，超限返回 429 和 `Retry-After`。JSON 请求体上限为 128 KiB。

## 验证连接

可用以下初始化请求验证地址和令牌，将示例令牌替换为新生成的令牌：

```bash
curl https://cloud.example.com/mcp \
  -H 'Authorization: Bearer <YOUR_MCP_TOKEN>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"manual-check","version":"1.0"}}}'
```

隔离测试使用官方 MCP 客户端和内存模拟账户，不连接真实云平台或修改本地数据库：

```bash
node --experimental-test-module-mocks --test tests/mcp.test.mjs
```
