# Mobile App Backend API

本文档只描述手机 App / 网页端应该调用的后端 API。

调用方向：

```text
手机 App / 网页端 -> bili-music-app 后端 API
```

不要让手机 App 直连 kernel。kernel 是后端内部服务，只能由 `bili-music-app` 后端在内网调用。

## Base URL

本地开发：

```text
http://127.0.0.1:9000
```

VPS 部署：

```text
https://music.example.com
```

下面用 `{BASE_URL}` 表示后端地址。

## 通用约定

请求：

- JSON 接口统一使用 `Content-Type: application/json`。
- 手机 App 不需要传任何内部 profile / owner 字段。
- 手机 App 不需要知道 kernel 地址。

响应：

- 成功返回 JSON。
- 失败通常返回：

```json
{
  "error": "错误说明"
}
```

安全边界：

- 后端不会返回 Bilibili Cookie。
- 后端不会返回 browser profile。
- 后端不会返回 storage state / localStorage / sessionStorage。
- 后端不会返回签名媒体 URL。
- 后端不会返回 kernel artifact 本地路径。

## 1. 登录

登录接口用于展示 Bilibili 扫码二维码，并查询扫码状态。

注意：路径里有 `kernel` 是历史命名，但手机 App 调的是 `bili-music-app` 后端，不是直连 kernel。

### 查询登录状态

```http
GET /api/kernel/login/status
```

示例：

```bash
curl "{BASE_URL}/api/kernel/login/status"
```

响应：

```json
{
  "loggedIn": true,
  "biliUid": "123456",
  "nickname": "Bilibili 用户",
  "lastVerifiedAt": "2026-05-13T12:00:00+00:00"
}
```

手机端使用方式：

- `loggedIn=true`：可以显示已登录状态。
- `loggedIn=false`：显示“扫码登录”按钮。
- 如果响应里出现额外调试字段，手机端忽略即可，不要展示给用户。

### 发起扫码登录

```http
POST /api/kernel/login/start
```

请求体为空即可：

```bash
curl -X POST "{BASE_URL}/api/kernel/login/start"
```

响应：

```json
{
  "loginSessionId": "ls_xxx",
  "status": "pending",
  "message": "Scan the QR image...",
  "qrImageUrl": "/api/kernel/login/qr?...",
  "expiresInSeconds": 180
}
```

手机端使用方式：

1. 调 `POST /api/kernel/login/start`。
2. 把 `{BASE_URL} + qrImageUrl` 显示成图片。
3. 每 2-3 秒轮询 `GET /api/kernel/login/status`。
4. `loggedIn=true` 后停止轮询并刷新用户状态。

### 获取二维码图片

```http
GET /api/kernel/login/qr?... 
```

这个 URL 由 `login/start` 返回。手机 App 不要自己拼接，只需要显示返回的 `qrImageUrl`。

## 2. 搜索歌曲 / 视频链接识别

```http
POST /api/search
```

用途：

- 搜索歌曲名。
- 搜索 UP。
- 输入 BV 号。
- 输入 Bilibili 视频链接并生成可播放候选。

请求：

```json
{
  "keyword": "https://www.bilibili.com/video/BV1xx411c7mD",
  "useRemote": true,
  "provider": "bilibili",
  "limit": 20,
  "page": 1
}
```

字段：

- `keyword`: 必填。歌曲名、UP、BV 号或 Bilibili 视频链接。
- `useRemote`: 是否请求外部搜索源。`false` 表示只查本地缓存和链接直达。
- `provider`: 推荐默认 `bilibili`。需要登录态搜索时用 `kernel`。
- `limit`: 1-50。
- `page`: 1-10。

示例：

```bash
curl -X POST "{BASE_URL}/api/search" \
  -H "content-type: application/json" \
  -d '{
    "keyword": "夜航星",
    "useRemote": true,
    "provider": "bilibili",
    "limit": 20,
    "page": 1
  }'
```

响应：

