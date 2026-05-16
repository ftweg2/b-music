# bili-music-app API 使用文档

最后校准日期：2026-05-16

本文档面向手机 App、网页端、桌面端等客户端，描述它们应该调用的 `bili-music-app` 后端 API。

调用方向：

```text
Client -> bili-music-app /api/* -> extraction kernel
```

客户端不要直连 kernel。kernel 是后端内部服务，负责 Bilibili 登录态、提取任务和 artifact；App API 负责对外提供搜索、收藏、关注 UP、播放准备和 stream 代理。

## 1. Base URL

本地开发：

```text
http://127.0.0.1:3000
```

部署后：

```text
https://music.example.com
```

下文统一用 `{BASE_URL}` 表示 App 后端地址。

## 2. 通用约定

### 请求

- JSON 接口统一使用 `Content-Type: application/json`。
- 客户端只调用 `/api/*`。
- 客户端不需要知道 kernel 地址。
- 客户端不需要传内部 `profile_id`、`external_owner_id`、Cookie、storage state 或 artifact path。
- 当前 MVP 默认是单用户模式。后端通过 `APP_OWNER_ID`、`KERNEL_EXTERNAL_OWNER_ID` 或登录态 cookie 决定 owner。

### 响应

成功时返回 JSON，除音频流和图片代理外：

```json
{
  "example": "value"
}
```

失败时通常返回：

```json
{
  "error": "sanitized error message"
}
```

常见状态码：

| 状态码 | 含义 |
| --- | --- |
| `200` | 成功 |
| `201` | 创建成功 |
| `400` | 请求参数错误或后端处理失败 |
| `404` | 资源不存在 |
| `409` | 资源还没准备好，例如 track 尚不可播放 |
| `410` | 临时 artifact 已过期，需要重新准备 |
| `502` | App 调 kernel 或上游服务失败 |

### 安全边界

App API 不会返回：

- Bilibili Cookie
- localStorage / sessionStorage / Playwright storage state
- browser profile 文件或路径
- QR token 内部字段
- 签名媒体 URL
- kernel artifact 本地路径
- 音频或视频文件落盘路径

App 存储 metadata，包括候选视频、收藏、关注 UP、track 状态和 artifact 元信息。音频 artifact 留在 kernel，由 App 的 stream 接口代理。

## 3. 接口总览

| 模块 | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| Health | `GET` | `/api/health` | App 健康检查 |
| Health | `GET` | `/api/kernel/health` | kernel 健康检查代理 |
| Login | `GET` | `/api/kernel/login/status` | 查询 Bilibili 登录状态 |
| Login | `POST` | `/api/kernel/login/start` | 发起 kernel QR 登录 |
| Login | `GET` | `/api/kernel/login/qr` | 获取 QR 图片代理 |
| Search | `POST` | `/api/search` | 搜索关键词、BV ID 或视频链接 |
| Candidates | `GET` | `/api/candidates` | 最近候选列表 |
| Candidates | `GET` | `/api/candidates/{id}` | 候选详情 |
| Candidates | `POST` | `/api/candidates/{id}` | 记录候选互动 |
| Favorites | `GET` | `/api/favorites` | 收藏列表 |
| Favorites | `POST` | `/api/favorites` | 添加收藏 |
| Favorites | `DELETE` | `/api/favorites/{candidateId}` | 取消收藏 |
| Creators | `GET` | `/api/creators` | 关注 UP 列表 |
| Creators | `POST` | `/api/creators` | 添加关注 UP |
| Creators | `PATCH` | `/api/creators/{id}` | 修改关注 UP |
| Creators | `DELETE` | `/api/creators/{id}` | 删除关注 UP |
| Tracks | `POST` | `/api/tracks/prepare` | 准备播放 |
| Tracks | `GET` | `/api/tracks/{id}` | 查询播放准备状态 |
| Tracks | `POST` | `/api/tracks/{id}/refresh` | 强制重新准备 |
| Tracks | `GET` | `/api/tracks/{id}/stream` | 音频流 |
| Recommendations | `GET` | `/api/recommendations` | 收藏视图/推荐视图 |
| Image | `GET` | `/api/image-proxy` | Bilibili 封面图片代理 |
| Diagnostics | `GET` | `/api/diagnostics` | 数据健康诊断 |

