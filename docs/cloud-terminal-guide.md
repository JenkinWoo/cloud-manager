# 实例救援终端

打开侧边栏 **实例救援终端**，选择云账户后按名称下拉选择实例，连接信息自动填充，无需手动粘贴实例 ID。Azure 会自动加载订阅，可切换订阅后选择实例；云实例卡片上的 **救援终端** 会带入账户并自动选中对应实例。列表加载失败时请刷新重试。点击连接后，命令输入和输出都在本项目中完成。连接不会自动运行救援命令、重启、修改防火墙或更改系统密码。

## 支持范围

| 模式 | Oracle | AWS | Azure |
| --- | --- | --- | --- |
| 实例串口救援 | Console Connection，商业区端点 | EC2 Serial Console，官方已列出指纹的区域 | Serial Console，Azure 公有云 |

实例串口直接操作目标实例的控制台，适合 SSH 服务、防火墙或来宾网络故障。实例损坏到无法启动时，还可能需要使用磁盘挂载、恢复镜像等手段。

自动化验证使用模拟云 API、SSH 通道和上游 WebSocket，并测试真实的本地 WebSocket 转发。另已在 Oracle 新加坡区域实际完成串口 SSH 握手与终端建立；尚未验证各平台、各区域或操作系统登录及救援命令。

## 实例救援前提

### Oracle

- 使用账户配置中的区域，目标实例应在该区域。
- API 用户需要目标区间内查询实例及创建、查询、删除 Instance Console Connection 的权限。例如按实际区间配置 `Allow group <group> to manage instance-console-connection in compartment <compartment>`，并保留所需的实例查询权限。
- 后端须能访问 OCI API（HTTPS）和区域 `instance-console.<region>.oci.oraclecloud.com` 的 TCP 443。
- 每次连接生成临时 RSA 客户端密钥；服务端密钥算法由 SSH 协商，支持 Oracle 的 ECDSA 主机密钥。外层官方 SSH 代理严格核验 API 返回的服务主机指纹，内部串口仅经这个已验证、加密的代理通道访问指定实例 OCID。内部串口使用不同主机密钥，不能用代理指纹校验它。只删除本会话创建的 Console Connection，不删除已有连接。
- 如果已有 Console Connection，模块会报冲突，需要先从原连接处断开并删除。串口一般仍要求操作系统登录；看不到提示时先按 Enter。
- 后端被强制终止、云 API 超时或清理失败时可能留下控制台连接。请在目标实例的 Console Connections 中检查残留，再重新连接。

参考：[Oracle 实例控制台连接](https://docs.oracle.com/en-us/iaas/Content/Compute/References/serialconsole.htm)。

### AWS

- 管理员需预先为账户及区域启用 EC2 Serial Console；本模块仅查询状态，不代为启用。
- 使用账户所配区域中的实例。实例类型、运行状态、来宾串口配置和系统登录方式须满足 AWS 的串口前提条件。
- IAM 至少需要 `ec2:GetSerialConsoleAccessStatus` 和目标实例的 `ec2-instance-connect:SendSerialConsoleSSHPublicKey` 权限。加载实例列表还需要已有的实例查询权限。
- 后端须可访问 AWS API（HTTPS）以及官方区域串口端点的 TCP 22。连接使用短时有效的临时 SSH 公钥，私钥只保留在内存中。
- 固定官方 SSH 主机指纹记录在 `backend/utils/awsSerialEndpoints.mjs`。出现指纹不匹配时，核对官方文档是否已轮换；不会自动跳过验证。未知区域会拒绝连接。

参考：[AWS 连接说明、区域端点与指纹](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-to-serial-console.html)、[串口前提条件](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-serial-console-prerequisites.html)。

### Azure 实例串口

- 使用现有 Azure 服务主体凭据，支持公有云虚拟机资源 ID，例如 `/subscriptions/<id>/resourceGroups/<group>/providers/Microsoft.Compute/virtualMachines/<name>`。暂不支持 VM Scale Set 子实例和其他主权云。
- 订阅中的串口服务、VM 启动诊断及操作系统串口应按 Azure 要求配置。应用须有访问目标 VM 及 `Microsoft.SerialConsole/serialPorts/connect/action` 的权限；自定义诊断存储配置可能要求额外权限。
- 后端通过 ARM 获取连接地址，再建立 HTTPS/WebSocket 连接。用户不需要粘贴 Azure Bearer Token。
- Linux 使用系统登录提示，Windows 可能显示 SAC。串口大小受云平台限制，页面缩放不会修改来宾串口设置。

参考：[Azure Linux 串口](https://learn.microsoft.com/troubleshoot/azure/virtual-machines/linux/serial-console-linux)、[Serial Ports Connect API](https://learn.microsoft.com/rest/api/serialconsole/serial-ports/connect)。

## 部署与会话管理

- 安装新增依赖后重启后端并重新构建前端：`npm install`、`npm --prefix frontend install`、`npm --prefix frontend run build`。
- 浏览器经同源 `/api/cloud-shell/socket` 连接后端。公网访问应通过 HTTPS/WSS，反向代理需允许 WebSocket Upgrade，并保留原始 Host 和 Origin。
- 登录令牌只在 WebSocket 首帧发送，不放在 URL 中；会话与创建它的登录绑定，不可转移或重复接管。每个登录最多 4 个会话，全服务最多 12 个，同一账户实例同时只允许一个救援连接。
- 未接入 WebSocket 的预约在 60 秒后过期；启动等待最多 10 分钟，连接空闲 15 分钟、总时长 1 小时后关闭。退出登录、撤销登录或禁用账户后，最迟在下一次 15 秒检查时断开。
- 页面关闭、刷新或导航离开会断开，刷新时通过 `pagehide` 和 keepalive 请求主动关闭会话，WebSocket 断开及心跳检测仍作为兜底。Oracle 清理会等待云端确认删除；同一登录重连时等待正在清理的旧会话。服务重启会终止会话，不支持跨进程恢复。Oracle 清理失败会在后端日志输出 `[terminal] ... remote cleanup failed`。
- 系统日志记录创建/关闭会话的 HTTP 请求，不记录键入命令和终端内容。内存终端滚动缓冲也会随页面离开清除。
- 多副本部署需将会话 REST 请求和 WebSocket 固定路由到同一进程；当前会话注册表仅在内存中。

Nginx 示例（放在对应 `server` 内；端口按实际部署修改）：

```nginx
location = /api/cloud-shell/socket {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $http_host;
    proxy_set_header Origin $http_origin;
    proxy_read_timeout 3700s;
}
```

若代理无法保留原始 Host，可以设置 `CLOUD_SHELL_ALLOWED_ORIGINS=https://cloud.example.com`，多个明确来源用逗号分隔，不支持通配符。Vite 开发代理已配置 WebSocket 支持。

## API 与测试

- `GET /api/cloud-shell`：启用账户的非敏感上下文与终端能力。
- `POST /api/cloud-shell/sessions`：创建会话预约，正文包含 `accountId`、`mode`（仅支持 `serial`）、`instanceId`（必需）、`cols`、`rows`。
- `DELETE /api/cloud-shell/sessions/:id`：取消或关闭自己的会话。
- `/api/cloud-shell/socket`：同源 WebSocket，首帧 `{ "type": "auth", "token": "<本项目登录令牌>", "sessionId": "<预约ID>" }`。认证后支持 `input` 与 `resize`，返回状态及 base64 编码的终端输出。

隔离测试不会读取真实账户文件、连接真实云平台或执行系统命令：

```bash
node --experimental-test-module-mocks --test tests/cloudShell.test.mjs tests/cloudTerminalProviders.test.mjs
```
