# 云管理平台

一个用于统一管理 Oracle、AWS 和 DNS 资源的前后端项目。

## 功能概览

- 计算账户管理
- 云实例列表与操作
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
cd frontend
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
| `AUTH_USERNAME` | `admin` | 首次初始化登录账户时使用的默认用户名。 |
| `AUTH_PASSWORD` | `admin123` | 首次初始化登录账户时使用的默认密码。 |
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

## 说明

如果用于 GitHub 展示，建议优先阅读：

- `README.md`
- `DEPLOY_DOCKER.md`
