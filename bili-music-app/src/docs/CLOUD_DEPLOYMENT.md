# 上云部署说明

这份文档按“买一台 VPS 后怎么部署”的顺序写。目标架构是：

```text
浏览器 / Android App
  ↓ HTTPS
Nginx / Caddy
  ↓ http://127.0.0.1:3000
bili-music-app  Next.js App
  ↓ http://127.0.0.1:8000
bili-ctf-audio-kernel  FastAPI + Playwright + ffmpeg
  ↓
kernel/storage  B 站登录态 profile + 临时音频 artifact
```

核心原则：

- 只把 `bili-music-app` 暴露到公网。
- `kernel` 尽量只监听 `127.0.0.1` 或内网地址，不直接暴露公网。
- Web 和 Android 都调用 App API。
- App 不保存 Cookie、storage state、browser profile、签名媒体 URL、音频文件、视频文件。
- B 站登录态和 artifact 只留在 kernel。

## 1. 服务器建议

最低可用：

- 2 核 CPU
- 2GB RAM
- 20GB 磁盘

更舒服：

- 2-4 核 CPU
- 4GB RAM
- 40GB 磁盘

原因：

- `api_dash` 策略比较轻，2 核机器能跑。
- `browser_network` / `mse_sourcebuffer` 会启动 Chromium，更吃内存。
- kernel 会临时保存 artifact，磁盘太小要控制 TTL 和清理策略。

## 2. 准备系统

下面以 Ubuntu/Debian VPS 为例。

```bash
sudo apt update
sudo apt install -y git curl ca-certificates nginx
```

安装 Docker：

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

重新登录 SSH，让 docker 用户组生效。

安装 Node.js 22 或更高版本。可以用系统包、nvm、NodeSource，任选一种。确认：

```bash
node -v
npm -v
docker version
docker compose version
```

## 3. 上传代码

推荐路径：

```bash
sudo mkdir -p /opt/b-music
sudo chown -R $USER:$USER /opt/b-music
cd /opt/b-music
git clone <your-repo-url> .
```

如果不是 Git 部署，也可以把整个 workspace 上传到 `/opt/b-music`。

最终目录大概是：

```text
/opt/b-music/
  bili-music-app/
  kernel/
  tests/
```

## 4. 启动 kernel

进入 kernel：

```bash
cd /opt/b-music/kernel
cp .env.example .env
```

检查 `.env`。生产上建议：

```bash
KERNEL_HOST=0.0.0.0
KERNEL_PORT=8000
```

如果 kernel 和 App 在同一台机器，Docker 可以把端口只绑定到本机。检查 `kernel/docker-compose.yml` 的 ports，推荐：

```yaml
ports:
  - "127.0.0.1:8000:8000"
```

启动：

```bash
docker compose up -d --build
```

检查：

```bash
curl http://127.0.0.1:8000/health
```

看到类似下面就算 kernel 活了：

```json
{"status":"ok"}
```

查看日志：

```bash
docker compose logs -f
```

注意：日志里不应该出现 Cookie、storage_state、完整签名媒体 URL。

## 5. 配置 App

进入 App：

```bash
cd /opt/b-music/bili-music-app
cp .env.example .env
```

编辑 `.env`：

```bash
NEXT_PUBLIC_APP_NAME=bili-music-app
SEARCH_PROVIDER=bilibili
BILIBILI_SEARCH_TIMEOUT_MS=8000
BILIBILI_SEARCH_LIMIT=20
KERNEL_BASE_URL=http://127.0.0.1:8000
KERNEL_REQUEST_TIMEOUT_MS=15000
KERNEL_EXTERNAL_OWNER_ID=local
TRACK_ARTIFACT_TTL_SECONDS=86400
DATABASE_PATH=/opt/b-music/bili-music-app/data/bili-music-app.sqlite
APP_OWNER_ID=local
```

关键解释：

- `KERNEL_BASE_URL`：App 调 kernel 的地址。生产推荐 `http://127.0.0.1:8000`。
- `KERNEL_REQUEST_TIMEOUT_MS`：App 调 kernel JSON API 的超时上限。
- `DATABASE_PATH`：App 的 SQLite metadata 数据库路径。
- `TRACK_ARTIFACT_TTL_SECONDS`：App 认为 kernel artifact 有效多久。过期后会提示重新准备。
- `APP_OWNER_ID`：本地单用户部署使用的稳定 metadata owner。

安装依赖并构建：

```bash
npm ci
npm run build
```

本地试启动：

```bash
npm run start -- --hostname 127.0.0.1 --port 3000
```

另开一个 SSH 窗口检查：

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/kernel/health
```

两个都 OK 后再做常驻服务。

## 6. 用 systemd 常驻 App

创建服务文件：

```bash
sudo nano /etc/systemd/system/bili-music-app.service
```

填入：

```ini
[Unit]
Description=bili-music-app
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/b-music/bili-music-app
EnvironmentFile=/opt/b-music/bili-music-app/.env
ExecStart=/usr/bin/npm run start -- --hostname 127.0.0.1 --port 3000
Restart=always
RestartSec=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

给目录权限：

```bash
sudo chown -R www-data:www-data /opt/b-music/bili-music-app
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable bili-music-app
sudo systemctl start bili-music-app
sudo systemctl status bili-music-app
```

看日志：

```bash
journalctl -u bili-music-app -f
```

如果你的 `npm` 不在 `/usr/bin/npm`，先执行：

```bash
which npm
```

然后把 systemd 里的路径改成实际路径。

## 7. 配置 Nginx HTTPS 反代

假设域名是：

```text
music.example.com
```

创建 Nginx 配置：

```bash
sudo nano /etc/nginx/sites-available/bili-music-app
```

先用 HTTP 配置：

