# Azure API Key 获取教程

本文档说明如何在 Azure 中创建服务主体（Service Principal），并在本项目中添加 Azure 计算账户。

> Azure 通常不叫 API Key。本项目需要的是 Azure 服务主体凭证，也就是 `appId`、`password` 和 `tenant`。可以直接从 Azure Cloud Shell 或 Azure CLI 生成。

## 需要准备的信息

| 字段 | 说明 | 示例格式 |
| --- | --- | --- |
| appId | 应用程序 ID，也可理解为 Client ID | `00000000-0000-0000-0000-000000000000` |
| password | 服务主体密码，也可理解为 Client Secret | `xxxxxxxx` |
| tenant | 租户 ID，也可理解为 Tenant ID | `00000000-0000-0000-0000-000000000000` |

本项目会自动查询该服务主体可访问的 Azure 订阅。进入实例页面后，可以在 Azure 订阅下拉框中选择具体订阅。

## 方法一：使用 Azure Cloud Shell 创建

这是推荐方式。Azure Cloud Shell 已经内置 Azure CLI，不需要在本机安装工具。

1. 登录 Azure Portal：

   <https://portal.azure.com/>

2. 点击页面顶部的 **Cloud Shell** 图标。

3. 选择 Bash。

4. 查看当前订阅：

   ```bash
   az account show
   ```

5. 如果有多个订阅，先切换到目标订阅：

   ```bash
   az account set --subscription "你的订阅 ID"
   ```

6. 创建服务主体，并授予当前订阅的 Contributor 权限：

   ```bash
   az ad sp create-for-rbac --name cloud-manager --role Contributor --scopes /subscriptions/你的订阅ID
   ```

7. 命令会返回类似下面的 JSON：

   ```json
   {
     "appId": "00000000-0000-0000-0000-000000000000",
     "displayName": "cloud-manager",
     "password": "example-client-secret-value",
     "tenant": "11111111-1111-1111-1111-111111111111"
   }
   ```

请保存这段 JSON。`password` 只会在创建时完整显示一次。

## 在本项目中填写

本项目支持两种填写方式。

### 方式一：直接粘贴 Cloud Shell CLI JSON

把 Cloud Shell 返回的整段 JSON 粘贴到 `Cloud Shell CLI JSON` 输入框：

```json
{
  "appId": "00000000-0000-0000-0000-000000000000",
  "displayName": "cloud-manager",
  "password": "example-client-secret-value",
  "tenant": "11111111-1111-1111-1111-111111111111"
}
```

下面的 `appId`、`tenant`、`password` 输入框可以不填。

### 方式二：手动填写字段

如果不想粘贴完整 JSON，也可以手动填写：

| 项目字段 | JSON 字段 |
| --- | --- |
| appId | `appId` |
| tenant | `tenant` |
| password | `password` |

示例：

```text
账户名: Azure-主账号
appId: 00000000-0000-0000-0000-000000000000
tenant: 11111111-1111-1111-1111-111111111111
password: example-client-secret-value
```

## 多订阅添加 Demo

如果同一个 Azure 租户下面有多个订阅，可以给同一个服务主体授权多个订阅。本项目添加一次 Azure 账户即可，后续会在实例页面中加载可用订阅，并允许选择订阅。

先创建服务主体：

```bash
az ad sp create-for-rbac --name cloud-manager --role Contributor --scopes /subscriptions/第一个订阅ID
```

记录返回的 `appId`、`password`、`tenant`。

然后给同一个 `appId` 追加第二个订阅权限：

```bash
az role assignment create --assignee 00000000-0000-0000-0000-000000000000 --role Contributor --scope /subscriptions/第二个订阅ID
```

继续追加第三个订阅权限：

```bash
az role assignment create --assignee 00000000-0000-0000-0000-000000000000 --role Contributor --scope /subscriptions/第三个订阅ID
```

在本项目中只需要新增一条 Azure 账号记录：

```json
{
  "appId": "00000000-0000-0000-0000-000000000000",
  "displayName": "cloud-manager",
  "password": "example-client-secret-value",
  "tenant": "11111111-1111-1111-1111-111111111111"
}
```

保存后进入云实例页面，选择该 Azure 账号，再从 Azure 订阅下拉框选择具体订阅。

## 多租户添加 Demo

如果你有多个 Azure 租户，需要分别在每个租户中创建服务主体，然后在本项目中新增多条 Azure 账户记录。

第一个租户：

