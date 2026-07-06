# Aliyun DNS 添加教程

本文档说明如何获取阿里云 AccessKey，并在本项目中添加 Aliyun DNS 账户。

## 需要准备的信息

| 项目字段 | 说明 | 示例 |
| --- | --- | --- |
| Access Key ID | 阿里云 RAM 用户 AccessKey ID | `LTAI5t...` |
| Access Key Secret | 阿里云 RAM 用户 AccessKey Secret | `xxxxxxxx` |
| 根域名 | 阿里云 DNS 中托管的主域名 | `example.com` |

## 创建 RAM 用户 AccessKey

建议不要使用阿里云主账号 AccessKey。请创建 RAM 用户，并只授予 DNS 管理所需权限。

1. 登录阿里云 RAM 控制台：

   <https://ram.console.aliyun.com/>

2. 创建 RAM 用户，例如：

   ```text
   cloud-manager-dns
   ```

3. 为该用户启用 OpenAPI 调用访问。

4. 给 RAM 用户授权 DNS 相关权限。

   快速测试可以使用：

   ```text
   AliyunDNSFullAccess
   ```

   正式环境建议改成更小权限的自定义策略。

5. 进入该 RAM 用户的 **认证管理 / AccessKey**。

6. 创建 AccessKey。

7. 保存：

   - Access Key ID
   - Access Key Secret

Access Key Secret 只会显示一次。如果丢失，需要重新创建。

## 在本项目中填写

新增 DNS 账户时，选择：

```text
DNS Provider: Aliyun DNS
```

示例：

```text
账户名: Aliyun-example.com
Access Key ID: LTAI5tExampleAccessKeyId
Access Key Secret: exampleAccessKeySecret
根域名: example.com
```

## 多域名添加 Demo

如果同一个 AccessKey 有多个域名的解析权限，建议每个根域名新增一条 DNS 账户记录。

第一条记录：

```text
账户名: Aliyun-example.com
Access Key ID: LTAI5tExampleAccessKeyId
Access Key Secret: exampleAccessKeySecret
根域名: example.com
```

第二条记录：

```text
账户名: Aliyun-example.net
Access Key ID: LTAI5tExampleAccessKeyId
Access Key Secret: exampleAccessKeySecret
根域名: example.net
```

## 权限建议

快速测试可以使用：

```text
AliyunDNSFullAccess
```

正式环境建议创建自定义 RAM 策略，只允许管理指定域名的解析记录。

## 安全注意事项

- 不要使用阿里云主账号 AccessKey。
- 不要把 Access Key Secret 提交到 Git。
- 建议为本项目单独创建 RAM 用户。
- 如果怀疑泄露，请立即禁用或删除旧 AccessKey，并重新创建。

## 官方参考

- 阿里云 AccessKey 文档：<https://www.alibabacloud.com/help/en/ram/user-guide/create-an-accesskey-pair>
