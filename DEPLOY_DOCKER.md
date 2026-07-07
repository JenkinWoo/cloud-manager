# Docker 部署说明

## 环境要求

- 已安装 Docker
- 已安装 Docker Compose
- 默认占用端口：`3001`

## 目录说明

- 前端静态文件会在镜像构建时打包
- 数据目录挂载为 `./backend/data`

在项目根目录执行：

```bash
docker compose up -d
```

启动后访问：

```text
http://localhost:3001
```

## 常用命令

启动或更新：

```bash
docker compose pull
docker compose up -d
```

停止服务：

```bash
docker compose down
```

查看日志：

```bash
docker compose logs -f app
```

查看容器状态：

```bash
docker compose ps
```

## 数据持久化

本项目使用 lowdb 保存以下数据：

- 计算账户
- DNS 账户
- 任务队列
- 系统设置
- 系统日志

宿主机目录：

```text
./backend/data
```

容器内目录：

```text
/app/backend/data
```

删除容器后，只要没有删除宿主机的 `backend/data`，数据就会保留。

## 环境变量

`docker-compose.yml` 默认配置了 `NODE_ENV` 和 `PORT`。如需调整后端行为，可以在 `environment` 中增加或覆盖以下变量：

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 后端服务监听端口，修改后需要同步调整端口映射。 |
| `AUTH_USERNAME` | `admin` | 首次初始化登录账户时使用的默认用户名。 |
| `AUTH_PASSWORD` | `admin123` | 首次初始化登录账户时使用的默认密码。 |
| `CLOUD_READ_TIMEOUT_MS` | `8000` | 云资源读取接口的超时时间，单位毫秒。 |
| `OPERATION_LOG_MAX` | `1000` | 操作日志最多保留条数；系统设置中的日志保留天数会同时生效，默认保留最近 30 天。 |

示例：

```yaml
environment:
  NODE_ENV: production
  PORT: 3001
  OPERATION_LOG_MAX: 2000
```

## 点击更新并自动重启

`docker-compose.yml` 默认启动两个服务：

- `cloud-manager`：业务应用，使用 `ghcr.io/jenkinwoo/cloud-manager:latest`
- `cloud-manager-watchtower`：只在点击更新时拉取新镜像并重启业务容器

完整流程：

1. 递增 `package.json` / `package-lock.json` 版本号并推送代码到 GitHub。
2. GitHub Actions 构建并推送新镜像。
3. GitHub Actions 创建 `v版本号` Release，上传 `.tar.gz` / `.zip` 资源包和 `SHA256SUMS.txt`，并生成本次更新日志。
4. 应用检测到新的 `package.json` 版本号。
5. 在左侧版本弹窗点击“立即更新并重启”。
6. Watchtower 拉取最新镜像并重启 `cloud-manager` 容器。

Watchtower 的 HTTP API 没有映射到宿主机端口，只供 Compose 内部网络中的应用容器调用。

## 本地构建并推送镜像测试更新

如果你不想每次都依赖 GitHub Actions 构建镜像，也可以在本地或 Debian 服务器上手动构建并推送到 GHCR：

```bash
docker login ghcr.io
docker buildx create --use
chmod +x scripts/publish-docker-local.sh
./scripts/publish-docker-local.sh
```

也可以指定版本：

```bash
./scripts/publish-docker-local.sh 1.3.3
```

测试自动更新时需要同时满足两件事：

1. GitHub 上的根 `package.json` 版本号比当前容器内版本高。
2. GHCR 中已经有对应的新镜像，至少要更新 `ghcr.io/jenkinwoo/cloud-manager:latest`。

完整测试流程：

```bash
# 1. 修改 package.json / package-lock.json 的版本号并提交到 GitHub
git add package.json package-lock.json
git commit -m "chore: bump version"
git push

# 2. 本地或 Debian 上构建并推送镜像
./scripts/publish-docker-local.sh

# 3. 打开页面，点击版本弹窗中的“立即更新并重启”
```

如果只改 GitHub 的 `package.json`，页面能发现新版本，但点击更新时 Watchtower 拉不到新镜像，实际版本不会变化。

## 本地手动构建镜像

如果你不使用 GitHub Actions 预构建镜像，也可以手动构建镜像：

构建镜像：

```bash
docker build -t cloud-manager .
```

Linux / macOS 运行：

```bash
docker run -d \
  --name cloud-manager \
  -p 3001:3001 \
  -e NODE_ENV=production \
  -e PORT=3001 \
  -v $(pwd)/backend/data:/app/backend/data \
  cloud-manager
```

Windows PowerShell 运行：

```powershell
docker run -d `
  --name cloud-manager `
  -p 3001:3001 `
  -e NODE_ENV=production `
  -e PORT=3001 `
  -v ${PWD}/backend/data:/app/backend/data `
  cloud-manager
```

## 更新部署

使用预构建镜像时执行：

```bash
docker compose pull
docker compose up -d
```

如果你选择本地手动构建镜像，才需要执行：

```bash
docker compose up -d --build
```

## 故障排查

如果页面打不开，优先检查：

1. `docker compose ps` 确认容器是否启动
2. `docker compose logs -f app` 查看后端是否报错
3. `3001` 端口是否被其他程序占用
4. `backend/data` 是否有读写权限