```json
{
  "appId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "displayName": "cloud-manager-main",
  "password": "first-tenant-client-secret",
  "tenant": "11111111-1111-1111-1111-111111111111"
}
```

第二个租户：

```json
{
  "appId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  "displayName": "cloud-manager-backup",
  "password": "second-tenant-client-secret",
  "tenant": "22222222-2222-2222-2222-222222222222"
}
```

建议账号名写清楚用途：

```text
Azure-主租户
Azure-备用租户
```

## 常见问题

### 创建时提示订阅未注册 Microsoft.Network

创建实例前，系统会检查当前所选订阅的 `Microsoft.Network` 和 `Microsoft.Compute`，自动注册缺失项并等待注册完成。每项最多等待两分钟；尚未完成时，任务会在重试时继续检查，不会反复发起注册或提前创建资源。

自动注册需要订阅级资源提供程序注册权限（`/register/action`，订阅级 Contributor / Owner 包含此权限）。如果服务主体仅有资源组权限，任务会显示权限提示并停止重试。可由订阅管理员进入 Azure 门户的“订阅 → 资源提供程序”注册这两项，或执行：

```bash
az provider register --namespace Microsoft.Network --subscription 订阅ID --wait
az provider register --namespace Microsoft.Compute --subscription 订阅ID --wait
```

注册并确认服务主体具备订阅读取和创建资源权限后，重新提交创建任务。

### 只看到部分订阅

通常是服务主体没有被授予对应订阅的角色。请用下面命令给订阅追加权限：

```bash
az role assignment create --assignee 你的appId --role Contributor --scope /subscriptions/订阅ID
```

### 创建时提示 aborted 或 TLS connection was established

`Error reading response as text: aborted` 表示响应读取中断；`Client network socket disconnected before secure TLS connection was established` 表示 TLS 握手前连接断开。这些错误需要检查运行后端的主机或容器到 `login.microsoftonline.com:443` 和 `management.azure.com:443` 的网络、DNS 和代理连接。

创建流程会对连接中断按 2、4、8 秒重试当前步骤，仍失败时显示具体阶段并交回任务队列重试。同一任务的虚拟机、公网 IP 和网卡名称保持一致，响应丢失后不会因重新生成名称而创建另一套资源。旧版本已经产生的随机名称资源不会自动删除。

