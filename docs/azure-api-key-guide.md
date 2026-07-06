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

### 只看到部分订阅

通常是服务主体没有被授予对应订阅的角色。请用下面命令给订阅追加权限：

```bash
az role assignment create --assignee 你的appId --role Contributor --scope /subscriptions/订阅ID
```

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