## 4. 数据对象

### CandidateWithScore

搜索、收藏、候选列表等接口返回的候选对象大致如下：

```json
{
  "id": 123,
  "bvid": "BV1xx411c7mD",
  "aid": "123456",
  "title": "歌曲标题",
  "description": "简介",
  "creatorMid": "10086",
  "creatorName": "UP 主",
  "coverUrl": "https://i0.hdslb.com/bfs/archive/example.jpg",
  "durationSeconds": 260,
  "pubTime": "2026-05-13T12:00:00.000Z",
  "sourceUrl": "https://www.bilibili.com/video/BV1xx411c7mD",
  "category": "音乐",
  "tagsJson": "[\"music\"]",
  "searchKeyword": "keyword",
  "sourceProvider": "bilibili",
  "musicLikelihoodScore": 30,
  "preferredCreatorBoost": 0,
  "finalScore": 80,
  "scoreBreakdownJson": "{}",
  "lastSeenAt": "2026-05-13T12:00:00.000Z",
  "createdAt": "2026-05-13T12:00:00.000Z",
  "updatedAt": "2026-05-13T12:00:00.000Z",
  "scoreBreakdown": {
    "textMatch": 20,
    "preferredCreator": 0,
    "musicLikelihood": 30,
    "recency": 5,
    "interaction": 0,
    "penalty": 0,
    "final": 55
  },
  "tags": ["music"],
  "isPreferredCreator": false,
  "isFavorited": true
}
```

客户端常用字段：

- `id`: App 内部候选 ID。播放、收藏、互动优先传它。
- `bvid`: Bilibili BV ID。收藏和播放也建议同时传它，用于缓存恢复。
- `title`, `creatorName`, `coverUrl`, `durationSeconds`: UI 展示字段。
- `sourceUrl`: Bilibili 视频页面 URL，不是音频 URL。
- `isFavorited`: 当前 owner 是否收藏。

### FavoriteVideo

```json
{
  "id": 1,
  "externalOwnerId": "local",
  "candidateId": 123,
  "bvid": "BV1xx411c7mD",
  "note": null,
  "mood": null,
  "titleSnapshot": "歌曲标题",
  "sourceUrlSnapshot": "https://www.bilibili.com/video/BV1xx411c7mD",
  "creatorMidSnapshot": "10086",
  "creatorNameSnapshot": "UP 主",
  "coverUrlSnapshot": "https://i0.hdslb.com/bfs/archive/example.jpg",
  "durationSecondsSnapshot": 260,
  "pubTimeSnapshot": "2026-05-13T12:00:00.000Z",
  "categorySnapshot": "音乐",
  "tagsJsonSnapshot": "[]",
  "snapshotQuality": "complete",
  "lastHydratedAt": "2026-05-13T12:00:00.000Z",
  "createdAt": "2026-05-13T12:00:00.000Z",
  "updatedAt": "2026-05-13T12:00:00.000Z"
}
```

注意：`GET /api/favorites` 推荐客户端优先读取 `items[].candidate`，不要自己猜 `favorites` 和 `candidates` 的配对关系。

### PreferredCreator

```json
{
  "id": 1,
  "externalOwnerId": "local",
  "biliMid": "10086",
  "name": "UP 主",
  "homepageUrl": "https://space.bilibili.com/10086",
  "priorityWeight": 70,
  "notes": null,
  "createdAt": "2026-05-13T12:00:00.000Z",
  "updatedAt": "2026-05-13T12:00:00.000Z"
}
```

### Track

```json
{
  "id": 456,
  "candidateId": 123,
  "bvid": "BV1xx411c7mD",
  "title": "歌曲标题",
  "sourceUrl": "https://www.bilibili.com/video/BV1xx411c7mD",
  "kernelJobId": "app_track_456_...",
  "artifactName": "audio.m4a",
  "artifactSha256": "abc123...",
  "artifactSizeBytes": 1234567,
  "artifactMimeType": "audio/mp4",
  "durationSeconds": 260,
  "status": "ready",
  "failureReason": null,
  "expiresAt": "2026-05-14T12:00:00.000Z",
  "createdAt": "2026-05-13T12:00:00.000Z",
  "updatedAt": "2026-05-13T12:00:00.000Z"
}
```

Track 状态：

