# Huawei Cloud DNS 添加教程

本文档说明如何获取华为云 AK / SK，并在本项目中添加 Huawei Cloud DNS 账户。

## 需要准备的信息

| 项目字段 | 说明 | 示例 |
| --- | --- | --- |
| Access Key ID (AK) | 华为云访问密钥 ID | `xxxxxxxx` |
| Secret Access Key (SK) | 华为云访问密钥 Secret | `xxxxxxxx` |
| 根域名 | 华为云 DNS 中托管的公网域名 | `example.com` |

## 创建 AK / SK

建议不要使用拥有过大权限的主账号长期密钥。可以创建 IAM 用户，并只授予 DNS 管理所需权限。

1. 登录华为云控制台：

   <https://console.huaweicloud.com/>

2. 打开 **统一身份认证服务 IAM**。

3. 创建用户，例如：

   ```text
   cloud-manager-dns
   ```

4. 给用户授权 DNS 相关权限。

   快速测试可以使用 DNS 管理权限。正式环境建议改成更小范围的自定义权限。

5. 使用该用户登录，进入 **我的凭证 / My Credentials**。

6. 打开 **访问密钥 / Access Keys**。

7. 点击新增访问密钥。

8. 保存：

   - Access Key ID (AK)
   - Secret Access Key (SK)

SK 只会完整显示一次。如果丢失，需要重新创建。

## 在本项目中填写

新增 DNS 账户时，选择：

```text
DNS Provider: Huawei Cloud DNS
```

示例：

```text
账户名: HuaweiDNS-example.com
Access Key ID (AK): exampleAccessKeyId
Secret Access Key (SK): exampleSecretAccessKey
根域名: example.com
```

## 多域名添加 Demo

如果同一组 AK / SK 有多个公网域名的解析权限，建议每个根域名单独新增一条 DNS 账户记录。

第一条记录：

```text
账户名: HuaweiDNS-example.com
Access Key ID (AK): exampleAccessKeyId
Secret Access Key (SK): exampleSecretAccessKey
根域名: example.com
```

第二条记录：

```text
账户名: HuaweiDNS-example.net
Access Key ID (AK): exampleAccessKeyId
Secret Access Key (SK): exampleSecretAccessKey
根域名: example.net
```

## 权限建议

快速测试可以授予 DNS 管理权限。正式环境建议只允许管理指定公网域名和解析记录。

## 安全注意事项

- 不要把 SK 提交到 Git。
- 不要把 AK / SK 发送到聊天工具或公开文档中。
- 建议为本项目单独创建 IAM 用户。
- 如果怀疑泄露，请立即删除旧访问密钥，并重新创建。

## 官方参考

- 华为云访问密钥文档：<https://support.huaweicloud.com/intl/en-us/usermanual-ca/ca_01_0003.html>
