# Oracle API Key 获取教程

本文档说明如何在 Oracle Cloud Infrastructure（OCI）中创建 API Signing Key，并整理在本项目中接入 Oracle 账号时通常需要填写的信息。

> Oracle 控制台中常说的 API Key，实际是 OCI 的 **API Signing Key**。它由一对 RSA 密钥组成：公钥上传到 Oracle 控制台，私钥保存在本地或服务器中，用于调用 OCI API 时签名请求。

## 需要准备的信息

接入 Oracle API 通常需要以下内容：

| 字段 | 说明 | 示例格式 |
| --- | --- | --- |
| Tenancy OCID | 租户 OCID | `ocid1.tenancy.oc1..aaaa...` |
| User OCID | 用户 OCID | `ocid1.user.oc1..aaaa...` |
| Region | 区域标识 | `ap-seoul-1`、`us-ashburn-1` |
| Fingerprint | API Key 指纹 | `12:34:56:...` |
| Private Key | 私钥内容 | `-----BEGIN PRIVATE KEY-----...` |
| Passphrase | 私钥密码 | 创建密钥时可选 |

## 方法一：在 Oracle 控制台生成 API Key

这是最简单的方式，适合不熟悉命令行的用户。

1. 登录 Oracle Cloud 控制台：

   <https://cloud.oracle.com/>

2. 点击右上角头像，进入 **My Profile / 我的个人资料**。

3. 在左侧菜单中找到 **API Keys / API 密钥**。

4. 点击 **Add API Key / 添加 API 密钥**。

5. 选择 **Generate API Key Pair / 生成 API 密钥对**。

6. 下载私钥文件。

   常见文件名类似：

   ```text
   oci_api_key.pem
   ```

   请妥善保存这个文件。私钥只会在创建时提供下载，之后无法从 Oracle 控制台重新查看。

7. 点击 **Add / 添加** 完成创建。

8. 创建成功后，Oracle 会显示一段配置内容，通常类似：

   ```ini
   [DEFAULT]
   user=ocid1.user.oc1..example
   fingerprint=12:34:56:78:90:ab:cd:ef
   tenancy=ocid1.tenancy.oc1..example
   region=ap-seoul-1
   key_file=<path to your private keyfile>
   ```

9. 记录以下字段：

   - `user`：User OCID
   - `fingerprint`：API Key 指纹
   - `tenancy`：Tenancy OCID
   - `region`：Oracle 区域
   - `key_file` 对应的私钥文件内容：Private Key

## 方法二：本地生成密钥后上传公钥

如果你希望自己管理密钥文件，可以在本地生成 RSA 密钥，然后把公钥上传到 Oracle 控制台。

### 1. 生成私钥

使用 OpenSSL 生成私钥：

```bash
openssl genrsa -out oci_api_key.pem 2048
```

如果需要给私钥设置密码，可以使用：

```bash
openssl genrsa -aes128 -out oci_api_key.pem 2048
```

### 2. 生成公钥

```bash
openssl rsa -pubout -in oci_api_key.pem -out oci_api_key_public.pem
```

### 3. 上传公钥

1. 登录 Oracle Cloud 控制台。
2. 点击右上角头像，进入 **My Profile / 我的个人资料**。
3. 打开 **API Keys / API 密钥**。
4. 点击 **Add API Key / 添加 API 密钥**。
5. 选择 **Paste Public Key / 粘贴公钥**。
6. 打开 `oci_api_key_public.pem`，复制完整内容并粘贴。
7. 点击 **Add / 添加**。

完成后，Oracle 会显示该 API Key 的 `fingerprint`。

## 获取 Tenancy OCID

1. 登录 Oracle Cloud 控制台。
2. 打开左上角菜单。
3. 进入 **Identity & Security / 身份与安全**。
4. 找到 **Tenancy Details / 租户详细信息**。
5. 复制 **OCID**。

Tenancy OCID 通常以以下格式开头：

```text
ocid1.tenancy.oc1..
```

## 获取 User OCID

1. 登录 Oracle Cloud 控制台。
2. 点击右上角头像。
3. 进入 **My Profile / 我的个人资料**。
4. 在用户详情页面复制 **OCID**。

User OCID 通常以以下格式开头：

```text
ocid1.user.oc1..
```

## 获取 Region

Region 是 Oracle 区域标识，不是区域显示名称。

常见示例：

| 显示名称 | Region |
| --- | --- |
| South Korea Central (Seoul) | `ap-seoul-1` |
| Japan East (Tokyo) | `ap-tokyo-1` |
| Singapore | `ap-singapore-1` |
| US East (Ashburn) | `us-ashburn-1` |
| US West (Phoenix) | `us-phoenix-1` |

可以在 Oracle 控制台右上角的区域选择器中查看当前区域。

## 在本项目中填写时的建议

添加 Oracle 账号时，本项目把 **OCI Config** 和 **Private Key** 分成两个输入框：

- `OCI Config`：粘贴 Oracle 控制台给出的 `[DEFAULT]` 配置信息。
- `Private Key`：粘贴 `oci_api_key.pem` 私钥文件的完整内容。

### OCI Config 输入框

这里粘贴 `.oci/config` 格式的配置项，不要把私钥内容粘贴到这里。

```ini
[DEFAULT]
user=ocid1.user.oc1..aaaaaaaaexampleuserocid
fingerprint=12:34:56:78:90:ab:cd:ef:12:34:56:78:90:ab:cd:ef
tenancy=ocid1.tenancy.oc1..aaaaaaaexampletenancyocid
region=ap-seoul-1
key_file=oci_api_key.pem
```