| 状态 | 含义 |
| --- | --- |
| `pending` | 已创建，还未提交或准备 |
| `preparing` | kernel job 正在运行 |
| `ready` | 可播放 |
| `expired` | artifact 已过期，需要重新准备 |
| `failed` | 准备失败，查看 `failureReason` |

## 5. Health

### GET `/api/health`

检查 App 后端、SQLite 初始化和过期 track 标记。

```bash
curl "{BASE_URL}/api/health"
```

响应：

```json
{
  "status": "ok",
  "app": "bili-music-app",
  "provider": "bilibili",
  "metadataOnly": true,
  "expiredTracksMarked": 0
}
```

### GET `/api/kernel/health`

检查 App 能否访问 kernel。

```bash
curl "{BASE_URL}/api/kernel/health"
```

成功响应：

```json
{
  "status": "ok"
}
```

失败响应通常是 `502`：

```json
{
  "error": "kernel health request failed"
}
```

## 6. 登录

登录接口用于让用户在 kernel-owned profile 中完成 Bilibili QR 登录。App 只返回二维码截图 URL 和 sanitized 登录状态，不返回 Cookie 或 profile 文件。

### GET `/api/kernel/login/status`

查询当前默认 kernel profile 的登录状态。

```bash
curl "{BASE_URL}/api/kernel/login/status"
```

响应：

```json
{
  "profileId": "p_xxx",
  "externalOwnerId": "local",
  "loggedIn": true,
  "biliUid": "123456",
  "nickname": "Bilibili 用户",
  "lastVerifiedAt": "2026-05-13T12:00:00.000Z",
  "appOwnerId": "bili:123456"
}
```

客户端建议：

- `loggedIn=false`: 显示“扫码登录”。
- `loggedIn=true`: 显示昵称和已登录状态。
- 登录成功后后端会设置 App owner cookies。移动端如果使用 cookie jar，请保留后端返回的 cookie。

### POST `/api/kernel/login/start`

发起 QR 登录。

```bash
curl -X POST "{BASE_URL}/api/kernel/login/start"
```

响应：

```json
{
  "loginSessionId": "ls_xxx",
  "status": "pending",
  "message": "Scan the QR image...",
  "qrImageUrl": "/api/kernel/login/qr?profileId=p_xxx&loginSessionId=ls_xxx&externalOwnerId=local",
  "qrImageSha256": "abc123...",
  "expiresInSeconds": 180
}
```

移动端流程：

1. 调 `POST /api/kernel/login/start`。
2. 用 `{BASE_URL} + qrImageUrl` 显示二维码图片。
3. 每 2-3 秒轮询 `GET /api/kernel/login/status`。
4. `loggedIn=true` 后停止轮询。

### GET `/api/kernel/login/qr`

二维码图片代理。客户端不要手动拼参数，直接使用 `login/start` 返回的 `qrImageUrl`。

响应是 `image/png`，并带 `cache-control: no-store`。

## 7. 搜索

### POST `/api/search`

搜索歌曲、UP、BV ID 或 Bilibili 视频链接。

请求：

