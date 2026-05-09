# API 调用文档

本文档描述 Web 和未来 Android App 应调用的 App API。客户端不要直接调用 kernel，除非是在本机开发调试。

Base URL：

```text
http://127.0.0.1:3000
```

生产环境替换成你的 HTTPS 域名。

## 身份模型

App 身份建议使用 kernel 登录状态返回的 B 站个人信息：

```text
app_owner_id = bili:<bili_uid>
display_name = nickname
```

注意：

- App 不保存 Bilibili Cookie。
- Cookie、storage state、browser profile 只保存在 kernel。
- 收藏、关注 UP、互动记录按 `app_owner_id` 隔离。
- Android 不需要单独一套 API；先复用这些 JSON API 即可。

## 健康检查

### GET `/api/health`

返回 App 状态。

```json
{
  "status": "ok",
  "app": "bili-music-app"
}
```

### GET `/api/kernel/health`

通过 App 检查 kernel 状态。

## Kernel 登录代理

### POST `/api/kernel/profiles`

创建或绑定 kernel profile。

Request：

```json
{
  "externalOwnerId": "local"
}
```

Response：

```json
{
  "profileId": "p_xxx",
  "externalOwnerId": "local",
  "status": "created"
}
```

### POST `/api/kernel/login/start`

启动 kernel 内部 B 站二维码登录。

Request：

```json
{
  "profileId": "p_xxx",
  "externalOwnerId": "local"
}
```

Response：

```json
{
  "profileId": "p_xxx",
  "loginSessionId": "ls_xxx",
  "status": "pending",
  "message": "..."
}
```

### GET `/api/kernel/login/qr?profileId=p_xxx&externalOwnerId=local`

返回二维码截图图片代理。只返回图片，不返回 QR token 内部字段。

### GET `/api/kernel/login/status?profileId=p_xxx&externalOwnerId=local`

返回脱敏登录状态，并在登录成功时设置 App 自己的非敏感身份 Cookie。

Response：

```json
{
  "profileId": "p_xxx",
  "loggedIn": true,
  "biliUid": "123456",
  "nickname": "昵称",
  "lastVerifiedAt": "2026-05-10T00:00:00.000Z",
  "appOwnerId": "bili:123456"
}
```

## 搜索

### POST `/api/search`

用户主动搜索。只保存 metadata，不下载音视频。

Request：

```json
{
  "keyword": "花之舞",
  "useRemote": true,
  "provider": "bilibili",
  "limit": 20,
  "page": 1,
  "externalOwnerId": "local",
  "profileId": "p_xxx"
}
```

Provider：

- `bilibili`：普通 HTTP metadata 搜索。
- `kernel`：让 kernel 使用指定 profile 的登录态做 metadata 搜索。
- `mock`：测试用，不在产品 UI 里推荐。

Response：

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
      "id": 1,
      "bvid": "BV...",
      "title": "视频标题",
      "creatorMid": "123456",
      "creatorName": "UP 主",
      "coverUrl": "https://i0.hdslb.com/bfs/...",
      "durationSeconds": 240,
      "sourceUrl": "https://www.bilibili.com/video/BV...",
      "isFavorited": false,
      "isPreferredCreator": true,
      "scoreBreakdown": {
        "textMatch": 30,
        "preferredCreator": 70,
        "musicLikelihood": 20,
        "recency": 6,
        "interaction": 0,
        "penalty": 0,
        "final": 126
      }
    }
  ]
}
```

## 候选音源

“候选音源”指 B 站搜索结果 metadata，还不是可播放歌曲。用户点播放后，App 才会创建或复用 `Track` 并让 kernel 准备音频。

### GET `/api/candidates`

返回本地已缓存候选音源。

### GET `/api/candidates/{id}`

返回单个候选音源详情、当前身份下的收藏状态和互动记录。

### POST `/api/candidates/{id}`

记录当前身份下的互动。

Request：

```json
{
  "action": "liked"
}
```

支持：

- `viewed`
- `liked`
- `disliked`
- `skipped`
- `queued`
- `extraction_failed`

## 收藏

这里是 App 自己的收藏，不会同步到 B 站。

### GET `/api/favorites`

返回当前 App 身份下的收藏列表。

### POST `/api/favorites`

Request：

```json
{
  "candidateId": 1,
  "note": "适合循环",
  "mood": "夜晚"
}
```

### DELETE `/api/favorites/{candidateId}`

删除当前 App 身份下的收藏。

## 关注 UP

这里是 App 自己的关注 UP，用于搜索排序和搜索扩展，不会操作 B 站关注。

### GET `/api/creators`

返回当前 App 身份下的关注 UP。

### POST `/api/creators`

Request：

```json
{
  "biliMid": "123456",
  "name": "UP 主昵称",
  "homepageUrl": "https://space.bilibili.com/123456",
  "priorityWeight": 70
}
```

### PATCH `/api/creators/{id}`

更新昵称、主页或权重。

### DELETE `/api/creators/{id}`

删除当前 App 身份下的关注 UP。

## 播放与 Track

### POST `/api/tracks/prepare`

从候选音源创建或复用 Track，并提交 kernel job。

Request：

```json
{
  "candidateId": 1,
  "profileId": "p_xxx",
  "externalOwnerId": "local",
  "strategyMode": "force",
  "strategy": "api_dash"
}
```

Response：

```json
{
  "track": {
    "id": 1,
    "candidateId": 1,
    "bvid": "BV...",
    "title": "视频标题",
    "kernelJobId": "app_track_1_...",
    "artifactName": null,
    "artifactSha256": null,
    "artifactSizeBytes": null,
    "artifactMimeType": null,
    "status": "preparing",
    "failureReason": null,
    "expiresAt": null
  }
}
```

### GET `/api/tracks/{id}`

轮询 Track 状态。Track 可能是：

- `pending`
- `preparing`
- `ready`
- `expired`
- `failed`

如果 kernel job 成功，App 只保存 artifact metadata，不下载音频文件。

### GET `/api/tracks/{id}/stream`

播放代理接口。浏览器或 Android 播放器把它作为音频 URL。

Range 示例：

```http
GET /api/tracks/1/stream
Range: bytes=100000-
```

App 会把 `Range` 转发给 kernel artifact，并透传：

- `Content-Type`
- `Content-Length`
- `Content-Range`
- `Accept-Ranges`
- `ETag`
- `Last-Modified`

客户端应支持 `200`、`206`、`410`、`416`。

### POST `/api/tracks/{id}/refresh`

当 artifact 过期或失败后，重新提交 kernel job。

## 封面图片

### GET `/api/image-proxy?url=...`

只代理 Bilibili `i0.hdslb.com` / `i1.hdslb.com` / `i2.hdslb.com` 下的 `/bfs/` 图片，用于解决浏览器 Referer 导致的封面加载问题。

该接口只流式转发图片，不保存图片，不处理音视频。

## Android 调用建议

Android 第一版不需要单独接口。

推荐流程：

1. 调 `/api/search` 搜索。
2. 展示 `candidates` 里的标题、UP、封面、时长。
3. 点收藏调 `/api/favorites`。
4. 点关注 UP 调 `/api/creators`。
5. 点播放调 `/api/tracks/prepare`。
6. 轮询 `/api/tracks/{id}`。
7. `ready` 后把 `/api/tracks/{id}/stream` 交给 Android 播放器。

以后如果需要移动端版本控制，可以在这些接口稳定后加 `/api/v1/*`，不要过早复制一套 `/api/mobile/*`。