```json
{
  "provider": "bilibili",
  "remoteUsed": true,
  "page": 1,
  "limit": 20,
  "hasPreviousPage": false,
  "hasNextPage": true,
  "candidates": [
    {
      "id": 123,
      "bvid": "BV1xx411c7mD",
      "title": "歌曲标题",
      "creatorName": "UP 名称",
      "creatorMid": "123456",
      "coverUrl": "https://i0.hdslb.com/...",
      "durationSeconds": 260,
      "sourceUrl": "https://www.bilibili.com/video/BV1xx411c7mD",
      "isFavorited": false
    }
  ]
}
```

手机端注意：

- 播放和收藏优先使用 `candidate.id` + `candidate.bvid`。
- 如果是用户直接粘贴视频链接，即使标题/UP 暂时不完整，也可能返回一个可播放候选。
- 不要把 `sourceUrl` 当音频地址，它只是 Bilibili 视频页地址。

## 3. 收藏歌曲

收藏歌曲是用户资产。网页端和手机端在同一个后端账号下共享。

### 收藏列表

```http
GET /api/favorites
```

示例：

```bash
curl "{BASE_URL}/api/favorites"
```

响应：

```json
{
  "favorites": [],
  "candidates": [
    {
      "id": 123,
      "bvid": "BV1xx411c7mD",
      "title": "歌曲标题",
      "isFavorited": true
    }
  ]
}
```

### 添加收藏

```http
POST /api/favorites
```

请求：

```json
{
  "candidateId": 123,
  "bvid": "BV1xx411c7mD"
}
```

示例：

```bash
curl -X POST "{BASE_URL}/api/favorites" \
  -H "content-type: application/json" \
  -d '{"candidateId":123,"bvid":"BV1xx411c7mD"}'
```

手机端注意：

- 推荐同时传 `candidateId` 和 `bvid`。
- 后端按稳定 `bvid` 保存收藏，避免搜索缓存变化后收藏丢失。
- 收藏成功后本地 UI 可以立即把红心置为已收藏。

### 取消收藏

```http
DELETE /api/favorites/{candidateId}
```

示例：

```bash
curl -X DELETE "{BASE_URL}/api/favorites/123"
```

响应：

```json
{
  "deleted": true
}
```

## 4. 喜欢的 UP

喜欢的 UP 也是用户资产。网页端和手机端共享。

### 获取 UP 列表

```http
GET /api/creators
```

### 添加 UP

```http
POST /api/creators
```

请求：

```json
{
  "biliMid": "123456",
  "name": "UP 名称",
  "priorityWeight": 70
}
```

### 修改 UP

```http
PATCH /api/creators/{id}
```

请求：

```json
{
  "name": "新名称",
  "priorityWeight": 80,
  "notes": "备注"
}
```

### 删除 UP

```http
DELETE /api/creators/{id}
```

## 5. 播放

播放分三步：

1. 准备 Track。
2. 轮询 Track 状态。
3. `ready` 后播放 stream。

### 准备播放

```http
POST /api/tracks/prepare
```

请求：

```json
{
  "candidateId": 123,
  "bvid": "BV1xx411c7mD",
  "strategyMode": "auto",
  "strategyOrder": ["api_dash", "browser_network"]
}
```

示例：

```bash
curl -X POST "{BASE_URL}/api/tracks/prepare" \
  -H "content-type: application/json" \
  -d '{
    "candidateId": 123,
    "bvid": "BV1xx411c7mD",
    "strategyMode": "auto",
    "strategyOrder": ["api_dash", "browser_network"]
  }'
```

响应：

```json
{
  "track": {
    "id": 456,
    "candidateId": 123,
    "bvid": "BV1xx411c7mD",
    "title": "歌曲标题",
    "status": "preparing"
  }
}
```

字段：

- `candidateId`: 推荐传。
- `bvid`: 推荐传，用于候选缓存恢复。
- `strategyMode`: `auto` 或 `force`。
- `strategy`: `force` 时使用，可选 `api_dash`、`browser_network`、`mse_sourcebuffer`。
- `strategyOrder`: `auto` 时使用。

手机端注意：

- 不要传内部 profile / owner 字段。
- 后端会自动决定使用哪个内核登录态。
- 如果已有可用 Track，后端可能直接返回 `ready`。