```json
{
  "keyword": "周杰伦 七里香",
  "useRemote": true,
  "provider": "bilibili",
  "limit": 20,
  "page": 1
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | string | 是 | 关键词、BV ID 或 Bilibili 视频链接 |
| `useRemote` | boolean | 否 | 是否调用远程 provider。`false` 只查本地缓存、收藏和直达 BV |
| `provider` | string | 否 | `bilibili`、`kernel`、`mock`。生产建议 `bilibili`；登录态搜索用 `kernel` |
| `limit` | number | 否 | 1-50，默认 20 |
| `page` | number | 否 | 1-10，默认 1 |

示例：

```bash
curl -X POST "{BASE_URL}/api/search" \
  -H "content-type: application/json" \
  -d '{
    "keyword": "周杰伦 七里香",
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
      "title": "周杰伦 七里香",
      "creatorName": "UP 主",
      "creatorMid": "10086",
      "coverUrl": "https://i0.hdslb.com/bfs/archive/example.jpg",
      "durationSeconds": 260,
      "sourceUrl": "https://www.bilibili.com/video/BV1xx411c7mD",
      "isFavorited": false,
      "tags": [],
      "scoreBreakdown": {
        "textMatch": 20,
        "preferredCreator": 0,
        "musicLikelihood": 30,
        "recency": 5,
        "interaction": 0,
        "penalty": 0,
        "final": 55
      }
    }
  ]
}
```

如果远程 provider 失败，接口可能仍返回本地候选，并带 `providerError`：

```json
{
  "provider": "bilibili",
  "remoteUsed": true,
  "page": 1,
  "limit": 20,
  "hasPreviousPage": false,
  "hasNextPage": false,
  "candidates": [],
  "providerError": "Bilibili search failed"
}
```

客户端建议：

- 搜索结果卡片用 `candidate.id` 作为主键。
- 收藏和播放时同时传 `candidateId` 与 `bvid`。
- `sourceUrl` 只是 Bilibili 页面 URL，不能当作音频 URL 播放。
- 不要做无限滚动爬取；分页必须是显式用户行为。

## 8. 候选视频

### GET `/api/candidates`

获取最近候选缓存，最多 100 条。

```bash
curl "{BASE_URL}/api/candidates"
```

响应：

```json
{
  "ownerId": "local",
  "candidates": []
}
```

### GET `/api/candidates/{candidateId}`

获取候选详情和当前 owner 的互动记录。

```bash
curl "{BASE_URL}/api/candidates/123"
```

响应：

```json
{
  "ownerId": "local",
  "candidate": {
    "id": 123,
    "bvid": "BV1xx411c7mD",
    "title": "歌曲标题",
    "isFavorited": true
  },
  "interactions": [
    {
      "id": 1,
      "externalOwnerId": "local",
      "candidateId": 123,
      "action": "viewed",
      "createdAt": "2026-05-13T12:00:00.000Z"
    }
  ]
}
```

不存在时返回 `404`。

### POST `/api/candidates/{candidateId}`

记录用户互动，用于排序和推荐，不会写回 Bilibili。

请求：

```json
{
  "action": "queued"
}
```

支持的 `action`：

- `viewed`
- `liked`
- `disliked`
- `skipped`
- `queued`
- `extraction_failed`

响应状态 `201`：

```json
{
  "interaction": {
    "id": 1,
    "externalOwnerId": "local",
    "candidateId": 123,
    "action": "queued",
    "createdAt": "2026-05-13T12:00:00.000Z"
  }
}
```

## 9. 收藏

收藏是 App 自己的本地音乐库，不会同步到 Bilibili 收藏。

### GET `/api/favorites`

获取收藏列表，最多 100 条。

```bash
curl "{BASE_URL}/api/favorites"
```

响应：

```json
{
  "ownerId": "local",
  "items": [
    {
      "favorite": {
        "id": 1,
        "candidateId": 123,
        "bvid": "BV1xx411c7mD",
        "titleSnapshot": "歌曲标题",
        "snapshotQuality": "complete"
      },
      "candidate": {
        "id": 123,
        "bvid": "BV1xx411c7mD",
        "title": "歌曲标题",
        "creatorName": "UP 主",
        "isFavorited": true
      }
    }
  ],
  "favorites": [],
  "candidates": []
}
```

重要：

- 移动端优先使用 `items`。
- 每个 `items[n].favorite.candidateId` 都会与 `items[n].candidate.id` 对齐。
- `favorites` 和 `candidates` 是兼容旧客户端的并列数组，新客户端不要依赖自己配对。
- 如果旧收藏缺少候选缓存，后端会用收藏快照自动恢复 candidate。

### POST `/api/favorites`

添加收藏。

请求：

```json
{
  "candidateId": 123,
  "bvid": "BV1xx411c7mD",
  "note": "可选备注",
  "mood": "可选心情"
}
```

示例：

```bash
curl -X POST "{BASE_URL}/api/favorites" \
  -H "content-type: application/json" \
  -d '{"candidateId":123,"bvid":"BV1xx411c7mD"}'
