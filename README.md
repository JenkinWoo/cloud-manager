# 云管理平台

一个用于统一管理 Oracle、AWS、Azure 和 DNS 资源的前后端项目。

## 功能概览

- 计算账户管理
- 云实例列表与操作
- 云流量看板
- Oracle / AWS 实例创建
- DNS 记录管理
- 任务队列
- Telegram 通知
- Docker 部署

## 技术栈

- 前端：Vue 3 + Vite
- 后端：Node.js + Express
- 数据存储：lowdb

## 项目结构

```text
backend/    后端服务与数据
frontend/   前端项目
```

## API Key 获取指南

添加云账号或 DNS 账号前，可以先参考以下文档获取对应平台的访问凭证：

- [Oracle API Key 获取教程](docs/oracle-api-key-guide.md)
- [AWS API Key 获取教程](docs/aws-api-key-guide.md)
- [Azure API Key 获取教程](docs/azure-api-key-guide.md)
- [Cloudflare DNS API Token 获取教程](docs/dns-cloudflare-guide.md)
- [Aliyun DNS AccessKey 获取教程](docs/dns-aliyun-guide.md)
- [Tencent Cloud DNSPod SecretId / SecretKey 获取教程](docs/dns-tencentcloud-guide.md)
- [Huawei Cloud DNS AK / SK 获取教程](docs/dns-huaweicloud-guide.md)

建议为本项目单独创建权限最小化的用户或 Token，不要使用主账号、Root 账号或全局 API Key；密钥只会在创建时完整显示一次，请妥善保存并避免提交到 Git。

## 本地开发

安装依赖：

```bash
npm install
cd frontend && npm install
```

启动后端：

```bash
npm run server
```

启动前端：

```bash
npm run frontend
```

同时启动前端和后端（后端支持热更新）：

```bash
npm run dev
```

## Docker 部署

项目已提供 Docker 部署文件，详细说明见：

`DEPLOY_DOCKER.md`

快速启动：

```bash
docker compose up -d
```

默认访问地址：

```text
http://localhost:3001
```

## 自动打包与更新

项目提供 GitHub Actions 工作流：推送到 `master` 或推送 `v*` 标签时，会自动构建 Docker 镜像并推送到 GitHub Container Registry：

```text
ghcr.io/jenkinwoo/cloud-manager
```

镜像标签包含：

- `latest`
- `package.json` 中的版本号，例如 `1.3.1`
- 当前提交 SHA

应用左侧菜单会显示当前版本号，并通过后端 `/api/version` 检查 GitHub 上 `package.json` 的最新版本。发现新版本后，版本弹窗会显示最新版本号、GitHub 发布页入口，以及“立即更新并重启”按钮。

Docker 部署时，`docker-compose.yml` 默认使用 GitHub Actions 构建好的镜像：

```text
ghcr.io/jenkinwoo/cloud-manager:latest
```

启动服务：

```bash
docker compose up -d
```

这样后续点击“立即更新并重启”时，不需要在服务器上重新 `docker compose up -d --build`。应用会调用 Watchtower HTTP API，Watchtower 拉取最新的 `latest` 镜像并重启 `cloud-manager` 容器。

自动更新流程：

1. 推送代码到 `master`。
2. GitHub Actions 构建并推送 `ghcr.io/jenkinwoo/cloud-manager:latest`。
3. 应用通过 `/api/version` 检查 GitHub 上的最新版本号。
4. 发现新版本后，左侧版本弹窗提示更新。
5. 点击“立即更新并重启”。
6. 后端调用 Watchtower，拉取最新镜像并重启容器。
7. 容器重启后运行新版本。
8. 前端约 30 秒后自动刷新页面。

如果你不是 Docker 部署，而是直接用 Node/PM2/systemd 运行源码，可以改用固定脚本模式：复制 `scripts/update-and-restart.example.sh` 为 `scripts/update-and-restart.sh`，修改最后的重启命令，并配置 `APP_UPDATE_SCRIPT="scripts/update-and-restart.sh"`。

注意：Docker 自动更新需要 Watchtower 访问 Docker Socket，请只在可信服务器上使用。Watchtower 的 HTTP API 没有映射到宿主机端口，只供 Compose 内部网络中的应用容器调用。

## 环境变量

后端支持以下环境变量：

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 后端服务监听端口。 |
| `CLOUD_READ_TIMEOUT_MS` | `8000` | 云资源读取接口的超时时间，单位毫秒。 |
| `OPERATION_LOG_MAX` | `1000` | 操作日志最多保留条数；系统设置中的日志保留天数会同时生效，默认保留最近 30 天。 |
| `APP_UPDATE_PACKAGE_URL` | `https://raw.githubusercontent.com/JenkinWoo/cloud-manager/master/package.json` | 版本检查使用的远程 `package.json` 地址。 |
| `APP_UPDATE_RELEASE_URL` | `https://github.com/JenkinWoo/cloud-manager/releases` | 版本弹窗的 GitHub 更新页面地址。 |
| `APP_UPDATE_WEBHOOK_URL` | 空 | Docker 自动更新触发地址；`docker-compose.yml` 中默认指向 Watchtower。 |
| `APP_UPDATE_SCRIPT` | 空 | 非 Docker 部署时使用的固定部署脚本路径。未配置 Webhook 或脚本时，前端只显示更新提示，不允许点击自动更新。 |

## 数据说明

运行过程中产生的数据默认保存在：

```text
backend/data
```

该目录已加入 `.gitignore`，不建议提交到 Git。

## Git 提交建议

建议不要提交以下内容：

- `node_modules`
- `frontend/dist`
- `backend/data`
- 本地 `.env` 文件