```nginx
server {
  listen 80;
  server_name music.example.com;

  client_max_body_size 20m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # 音频 stream 需要尽量少缓冲，Range 请求要原样透传。
    proxy_buffering off;
    proxy_request_buffering off;
  }
}
```

启用：

```bash
sudo ln -s /etc/nginx/sites-available/bili-music-app /etc/nginx/sites-enabled/bili-music-app
sudo nginx -t
sudo systemctl reload nginx
```

申请 HTTPS 证书，例如使用 certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d music.example.com
```

完成后访问：

```text
https://music.example.com
```

## 8. 防火墙建议

只开放：

- 22 SSH
- 80 HTTP
- 443 HTTPS

不要开放：

- 3000 App 内部端口
- 8000 kernel 内部端口

UFW 示例：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

## 9. Android 调用方式

Android 不直接调用 kernel。

Android 调 App：

```text
https://music.example.com/api/kernel/login/status
https://music.example.com/api/kernel/login/start
https://music.example.com/api/search
https://music.example.com/api/favorites
https://music.example.com/api/creators
https://music.example.com/api/tracks/prepare
https://music.example.com/api/tracks/{id}/stream
```

完整请求体和响应示例见 `src/docs/API_USAGE.md`。

播放时：

1. Android 调 `/api/tracks/prepare`。
2. 轮询 `/api/tracks/{id}`。
3. `status=ready` 后，把 `/api/tracks/{id}/stream` 交给播放器。
4. 播放器拖进度条时会发 `Range`，App 会转发给 kernel。

不要让 Android 拿到：

- Bilibili Cookie
- storage_state
- browser profile
- kernel artifact 本地路径
- 签名媒体 URL

## 10. 数据与备份

App 需要备份：

```text
/opt/b-music/bili-music-app/data/bili-music-app.sqlite
```

如果 SQLite 开着 WAL，也一起备份：

```text
bili-music-app.sqlite
bili-music-app.sqlite-wal
bili-music-app.sqlite-shm
```

kernel 需要谨慎备份：

```text
/opt/b-music/kernel/storage
```

注意：kernel storage 里可能包含浏览器登录态，属于敏感数据。不要发给别人，不要传到公开对象存储。

不需要备份：

- `node_modules`
- `.next/cache`
- kernel 临时 artifact，如果你接受过期后重新提取

## 11. 更新部署

更新代码：

```bash
cd /opt/b-music
git pull
```

更新 kernel：

```bash
cd /opt/b-music/kernel
docker compose up -d --build
```

更新 App：

```bash
cd /opt/b-music/bili-music-app
npm ci
npm run build
sudo systemctl restart bili-music-app
```

检查：

```bash
curl https://music.example.com/api/health
curl https://music.example.com/api/kernel/health
```

## 12. 上线验收清单

基础：

- `GET /api/health` 返回 OK。
- `GET /api/kernel/health` 返回 OK。
- 首页能打开。
- 搜索能返回结果和封面。
- 收藏能保存并刷新后仍存在。
- 关注 UP 能保存并影响排序。

登录：

- 能创建 kernel profile。
- 能启动二维码登录。
- 页面能显示二维码图片。
- 扫码后能看到 `bili_uid` 和 `nickname`。
- App 页面/API 不返回 Cookie。

播放：

- 点击播放后 Track 进入 `preparing`。
- kernel job 成功后 Track 进入 `ready`。
- `/api/tracks/{id}/stream` 能播放。
- 拖动进度条能继续播放。
- kernel artifact 过期后页面提示重新准备。

安全：

- 公网不能访问 `http://服务器IP:8000`。
- 日志里没有 Cookie。
- 日志里没有完整签名媒体 URL。
- App 目录没有 `.m4a`、`.m4s`、`.mp4` 等媒体文件。

## 13. 常见问题

### `/api/kernel/health` 失败

检查 kernel 是否启动：

```bash
cd /opt/b-music/kernel
docker compose ps
docker compose logs --tail=100
curl http://127.0.0.1:8000/health
```

检查 App `.env`：

```bash
KERNEL_BASE_URL=http://127.0.0.1:8000
```

### 点播放很慢

优先确认是不是用了浏览器策略：

- `api_dash` 最快。
- `browser_network` 会启动 Chromium，2 核机器会慢。
- `mse_sourcebuffer` 是兜底策略，不适合默认播放。

建议默认播放强制 `api_dash`，失败时再手动换策略。

### 能播放但不能拖进度条

检查 Nginx 是否影响了 Range：

- 不要拦截 `Range` 请求头。
- 不要缓存 `/api/tracks/{id}/stream`。
- `proxy_buffering off`。

用 curl 测：

```bash
curl -I -H "Range: bytes=0-1023" https://music.example.com/api/tracks/1/stream
```

理想情况返回 `206 Partial Content`。

### 封面不显示

App 使用 `/api/image-proxy` 代理 Bilibili 封面。检查：

- `coverUrl` 是否来自 `i0.hdslb.com` / `i1.hdslb.com` / `i2.hdslb.com`。
- URL 路径是否在 `/bfs/` 下。
- Nginx 是否能正常代理图片响应。

### SQLite 权限错误

检查目录权限：

```bash
sudo chown -R www-data:www-data /opt/b-music/bili-music-app/data
```

如果 systemd 使用的不是 `www-data`，改成对应用户。

### 磁盘快满了

检查：

```bash
df -h
du -h --max-depth=2 /opt/b-music/kernel/storage | sort -h
du -h --max-depth=2 /opt/b-music/bili-music-app | sort -h
```

App 不应该保存音视频。大文件通常来自 kernel artifact 或 Docker 镜像。

清理 Docker：

```bash
docker system df
docker image prune
```

不要手动删除正在使用的 kernel profile。