```

响应状态 `201`：

```json
{
  "favorite": {
    "id": 1,
    "candidateId": 123,
    "bvid": "BV1xx411c7mD"
  },
  "candidate": {
    "id": 123,
    "bvid": "BV1xx411c7mD",
    "title": "歌曲标题",
    "isFavorited": true
  },
  "item": {
    "favorite": {
      "id": 1,
      "candidateId": 123,
      "bvid": "BV1xx411c7mD"
    },
    "candidate": {
      "id": 123,
      "bvid": "BV1xx411c7mD",
      "title": "歌曲标题",
      "isFavorited": true
    }
  }
}
```

客户端建议：

- 同时传 `candidateId` 和 `bvid`。
- 成功后 UI 可立即把红心置为已收藏。
- `note` 最大约 500 字符，`mood` 最大约 80 字符。

### DELETE `/api/favorites/{candidateId}`

取消收藏。

```bash
curl -X DELETE "{BASE_URL}/api/favorites/123"
```

响应：

```json
{
  "deleted": true
}
```

注意：当前删除接口按 `candidateId` 删除。如果客户端只有 `bvid`，先从收藏列表里的 `item.candidate.id` 取 `candidateId`。

## 10. 关注 UP

关注 UP 是 App 本地排序偏好，不会写回 Bilibili。

### GET `/api/creators`

获取关注 UP 列表。

```bash
curl "{BASE_URL}/api/creators"
```

响应：

```json
{
  "ownerId": "local",
  "creators": [
    {
      "id": 1,
      "externalOwnerId": "local",
      "biliMid": "10086",
      "name": "UP 主",
      "homepageUrl": "https://space.bilibili.com/10086",
      "priorityWeight": 70,
      "notes": null,
      "createdAt": "2026-05-13T12:00:00.000Z",
      "updatedAt": "2026-05-13T12:00:00.000Z"
    }
  ]
}
```

### POST `/api/creators`

添加关注 UP。

请求：

```json
{
  "biliMid": "10086",
  "name": "UP 主",
  "homepageUrl": "https://space.bilibili.com/10086",
  "priorityWeight": 70,
  "notes": "可选备注"
}
```

字段说明：

- `biliMid`: 推荐传。也可以从 `homepageUrl` 或 `name` 中提取数字 mid。
- `name`: 可选。缺失时后端会尝试查询 Bilibili 公开 profile。
- `homepageUrl`: 可选。缺失时按 mid 生成 `https://space.bilibili.com/{mid}`。
- `priorityWeight`: 0-100，默认 50。
- `notes`: 可选备注，最大约 500 字符。

响应状态 `201`：

```json
{
  "creator": {
    "id": 1,
    "biliMid": "10086",
    "name": "UP 主",
    "priorityWeight": 70
  }
}
```

### PATCH `/api/creators/{id}`

修改关注 UP。

请求：

```json
{
  "name": "新名称",
  "homepageUrl": "https://space.bilibili.com/10086",
  "priorityWeight": 80,
  "notes": "备注"
}
```

响应：

```json
{
  "creator": {
    "id": 1,
    "name": "新名称",
    "priorityWeight": 80
  }
}
```

不存在时返回 `404`。

### DELETE `/api/creators/{id}`

删除关注 UP。

```bash
curl -X DELETE "{BASE_URL}/api/creators/1"
```

响应：

```json
{
  "deleted": true
}
```

不存在时返回 `404`。

## 11. 播放

播放分三步：

1. `POST /api/tracks/prepare`
2. 轮询 `GET /api/tracks/{trackId}`
3. `ready` 后播放 `/api/tracks/{trackId}/stream`

### POST `/api/tracks/prepare`

准备候选视频的音频播放。后端会创建或复用 Track，并通过 kernel 提交提取 job。

请求：

```json
{
  "candidateId": 123,
  "bvid": "BV1xx411c7mD",
  "strategyMode": "auto",
  "strategyOrder": ["api_dash", "browser_network", "mse_sourcebuffer"]
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `candidateId` | number | 推荐 | App 候选 ID |
| `bvid` | string | 推荐 | BV ID，用于缓存恢复 |
| `strategyMode` / `strategy_mode` | string | 否 | `auto` 或 `force`，默认 `auto` |
| `strategy` | string | force 时必填 | `api_dash`、`browser_network`、`mse_sourcebuffer` |
| `strategyOrder` / `strategy_order` | string[] | 否 | auto 模式策略顺序 |

示例：

```bash
curl -X POST "{BASE_URL}/api/tracks/prepare" \
  -H "content-type: application/json" \
  -d '{"candidateId":123,"bvid":"BV1xx411c7mD","strategyMode":"auto"}'