### 查询播放准备状态

```http
GET /api/tracks/{trackId}
```

示例：

```bash
curl "{BASE_URL}/api/tracks/456"
```

响应：

```json
{
  "track": {
    "id": 456,
    "status": "ready",
    "durationSeconds": 260,
    "failureReason": null
  }
}
```

状态：

- `pending`: 等待准备。
- `preparing`: 后端正在准备。
- `ready`: 可以播放。
- `expired`: 临时音频已过期，需要重新准备。
- `failed`: 准备失败。

建议轮询：

- `preparing` 时每 1.5-3 秒轮询一次。
- `ready` 后停止轮询并播放。
- `failed` 展示 `failureReason`。
- `expired` 自动重新调用 `POST /api/tracks/prepare` 或提示用户重试。

### 重新准备

```http
POST /api/tracks/{trackId}/refresh
```

请求：

```json
{
  "strategyMode": "auto"
}
```

### 播放音频流

```http
GET /api/tracks/{trackId}/stream
```

手机播放器直接播放：

```text
{BASE_URL}/api/tracks/456/stream
```

注意：

- 只在 Track `status=ready` 后播放。
- 支持 `Range` 请求，拖动进度条时播放器可以正常请求分段。
- 返回 `410` 表示临时音频过期，需要重新准备。
- 返回 `409` 表示还没准备好。

## 6. 候选详情和互动

### 获取候选详情

```http
GET /api/candidates/{candidateId}
```

### 记录互动

```http
POST /api/candidates/{candidateId}
```

请求：

```json
{
  "action": "queued"
}
```

支持：

- `viewed`
- `liked`
- `disliked`
- `skipped`
- `queued`
- `extraction_failed`

这些数据用于本账号的排序和推荐，不会写回 Bilibili。

## 7. 推荐/最近候选

### 最近候选

```http
GET /api/candidates
```

### 收藏推荐视图

```http
GET /api/recommendations
```

当前推荐主要基于收藏和本地 metadata，不是 Bilibili 官方推荐。

## 8. 封面代理

```http
GET /api/image-proxy?url={encodedImageUrl}
```

用途：代理 Bilibili 封面，解决移动端图片防盗链/跨域显示问题。

限制：

- 只允许 `i0.hdslb.com`、`i1.hdslb.com`、`i2.hdslb.com`。
- 只允许 `/bfs/` 路径。
- 只返回图片内容。

## 9. 健康检查

### App 健康检查

```http
GET /api/health
```

响应：

```json
{
  "status": "ok",
  "app": "bili-music-app",
  "metadataOnly": true
}
```

### 数据诊断

```http
GET /api/diagnostics
```

这个接口更适合管理端/调试页，不建议普通用户页面高频调用。

重点字段：

- `favoriteCacheMisses`: 收藏存在但候选缓存缺失。
- `favoritesMissingStableBvid`: 收藏缺少稳定 BV，正常应为 0。
- `expiredReadyTracks`: 已 ready 但临时音频已过期。
- `failedTracks`: 准备失败的 Track。

## 10. 手机端推荐流程

### 首次打开

1. 调 `GET /api/health`。
2. 调 `GET /api/kernel/login/status`。
3. 调 `GET /api/favorites`。
4. 调 `GET /api/creators`。

### 搜索并播放

1. 用户输入关键词或视频链接。
2. 调 `POST /api/search`。
3. 用户点播放。
4. 调 `POST /api/tracks/prepare`。
5. 轮询 `GET /api/tracks/{trackId}`。
6. `ready` 后播放 `/api/tracks/{trackId}/stream`。

### 收藏

1. 用户点红心。
2. 调 `POST /api/favorites`。
3. 本地 UI 立即更新。
4. 下次打开从 `GET /api/favorites` 恢复。

## 11. 不要调用的内部接口

手机 App 不要调用这些：

```text
http://kernel:8000/*
http://127.0.0.1:8000/*
/v1/*
```

手机 App 也不要传这些字段：

```text
内部 profile 字段
内部 owner 字段
cookie
storage_state
signed_url
artifact_path
```

这些都属于后端内部实现或敏感数据。