如果使用 Docker，代理必须在应用容器内可用；容器中的 `127.0.0.1` 指向容器自身。请检查容器的 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` 配置和代理服务连通性。不要通过关闭 TLS 证书校验解决连接问题。

本机开发时，后端 Node.js 进程不一定使用浏览器或系统的代理。需要代理时，在启动后端的同一个终端配置 `HTTPS_PROXY` / `HTTP_PROXY` 为实际代理地址后重启开发服务。

### Cannot create more than 3 public IP addresses

这是所选订阅在当前区域的公网 IP 数量配额限制。任务会停止重试并显示配额提示。在“云实例”页面选择 Azure 账户和订阅，点击“管理公网 IP”，按区域筛选后可查看所有已有地址及其关联状态。对未关联且状态允许的地址，可逐个确认删除；后端会再次检查使用状态，正在使用的地址不能删除。未关联地址也可能是预留资源，请确认不再需要后再删除。也可以选择其他可用区域，或申请提高公网 IP 配额，然后重新提交创建任务。

### IP 已关联，但没有对应实例

实例创建失败后，公网 IP 可能仍关联到独立网卡。在“管理公网 IP”中，系统会读取关联网卡，确认没有绑定虚拟机或其他服务后显示“网卡未绑定实例”和“解绑并删除”。确认后仅解除该 IP 与网卡的关联并删除 IP，保留网卡的其他配置。执行时会重新检查关联状态；已绑定实例的网卡、NAT 网关、负载均衡器及无法确认状态的关联不允许通过此操作解绑。

### 切换区域时提示 Invalid resource group location

资源组位置不能修改，但组内资源可以位于不同区域。创建流程会复用已有资源组，仅在资源组不存在时按所选区域创建。例如资源组位于 `westus`，仍可在其中创建位于 `canadacentral` 的网络、IP 和实例。无需删除或迁移已有资源组。

### 仅允许免费资源

Azure 学生积分、订阅的 Spending Limit、B1s / B2ats_v2 型号及历史零费用，都不能证明下一次创建或开机免费。系统盘、磁盘操作和流量也需要单独核实权益、有效期和剩余额度。

Azure 学生及免费试用订阅可以创建 `Standard_B1s`、`Standard_B2ats_v2` 和 `Standard_B2pts_v2`。这三种规格各有每月 750 小时的免费额度，适用于符合条件的新客户前 12 个月，参见 [Azure for Students](https://azure.microsoft.com/en-us/free/students/)。规格列表包含 x64 和 ARM，ARM 会自动使用匹配的 Ubuntu 22.04 镜像；启动和重启也按免费规格检查，不再统一禁用。

默认系统盘为 64 GiB `Premium_LRS`（P6），不再使用会单独计磁盘操作费的 S4 `Standard_LRS`；不创建公网 IP、额外数据盘、付费镜像或诊断存储。前后端限制非免费额度规格和自定义收费配置，后端返回 HTTP 403（`FreeOnlyMode`）。旧环境变量 `AZURE_FREE_ONLY=false` 不能关闭限制。

创建前重新检查有效订阅、区域、CPU 配额和已有资源；为限制共享额度的并发消耗，同一订阅跨区域只允许保留一台同规格实例，P6 磁盘最多两块，未挂载磁盘也计入。并发创建任务按订阅串行执行，重试复用同一资源名。此检查约束资源配置和同时使用量，不能据此认定历史用量清零、免费期自动续期或所有流量免费；实际权益、剩余额度和计费以 Azure 免费服务用量为准。

还会读取本月实际计算费用：如果某区域的某种规格已经产生正费用，则只拦截该区域与规格的创建、启动和重启；其他规格及区域继续可选。磁盘历史费用不作为禁止全部 VM 的依据。没有计费记录也不代表免费额度无限，账单存在入账延迟。

`GET /api/cloud/:accountId/azure/create-options?subscriptionId=...` 必须登录并指定可访问的订阅。接口查询允许区域的三种免费额度规格和 CPU 配额，返回 `options` / `regions` 以及 `costPolicy`；无法分配时显示区域原因，不推荐收费替代品。`capabilities` 接口也返回此费用策略。

### 停止和删除 Azure 实例

“停止并释放计算资源”使用 Azure Deallocate；单纯关闭操作系统仍可能产生计算费用。释放后保留的磁盘和公网 IP 仍可能计费。

删除实例前会记录关联资源，再清理声明随实例删除的磁盘，以及本系统创建的专属系统盘、网卡和公网 IP。共享、外部或仍被使用的资源不会被误删；清理失败或需要保留的资源会在响应和页面中逐项提示。虚拟网络和安全组可能被其他实例共用，不随单台实例删除。

删除只停止资源的后续计费；已经发生的历史费用仍会显示，账单也可能延迟入账。

### 费用、学生积分和有效期

云实例页面的 Azure 订阅卡片会查询 Cost Management 和订阅账单属性，显示本月税前实际费用、学生积分/额度、权益期累计费用、参考剩余额度、额度有效期、订阅计费状态和付款类型。费用按 Azure 返回的币种展示，服务主体不需要读取或保存银行卡信息。

Azure 官方余额接口需要单独的账单配置文件权限。没有该权限时，页面会明确显示“官方余额无权限”，并把“参考剩余额度”定义为学生额度减权益期内已入账费用，不能当作账单余额或现金扣款。Cost Management 暂时限流、权限不足或查询失败时显示“暂无数据”和具体状态，不会把未知值显示为 0。结果会短暂缓存，避免刷新页面重复触发 Azure 限流。

例如某系列 CPU 配额的 `Current Limit: 0` 表示所选区域未授予该系列 CPU 配额。规格查询接口同时检查系列和区域总 CPU 配额；配额充足仅表示可申请该规格。

配额信息缺失或查询失败时不会被视为无限配额，创建前会再次检查。

### password 丢失了

服务主体的 `password` 创建后无法再次查看。可以重置凭证：

```bash
az ad sp credential reset --id 你的appId
```

重置后需要把新的 `password` 更新到本项目。

## 安全注意事项

- 不要把服务主体 `password` 提交到 Git。
- 不要把完整 JSON 发送到聊天工具或公开文档中。
- 建议为本项目单独创建服务主体，方便单独禁用或轮换。
- 如果怀疑 `password` 泄露，请立即重置服务主体凭证。
- 多订阅场景下，建议只给需要管理的订阅授权。

## 官方参考

- Azure CLI 官方文档：<https://learn.microsoft.com/en-us/cli/azure/ad/sp?view=azure-cli-latest>