如果你的私钥设置了密码，可以在 `OCI Config` 中额外加入 `pass_phrase`：

```ini
[DEFAULT]
user=ocid1.user.oc1..aaaaaaaaexampleuserocid
fingerprint=12:34:56:78:90:ab:cd:ef:12:34:56:78:90:ab:cd:ef
tenancy=ocid1.tenancy.oc1..aaaaaaaexampletenancyocid
region=ap-seoul-1
pass_phrase=your_private_key_password
key_file=oci_api_key.pem
```

`key_file` 在本项目中通常只是占位信息，因为私钥会通过 `Private Key` 输入框单独传入。你可以保留 Oracle 控制台生成的原始值，也可以写成 `oci_api_key.pem`。

### Private Key 输入框

这里粘贴私钥文件的完整内容，必须包含头尾两行：

```text
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASC...
这里替换为你的完整私钥内容
...
-----END PRIVATE KEY-----
```

如果你的私钥是加密私钥，内容通常类似：

```text
-----BEGIN ENCRYPTED PRIVATE KEY-----
MIIE6TAbBgkqhkiG9w0BBQMwDgQI...
这里替换为你的完整加密私钥内容
...
-----END ENCRYPTED PRIVATE KEY-----
```

字段对应关系如下：

| 项目字段 | Oracle 配置字段 |
| --- | --- |
| 租户 OCID / Tenancy OCID | `tenancy` |
| 用户 OCID / User OCID | `user` |
| 区域 / Region | `region` |
| API Key 指纹 / Fingerprint | `fingerprint` |
| 私钥 / Private Key | `oci_api_key.pem` 文件完整内容 |
| 私钥密码 / Passphrase | 生成私钥时设置的密码，没有则留空 |

## 多 Region / 多租户添加 Demo

### 场景一：同一个租户添加多个 Region

如果同一个 Oracle 租户已经订阅了多个 Region，比如首尔和东京，可以在本项目中添加多个 Oracle 账号记录。每条记录的 `tenancy`、`user`、`fingerprint` 和 `Private Key` 可以相同，只需要修改 `region`。

建议账号名写清楚区域，方便后续区分：

```text
Oracle-主账号-首尔
Oracle-主账号-东京
```

第一条记录：

`OCI Config` 输入框：

```ini
[DEFAULT]
user=ocid1.user.oc1..aaaaaaaaexampleuserocid
fingerprint=12:34:56:78:90:ab:cd:ef:12:34:56:78:90:ab:cd:ef
tenancy=ocid1.tenancy.oc1..aaaaaaaexampletenancyocid
region=ap-seoul-1
key_file=oci_api_key.pem
```

`Private Key` 输入框：

```text
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASC...
这里替换为你的完整私钥内容
...
-----END PRIVATE KEY-----
```

第二条记录：

`OCI Config` 输入框：

```ini
[DEFAULT]
user=ocid1.user.oc1..aaaaaaaaexampleuserocid
fingerprint=12:34:56:78:90:ab:cd:ef:12:34:56:78:90:ab:cd:ef
tenancy=ocid1.tenancy.oc1..aaaaaaaexampletenancyocid
region=ap-tokyo-1
key_file=oci_api_key.pem
```

`Private Key` 输入框仍然粘贴同一份私钥内容。

### 场景二：添加多个 Oracle 租户

如果你有多个 Oracle 租户，例如一个主账号、一个备用账号，需要分别新增多条 Oracle 账号记录。不同租户通常有不同的 `tenancy`、`user`、`fingerprint` 和 `Private Key`。

第一个租户：

`OCI Config` 输入框：

```ini
[DEFAULT]
user=ocid1.user.oc1..aaaaaaaafirstuserocid
fingerprint=11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00
tenancy=ocid1.tenancy.oc1..aaaaaaafirsttenancyocid
region=ap-seoul-1
key_file=oci_api_key.pem
```

`Private Key` 输入框：

```text
-----BEGIN PRIVATE KEY-----
这里替换为第一个租户对应用户的完整私钥内容
-----END PRIVATE KEY-----
```

第二个租户：

`OCI Config` 输入框：

```ini
[DEFAULT]
user=ocid1.user.oc1..aaaaaaaaseconduserocid
fingerprint=aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99
tenancy=ocid1.tenancy.oc1..aaaaaaasecondtenancyocid
region=us-ashburn-1
key_file=oci_api_key.pem
```

`Private Key` 输入框：

```text
-----BEGIN PRIVATE KEY-----
这里替换为第二个租户对应用户的完整私钥内容
-----END PRIVATE KEY-----
```

### 填写规则总结

- 同租户、多 Region：复制同一份配置，修改 `region`，私钥通常不变。
- 多租户：每个租户单独新增一条记录，分别填写对应租户的 `OCI Config` 和 `Private Key`。
- 一个 Oracle 账号记录建议只对应一个 Region，后续查看实例、创建实例和管理资源时更清晰。
- 账号名建议包含租户用途和 Region，例如 `Oracle-备用账号-阿什本`。

## 安全注意事项

- 不要把私钥提交到 Git。
- 不要把私钥发送到聊天工具或公开文档中。
- 建议为不同系统创建不同 API Key，方便单独禁用。
- 如果怀疑私钥泄露，请立即在 Oracle 控制台删除对应 API Key，并重新生成。
- 私钥文件建议只允许当前用户读取。

## 官方参考

- Oracle 官方文档：<https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm>
- OCI CLI 配置文档：<https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliconfigure.htm>
