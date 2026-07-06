# Cloudflare DNS 添加教程

本文档说明如何获取 Cloudflare DNS 凭证，并在本项目中添加 Cloudflare DNS 账户。

## 需要准备的信息

| 项目字段 | 说明 | 示例 |
| --- | --- | --- |
| API Token | Cloudflare API Token | `cfut_...` 或一段 token 字符串 |
| Zone ID | 域名所在 Zone 的 ID | `023e105f4ecef8ad9ca31a8372d0c353` |
| 根域名 | 托管在 Cloudflare 的主域名 | `example.com` |

## 创建 API Token

1. 登录 Cloudflare 控制台：

   <https://dash.cloudflare.com/>

2. 点击右上角头像，进入 **My Profile / 我的个人资料**。

3. 打开 **API Tokens**。

4. 点击 **Create Token**。

5. 选择 **Edit zone DNS** 模板。

6. 在 Zone Resources 中限制到需要管理的域名，例如：

   ```text
   Include - Specific zone - example.com
   ```

7. 确认权限至少包含：

   ```text
   Zone - DNS - Edit
   ```

8. 点击 **Continue to summary**，确认后点击 **Create Token**。

9. 复制生成的 API Token。

API Token 只会完整显示一次。如果丢失，需要重新创建。

## 获取 Zone ID

1. 在 Cloudflare 控制台打开你的域名。
2. 进入域名 Overview 页面。
3. 在页面右侧或下方的 API 区域找到 **Zone ID**。
4. 点击复制。

## 在本项目中填写

新增 DNS 账户时，选择：

```text
DNS Provider: Cloudflare
```

示例：

```text
账户名: Cloudflare-example.com
API Token: cfut_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Zone ID: 023e105f4ecef8ad9ca31a8372d0c353
根域名: example.com
```

## 多域名添加 Demo

如果你有多个域名，例如 `example.com` 和 `example.net`，建议在本项目中新增多条 DNS 账户记录。

第一条记录：

```text
账户名: Cloudflare-example.com
API Token: cfut_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Zone ID: 023e105f4ecef8ad9ca31a8372d0c353
根域名: example.com
```

第二条记录：

```text
账户名: Cloudflare-example.net
API Token: cfut_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
Zone ID: 11111111111111111111111111111111
根域名: example.net
```

如果同一个 API Token 授权了多个 Zone，也可以复用同一个 API Token，但每条记录都要填写对应域名自己的 `Zone ID` 和 `根域名`。

## 安全注意事项

- 不要使用 Global API Key，优先使用权限更小的 API Token。
- API Token 建议只授权到指定 Zone。
- 不要把 API Token 提交到 Git。
- 如果怀疑泄露，请立即删除旧 Token 并重新创建。

## 官方参考

- 创建 API Token：<https://developers.cloudflare.com/fundamentals/api/get-started/create-token/>
- 查找 Zone ID：<https://developers.cloudflare.com/fundamentals/setup/find-account-and-zone-ids/>
