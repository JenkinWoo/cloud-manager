# AWS API Key 获取教程

本文档说明如何在 AWS 中创建 IAM Access Key，并在本项目中添加 AWS 计算账户。

> AWS 的 API Key 通常指 IAM 用户的 **Access Key ID** 和 **Secret Access Key**。本项目使用这两个字段调用 AWS EC2 API。

## 需要准备的信息

| 字段 | 说明 | 示例格式 |
| --- | --- | --- |
| Access Key ID | AWS 访问密钥 ID | `AKIA...` |
| Secret Access Key | AWS 访问密钥 Secret | `wJalrXUtnFEMI/...` |
| Region | AWS 区域标识 | `ap-southeast-1`、`us-east-1` |

## 创建 IAM 用户和 Access Key

建议不要使用 AWS Root 账户创建 Access Key。请创建单独的 IAM 用户，并只授予本项目需要的权限。

1. 登录 AWS 控制台：

   <https://console.aws.amazon.com/>

2. 打开 **IAM** 服务。

3. 进入 **Users / 用户**，点击 **Create user / 创建用户**。

4. 输入用户名，例如：

   ```text
   cloud-manager
   ```

5. 在权限配置中添加 EC2 相关权限。

   如果只是快速测试，可以临时使用 `AmazonEC2FullAccess`。正式使用时建议改成更小范围的自定义权限。

6. 创建用户后，进入该用户详情页。

7. 打开 **Security credentials / 安全凭证**。

8. 在 **Access keys / 访问密钥** 中点击 **Create access key / 创建访问密钥**。

9. 选择使用场景。

   如果页面要求选择用例，可以选择 **Application running outside AWS / 在 AWS 外部运行的应用程序**，或选择最接近“通过 API/SDK 调用”的选项。

10. 创建后保存以下两项：

    - Access Key ID
    - Secret Access Key

Secret Access Key 只会在创建时显示一次。如果丢失，需要删除旧 Access Key 并重新创建。

## 获取 Region

Region 是 AWS 区域标识，不是显示名称。

常见示例：

| 显示名称 | Region |
| --- | --- |
| Asia Pacific (Singapore) | `ap-southeast-1` |
| Asia Pacific (Tokyo) | `ap-northeast-1` |
| Asia Pacific (Seoul) | `ap-northeast-2` |
| US East (N. Virginia) | `us-east-1` |
| US West (Oregon) | `us-west-2` |

可以在 AWS 控制台右上角区域选择器中查看当前 Region。

## 在本项目中填写

| 项目字段 | 填写内容 |
| --- | --- |
| 账户名 | 自定义名称，例如 `AWS-主账号-新加坡` |
| 计算 Provider | Aws |
| Access Key ID | IAM 用户的 Access Key ID |
| Secret Access Key | IAM 用户的 Secret Access Key |
| Region | 需要管理的 AWS 区域 |

示例：

```text
账户名: AWS-主账号-新加坡
Access Key ID: AKIAIOSFODNN7EXAMPLE
Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
Region: ap-southeast-1
```

## 多 Region 添加 Demo

AWS 的 EC2 实例是按 Region 管理的。如果同一组 Access Key 需要管理多个 Region，建议在本项目中新增多条 AWS 账号记录，每条记录只改 `Region`。

第一条记录：

```text
账户名: AWS-主账号-新加坡
Access Key ID: AKIAIOSFODNN7EXAMPLE
Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
Region: ap-southeast-1
```

第二条记录：

```text
账户名: AWS-主账号-东京
Access Key ID: AKIAIOSFODNN7EXAMPLE
Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
Region: ap-northeast-1
```

第三条记录：

```text
账户名: AWS-主账号-美东
Access Key ID: AKIAIOSFODNN7EXAMPLE
Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
Region: us-east-1
```

## 多 AWS 账户添加 Demo

如果你有多个 AWS 账户，建议每个 AWS 账户创建独立 IAM 用户和独立 Access Key，然后分别新增记录。

第一个 AWS 账户：

```text
账户名: AWS-主账号-新加坡
Access Key ID: AKIA111111111111EXAMPLE
Secret Access Key: first-account-secret-access-key
Region: ap-southeast-1
```

第二个 AWS 账户：

```text
账户名: AWS-备用账号-美东
Access Key ID: AKIA222222222222EXAMPLE
Secret Access Key: second-account-secret-access-key
Region: us-east-1
```

## 安全注意事项

- 不要使用 Root 账户的 Access Key。
- 不要把 Access Key 提交到 Git。
- 不要把 Secret Access Key 发送到聊天工具或公开文档中。
- 建议为本项目单独创建 IAM 用户，方便单独禁用。
- 如果怀疑 Secret Access Key 泄露，请立即在 IAM 中禁用或删除该 Access Key，并重新创建。
- AWS IAM 用户最多可拥有两个 Access Key，轮换密钥时可以先创建新密钥，确认可用后再删除旧密钥。

## 官方参考

- AWS 官方文档：<https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html>
