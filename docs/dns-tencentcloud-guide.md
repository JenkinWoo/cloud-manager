# Tencent Cloud DNSPod 添加教程

本文档说明如何获取腾讯云 SecretId / SecretKey，并在本项目中添加 Tencent Cloud DNSPod 账户。

## 需要准备的信息

| 项目字段 | 说明 | 示例 |
| --- | --- | --- |
| SecretId | 腾讯云访问密钥 ID | `TENCENT_SECRET_ID_PLACEHOLDER` |
| SecretKey | 腾讯云访问密钥 Key | `xxxxxxxx` |
| 根域名 | DNSPod 中托管的主域名 | `example.com` |

## 创建访问密钥

建议不要使用腾讯云主账号密钥。请创建子用户，并只授予 DNSPod 所需权限。

1. 登录腾讯云控制台：

   <https://console.cloud.tencent.com/>

2. 进入 **访问管理 CAM**。

3. 创建子用户，例如：

   ```text
   cloud-manager-dns
   ```

4. 给子用户授权 DNSPod 相关权限。

   快速测试可以使用 DNSPod 全读写权限。正式环境建议改成更小范围的自定义策略。

5. 进入该子用户的 **API 密钥** 页面。

6. 新建密钥。

7. 保存：

   - SecretId
   - SecretKey

SecretKey 只会完整显示一次。如果丢失，需要重新创建。

## 在本项目中填写

新增 DNS 账户时，选择：

```text
DNS Provider: Tencent Cloud DNSPod
```

示例：

```text
账户名: DNSPod-example.com
SecretId: TENCENT_SECRET_ID_PLACEHOLDER
SecretKey: exampleSecretKey
根域名: example.com
```

## 多域名添加 Demo

如果同一个 SecretId / SecretKey 有多个域名的解析权限，建议每个根域名单独新增一条 DNS 账户记录。

第一条记录：

```text
账户名: DNSPod-example.com
SecretId: TENCENT_SECRET_ID_PLACEHOLDER
SecretKey: exampleSecretKey
根域名: example.com
```

第二条记录：

```text
账户名: DNSPod-example.net
SecretId: TENCENT_SECRET_ID_PLACEHOLDER
SecretKey: exampleSecretKey
根域名: example.net
```

## 权限建议

快速测试可以授予 DNSPod 相关全读写权限。正式环境建议创建自定义策略，只允许管理需要的域名解析记录。

## 安全注意事项

- 不要使用腾讯云主账号密钥。
- 不要把 SecretKey 提交到 Git。
- 建议为本项目单独创建 CAM 子用户。
- 如果怀疑泄露，请立即禁用或删除旧密钥，并重新创建。

## 官方参考

- 腾讯云 API 密钥文档：<https://www.tencentcloud.com/document/product/598/34228>
