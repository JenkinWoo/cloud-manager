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
docker compose up -d --build
```

默认访问地址：

```text
http://localhost:3001
```

## 环境变量

后端支持以下环境变量：

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 后端服务监听端口。 |
| `CLOUD_READ_TIMEOUT_MS` | `8000` | 云资源读取接口的超时时间，单位毫秒。 |
| `OPERATION_LOG_MAX` | `1000` | 操作日志最多保留条数；系统设置中的日志保留天数会同时生效，默认保留最近 30 天。 |

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