```

响应：

```json
{
  "track": {
    "id": 456,
    "candidateId": 123,
    "bvid": "BV1xx411c7mD",
    "title": "歌曲标题",
    "status": "preparing",
    "failureReason": null
  }
}
```

如果已有可用 artifact，可能直接返回 `status=ready`。

### GET `/api/tracks/{trackId}`

查询 Track 状态，并同步 kernel job 结果。

```bash
curl "{BASE_URL}/api/tracks/456"
```

响应：

```json
{
  "track": {
    "id": 456,
    "status": "ready",
    "artifactName": "audio.m4a",
    "artifactSha256": "abc123...",
    "artifactSizeBytes": 1234567,
    "artifactMimeType": "audio/mp4",
    "failureReason": null
  }
}
```

轮询建议：

- `preparing`: 每 1.5-3 秒轮询一次。
- `ready`: 停止轮询，开始播放 stream。
- `failed`: 显示 `failureReason`，可提供重试。
- `expired`: 调 `POST /api/tracks/{trackId}/refresh` 或重新 `prepare`。

### POST `/api/tracks/{trackId}/refresh`

强制重新准备 Track。

请求：

```json
{
  "strategyMode": "auto",
  "strategyOrder": ["api_dash", "browser_network"]
}
```

响应：

```json
{
  "track": {
    "id": 456,
    "status": "preparing"
  }
}
```

### GET `/api/tracks/{trackId}/stream`

音频流接口。播放器直接使用这个 URL：

```text
{BASE_URL}/api/tracks/456/stream
```

行为：

- Track 不存在：`404`
- Track 未 ready：`409`
- Track artifact 过期：`410`
- kernel artifact 丢失：`410`，并把 Track 标记为 `expired`
- 成功时返回音频流，透传常用 headers：`content-type`、`content-length`、`content-range`、`accept-ranges`、`etag`、`last-modified`

支持 Range：

```http
Range: bytes=0-
```

移动端建议：

- 原生播放器 URL 设为 `/api/tracks/{id}/stream`。
- 不要下载完整音频文件到 App storage。
- 收到 `410` 后重新 prepare。
- 收到 `409` 后继续轮询 Track 状态。

## 12. 推荐/收藏视图

### GET `/api/recommendations`

当前推荐视图主要是收藏视图，不触发远程爬取。

```bash
curl "{BASE_URL}/api/recommendations"
```

响应：

```json
{
  "mode": "favorites",
  "ownerId": "local",
  "candidates": [],
  "emptyState": "收藏夹还空着。搜索结果里点“收藏”就会加入这里。"
}
```

客户端可以把它作为“收藏/推荐”页的备用接口。新移动端更推荐直接使用 `/api/favorites`，因为它包含 `items`。

## 13. 封面图片代理

### GET `/api/image-proxy?url={encodedImageUrl}`

代理 Bilibili 封面图，解决 Referer 或跨域显示问题。

示例：

```text
{BASE_URL}/api/image-proxy?url=https%3A%2F%2Fi0.hdslb.com%2Fbfs%2Farchive%2Fexample.jpg
```

限制：

- 只允许 `i0.hdslb.com`、`i1.hdslb.com`、`i2.hdslb.com`
- 只允许 `/bfs/` 路径
- 上游必须返回 `image/*`
- 成功响应是图片流，不是 JSON

客户端建议：

- 搜索结果里的 `coverUrl` 可以直接展示；如果平台遇到防盗链或跨域问题，用 image-proxy 包一层。
- 不要把 image-proxy 用作通用任意 URL 代理。

## 14. Diagnostics

### GET `/api/diagnostics`

数据健康诊断，适合管理端或调试页面，不建议普通用户页面高频调用。

```bash
curl "{BASE_URL}/api/diagnostics"
```

响应：

```json
{
  "status": "ok",
  "expiredTracksMarked": 0,
  "counts": {
    "candidates": 100,
    "favorites": 5,
    "tracks": 2,
    "interactions": 20
  },
  "dataHealth": {
    "favoriteCacheMisses": 0,
    "favoritesMissingStableBvid": 0,
    "weakCandidates": 0,
    "expiredReadyTracks": 0,
    "failedTracks": 0
  }
}
```

重点字段：

- `favoriteCacheMisses`: 收藏存在但候选缓存缺失。正常读取 `/api/favorites` 后会尝试自动修复。
- `favoritesMissingStableBvid`: 收藏缺少稳定 BV，正常应为 0。
- `weakCandidates`: 候选基础字段不完整。
- `expiredReadyTracks`: 已 ready 但 artifact 过期。
- `failedTracks`: 准备失败的 Track 数量。

## 15. 手机端推荐流程

### 首次打开

1. `GET /api/health`
2. `GET /api/kernel/login/status`
3. `GET /api/favorites`
4. `GET /api/creators`

### 搜索并播放

1. 用户输入关键词、BV ID 或 Bilibili 链接。
2. `POST /api/search`
3. 用户点击播放候选。
4. `POST /api/tracks/prepare`
5. 轮询 `GET /api/tracks/{trackId}`
6. `status=ready` 后播放 `{BASE_URL}/api/tracks/{trackId}/stream`

### 收藏

1. 用户点击红心。
2. `POST /api/favorites`，传 `candidateId` 和 `bvid`。
3. 本地 UI 立即置为已收藏。
4. 下次打开用 `GET /api/favorites` 恢复。
5. 客户端优先渲染 `items[].candidate`。

### 取消收藏

1. 从 `items[].candidate.id` 取得 `candidateId`。
2. `DELETE /api/favorites/{candidateId}`。
3. 成功后本地 UI 移除或置为未收藏。

### 登录态搜索

1. `GET /api/kernel/login/status`
2. 未登录时走 QR 登录。
3. 搜索时使用：

```json
{
  "keyword": "关键词",
  "useRemote": true,
  "provider": "kernel"
}
```

注意：`provider=kernel` 仍然是调用 App API，不是让手机直连 kernel。

## 16. 不要调用的接口和不要传的字段

客户端不要直接调用：

```text
http://127.0.0.1:8000/*
http://kernel:8000/*
/v1/*
```

客户端不要传或存：

```text
cookie
Cookie
authorization
storage_state
localStorage
sessionStorage
profile_id
external_owner_id
signed_url
artifact_path
kernel local path
```

客户端不要做：

- Cookie 导入、导出或展示
- browser profile 文件读取
- 签名媒体 URL 抓取
- 音频/视频文件持久化缓存
- 批量爬取、无限翻页或账号池
- CAPTCHA、DRM/EME、会员/区域/access-control 绕过

## 17. 环境变量参考

这些是后端部署时使用的变量，客户端不需要传：

```bash
NEXT_PUBLIC_APP_NAME=bili-music-app
SEARCH_PROVIDER=bilibili
BILIBILI_SEARCH_TIMEOUT_MS=8000
BILIBILI_SEARCH_LIMIT=20
KERNEL_BASE_URL=http://localhost:8000
KERNEL_EXTERNAL_OWNER_ID=local
KERNEL_PROFILE_ID=
TRACK_ARTIFACT_TTL_SECONDS=86400
DATABASE_PATH=./data/bili-music-app.sqlite
APP_SINGLE_USER_MODE=1
APP_OWNER_ID=local
```

说明：

- `SEARCH_PROVIDER`: 默认搜索 provider，可为 `bilibili`、`kernel`、`mock`。
- `KERNEL_BASE_URL`: App 后端访问 kernel 的内部地址。
- `KERNEL_EXTERNAL_OWNER_ID`: App 与 kernel profile 映射的 owner。
- `TRACK_ARTIFACT_TTL_SECONDS`: Track artifact 可播放窗口。
- `APP_SINGLE_USER_MODE`: 默认单用户模式；设为 `0` 时使用 owner cookie。

## 18. 客户端最小实现清单

必须实现：

- `GET /api/health`
- `POST /api/search`
- `GET /api/favorites`
- `POST /api/favorites`
- `DELETE /api/favorites/{candidateId}`
- `POST /api/tracks/prepare`
- `GET /api/tracks/{trackId}`
- 播放 `/api/tracks/{trackId}/stream`

推荐实现：

- `GET /api/kernel/login/status`
- `POST /api/kernel/login/start`
- `GET /api/creators`
- `POST /api/creators`
- `POST /api/candidates/{candidateId}` 记录互动

调试/管理端实现：

- `GET /api/kernel/health`
- `GET /api/diagnostics`
