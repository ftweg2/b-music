# B-Music API 调用文档

版本：v1 · revision 1.2.0 · 校准日期：2026-09-05

这是手机、网页和桌面客户端的统一调用指南。请求/响应的完整字段及类型由 [OpenAPI 3.1](http://127.0.0.1:3000/api/openapi.json) 提供；部署后改用自己的 Base URL 请求 `GET /api/openapi.json`。歌单、分页、账号的补充文档只解释产品行为，不再维护另一套接口参数表。

## 1. 连接与接入顺序

客户端只调用 App 的 `/api/*`，不直连内核的 8000 端口或 `/v1/*`。

- 在运行服务的电脑上，开发地址为 `http://127.0.0.1:3000`。
- 手机上 `127.0.0.1` 指向手机自身。使用电脑实际可访问的部署地址；当前服务默认仅监听本机，不会自动开放网络端口。
- 默认是受信任的本地单用户服务，不是带多租户鉴权的公网服务。跨不可信网络必须使用带鉴权的 HTTPS 网关。网关要求的 Authorization 按其契约发送，不能拿 Bilibili Cookie 代替。
- 默认按内核已验证的 Bilibili 账号区分收藏、关注、歌单、曲目和播放区间；同一服务、同一账号的网页与手机 API 共用数据。换号切换分区，切回后恢复，不删除原账号数据。
- 当前服务同一时刻使用一个 Bilibili 登录，不是每台客户端各自独立登录的多用户认证服务。客户端读取服务返回的 appOwnerId/sessionKey，不用 Cookie 或请求体自报 UID 选择分区。
- 原来的本地音乐库在首次确认登录账号时一次性归入该账号，保持记录 ID 和内核引用；冲突记录保留在旧分区，不转送给其他账号。未登录使用独立的 guest 分区。部署者可显式设置 APP_LIBRARY_MODE=local 保留旧本地库模式。
- 服务返回的 `streamUrl`、`downloadUrl`、`qrImageUrl` 均相对 Base URL 解析，不自行拼内部 profile、owner、job 或 artifact 参数。

首次打开依次读取健康、能力、登录状态，再按页面需要读取收藏、歌单、关注和曲目任务。需要播放时才准备音频，不因为打开歌单而批量提取。

以下 curl 示例采用 Bash 语法；Windows PowerShell 可使用 `Invoke-RestMethod`。示例 ID、BV 和快照标识仅说明格式，实际必须使用接口返回值。

```bash
BASE_URL=http://127.0.0.1:3000
curl "$BASE_URL/api/health"
curl "$BASE_URL/api/capabilities"
curl "$BASE_URL/api/kernel/login/status"
```

## 2. 请求、错误与重试

JSON 请求发送 `Content-Type: application/json`，请求体必须是对象且不超过 64 KiB。使用正整数 ID、数字分页参数、真正的布尔值；新客户端统一使用 camelCase 字段。

响应头包括 `X-API-Version: 1`、`X-API-Revision: 1.2.0` 和 `X-Request-Id`。客户端可发送自己的 `X-Request-Id`：1–64 位字母、数字、下划线或连字符。

读登录状态后，业务请求携带 `X-Account-Context: 返回的sessionKey`，防止旧页面在换号后误写。响应还可带 `X-Account-Id` 和 `X-Account-Context`。收到 `409 / ACCOUNT_CHANGED` 时停止当前操作，重新读取账号并清理当前展示/播放状态；不要自动把旧操作提交到新账号。这些字段是上下文校验，不是公网鉴权令牌。

业务错误的完整基础结构：

```json
{
  "error": "请从第一页重新搜索",
  "code": "SEARCH_SESSION_CHANGED",
  "retryable": false,
  "requestId": "phone-request-001"
}
```

错误还可能含 `details`、`provider`、`page`、`searchId` 等上下文。HEAD 没有响应体，可查看状态码、`X-Error-Code` 和 `Retry-After`。未知路径、网关错误和框架自动生成的 405 可能不是 JSON；先判断 Content-Type 再解析。

| 状态 | 客户端处理 |
| --- | --- |
| 200 / 201 | 请求成功；播放准备仍必须读取 `track.status` |
| 400 | 修改参数，不盲目重试 |
| 403 | 来源或权限不允许 |
| 404 | 资源不存在；重复删除时通常视为已不存在 |
| 409 | 按 `code` 区分快照失效、歌单冲突、音频未就绪或登录资料忙碌 |
| 410 | 临时音频过期，用户确认后重新准备 |
| 413 / 415 | 请求过大或内容类型不支持 |
| 416 | Range 越界，核对 `Content-Range` 和完整文件大小 |
| 429 | 限流；有 `Retry-After` 时按秒等待 |
| 500 / 502 / 503 / 504 | 服务或上游失败，结合 `retryable` 有界退避 |

对 `retryable=true` 的瞬时错误有限重试，建议最多三次；每次采用最新的 Retry-After，没有该头时使用退避并允许用户取消。等待一次后仍可能限流，不连续快速请求。搜索错误保留最后成功的页面，不能静默换成另一个来源。

### 防止重复创建

`POST /api/playlists` 和 `POST /api/candidates/{id}` 支持 `Idempotency-Key`：

- 8–128 位，首位是字母或数字，其余允许字母、数字和 `._:-`。
- 同一次操作的网络重试、并发重发使用同一个 key，24 小时内复用原结果。
- 不同内容不能复用同一个 key，否则返回 `409 / IDEMPOTENCY_CONFLICT`。
- 新操作用新 key；不发送 key 时，这两个接口没有此重试保护。
- 收藏按 owner/BV、关注按 owner/MID、歌单条目按歌单/BV 自然去重，不依赖这个头。

### 原生客户端与 WebView

原生 HTTP 客户端无需发送 Origin。浏览器同源访问正常支持；WebView 来源需由部署方显式配置，例如 `APP_ALLOWED_ORIGINS=capacitor://localhost`，公开 HTTPS 网页也配置实际来源。接口提供 OPTIONS，暴露媒体、版本、追踪和重试响应头。

CORS 只解决浏览器来源限制，不提供用户鉴权。默认单用户客户端不依赖网页 localStorage、sessionStorage 或 App owner cookie 完成调用；不要上传或保存 Bilibili 登录凭据。

## 3. 全部接口

业务契约共 29 条路径、40 个方法操作。另有文档入口 `GET /api/openapi.json` 和各路径的 OPTIONS。

### 服务与登录

| 方法 | 路径 | 成功响应/用途 |
| --- | --- | --- |
| GET | `/api/health` | App 健康、版本与元数据服务状态 |
| GET | `/api/capabilities` | `features`、`limits`、`defaults`、`endpoints` |
| GET | `/api/kernel/health` | App 到内核的健康检查 |
| GET | `/api/diagnostics` | `counts`、`dataHealth`；调试使用，不高频调用 |
| GET | `/api/kernel/login/status` | 当前登录状态与搜索上下文 |
| POST | `/api/kernel/login/start` | 创建或复用待扫码会话；无请求体 |
| GET | `/api/kernel/login/qr` | 二维码图片；直接访问返回的 `qrImageUrl` |
| POST | `/api/kernel/login/logout` | `{"confirmed":true}`，成功返回 `loggedIn:false` 和 `message` |

### 搜索、曲目元数据、收藏与关注

| 方法 | 路径 | 成功响应/用途 |
| --- | --- | --- |
| POST | `/api/search` | 搜索结果、固定快照与分页信息 |
| GET | `/api/candidates` | `candidates`、`pagination` |
| GET | `/api/candidates/{id}` | `candidate`、`interactions` |
| POST | `/api/candidates/{id}` | 201，`interaction`；可使用幂等 key |
| GET | `/api/favorites` | `items`、`favorites`、`candidates`、`pagination` |
| POST | `/api/favorites` | 201，`favorite`、`candidate`、`item` |
| DELETE | `/api/favorites/{candidateId}` | `deleted`；重复取消返回 200、`deleted:false` |
| GET | `/api/creators` | `creators` |
| POST | `/api/creators` | 201，`creator` |
| PATCH | `/api/creators/{id}` | `creator` |
| DELETE | `/api/creators/{id}` | `deleted:true`；不存在为 404 |
| GET | `/api/recommendations` | 仍有效的兼容接口：`mode:"favorites"`、`candidates`，无评分/推荐算法；新客户端使用收藏接口 |

### 歌单

| 方法 | 路径 | 成功响应/用途 |
| --- | --- | --- |
| GET | `/api/playlists` | `playlists` |
| POST | `/api/playlists` | 201，`playlist`；可使用幂等 key |
| GET | `/api/playlists/{id}` | `playlist`，包含有序 `items` |
| PATCH | `/api/playlists/{id}` | 更新后的 `playlist` 摘要 |
| DELETE | `/api/playlists/{id}` | `deleted:true`；不存在为 404 |
| POST | `/api/playlists/{id}/items` | `added`、`playlist`；重复条目 `added:false` |
| PATCH | `/api/playlists/{id}/items` | `reordered:true` |
| DELETE | `/api/playlists/{id}/items/{itemId}` | `removed:true`；不存在为 404 |

### 播放、下载与图片

| 方法 | 路径 | 成功响应/用途 |
| --- | --- | --- |
| POST | `/api/tracks/prepare` | `track`、`pollAfterMs` |
| GET | `/api/tracks` | `tracks`、`pagination` |
| GET | `/api/tracks/{id}` | `track`、`pollAfterMs` |
| POST | `/api/tracks/status` | `tracks`、`missingTrackIds`、`pollAfterMs` |
| POST | `/api/tracks/{id}/refresh` | `track`、`pollAfterMs` |
| GET | `/api/playback-ranges/{bvid}` | 当前账号的 `playbackRange` |
| PATCH | `/api/playback-ranges/{bvid}` | 保存或重置，返回最新 `playbackRange` |
| GET | `/api/tracks/{id}/stream` | 音频流 |
| HEAD | `/api/tracks/{id}/stream` | 播放资源头，无响应体 |
| GET | `/api/tracks/{id}/download` | 附件下载流 |
| HEAD | `/api/tracks/{id}/download` | 下载资源头，无响应体 |
| GET | `/api/image-proxy` | 封面位图流；查询参数 `url` |

## 4. 登录、退出与换号

### 查询登录状态

`GET /api/kernel/login/status` 返回 `loggedIn`、`biliUid`、`nickname`、`lastVerifiedAt`、`appOwnerId`、`libraryMode`、`loginStatus` 和 `sessionKey`，另有内部关联标识。默认 `libraryMode:"account"`；已登录的 appOwnerId 为服务端验证身份对应的分区，未登录为 guest 分区。客户端直接使用返回值。内核身份暂不可读时，账号业务返回 503，不把网络故障当作退出并切换到别人的库。

`sessionKey` 是搜索上下文，不是登录凭证。由登录态搜索响应取得并在翻页时原样携带，切换账号后重新搜索。

### 扫码登录

1. 调用 `POST /api/kernel/login/start`，不发送请求体。
2. 显示返回的 `qrImageUrl`。响应还包含 `loginSessionId`、`status:"pending"`、`expiresInSeconds`，以及二维码摘要和提示文字。
3. 每约 3 秒串行查询登录状态，`loggedIn:true` 时停止。
4. 到达 `expiresInSeconds`、用户取消或页面离开时停止轮询。二维码失效后由用户明确重新发起登录。
5. 有效待扫码会话的重复 start 会复用二维码；不要靠不停创建会话刷新二维码。

二维码地址已包含必要查询参数，不手工填写 profile/owner。登录成功、过期或取消后，旧二维码通常返回 404。

### 退出与换号

用户明确确认后：

```bash
curl -X POST "$BASE_URL/api/kernel/login/logout" -H "Content-Type: application/json" -d '{"confirmed":true}'
```

退出成功后先重新读取登录状态，取得退出后的 sessionKey，再调用 login/start 才是换号。新二维码创建失败时旧账号已经退出，应提示用户重试扫码，不恢复旧状态。音频或搜索仍在使用登录资料时可能返回 `409 / KERNEL_PROFILE_BUSY`，遵守 Retry-After。login/start 和 logout 同样检查携带的 X-Account-Context，旧上下文不能操作刚切换的新账号。

接口没有独立的“只取消二维码”方法。仅停止轮询不会取消内核会话，会话可自然过期；需要立即结束待扫码会话时使用确认过的 logout，该操作也具有退出当前登录的含义。

## 5. 搜索与稳定分页

### 请求参数

`POST /api/search`：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `keyword` | string | 必填，非空，最多 200 字符；关键词、BV 或视频页面链接 |
| `useRemote` | boolean | 默认 false；在线搜索需显式 true |
| `provider` | string | 新在线搜索默认 auto；可选 auto/bilibili/kernel；mock 不用于正式客户端 |
| `limit` | integer | 默认 20；请求 1–50，在线通常上限 20，以响应实际值为准 |
| `page` | integer | 默认 1，范围 1–10；不能超过返回的 pageLimit |
| `searchId` | string | 新搜索省略；翻页必带响应中的值，最多 64 字符 |
| `sessionKey` | string | 登录态翻页携带响应中的值，最多 128 字符；普通/本地结果可能没有该字段 |

首次请求：

```json
{
  "keyword": "纯音乐",
  "useRemote": true,
  "provider": "auto",
  "limit": 20,
  "page": 1
}
```

```bash
curl -X POST "$BASE_URL/api/search" -H "Content-Type: application/json" -d '{"keyword":"纯音乐","useRemote":true,"provider":"auto","limit":20,"page":1}'
```

auto 只在新搜索时选择来源：已登录优先 kernel，未登录或暂时读不到登录状态时选择 bilibili。选定来源的在线请求失败后不会自动改查本地。显式 kernel 要求有效登录。

成功响应包含：

| 字段 | 含义 |
| --- | --- |
| `provider` / `source` / `remoteUsed` | 实际来源；source 为 remote/local/direct |
| `candidates` | 当前页曲目元数据 |
| `searchId` / `sessionKey` | 翻页上下文；sessionKey 可能缺省 |
| `page` / `limit` | 实际页码和每页大小 |
| `hasPreviousPage` / `hasNextPage` | 相邻页导航信息 |
| `pageLimit` / `totalPages` | 允许浏览的最大页码/上游总页数；totalPages 可能缺省 |
| `duplicatesRemoved` / `cached` | 去掉的重复数量/是否复用已访问页 |
| `selectionNote` | 自动来源选择提示，可能缺省 |

### 翻页与跳页

保留原 keyword、useRemote，以及响应中的 provider、limit、searchId、sessionKey，只修改 page。下面的示意值必须替换为前一次响应的真实值，不能把示例标识发送给服务：

```json
{
  "keyword": "纯音乐",
  "useRemote": true,
  "provider": "kernel",
  "limit": 20,
  "page": 5,
  "searchId": "响应中的searchId",
  "sessionKey": "响应中的sessionKey"
}
```

- 返回已访问页复用快照；跨页按 BV 去重，不从下一页补齐，不将曲目顺延。
- 直接跳第 5 页只请求第 5 页，不预取第 2–4 页。音频准备和搜索可并行。
- 在线结果在当前页内将已关注 UP 提前；同组保留来源顺序。本地搜索先应用关注优先，再固定匹配集合并分页。没有分数或权重。
- 去重后的空页不等于整个搜索结束；按 hasNextPage/pageLimit 导航。
- 当前最多浏览 10 页，快照保留 30 分钟。修改关键词、来源、每页数量或登录上下文时从第一页新建搜索。
- `409 / SEARCH_SESSION_CHANGED` 或 `SEARCH_SNAPSHOT_EXPIRED`：清除旧翻页上下文，重新搜索。
- `SEARCH_PROVIDER_FAILED`：保留最后成功页，重试失败页时沿用原上下文；首次请求失败若返回了 searchId/provider/sessionKey，也应保留供重试使用。
- 改查本地必须由用户明确操作：useRemote=false、page=1，不带旧 searchId/sessionKey。

## 6. 列表和曲目元数据

候选列表、收藏列表、曲目任务列表采用 offset 分页，不使用搜索的 searchId。

| 接口 | limit 默认值 | limit 范围 | offset |
| --- | --- | --- | --- |
| `GET /api/candidates` | 100 | 1–100 | 默认 0，0–100000 |
| `GET /api/favorites` | 100 | 1–100 | 默认 0，0–100000 |
| `GET /api/tracks` | 50 | 1–100 | 默认 0，0–100000 |

响应都有 pagination，下一批使用 nextOffset；为 null 时停止：

```json
{
  "limit": 20,
  "offset": 0,
  "hasMore": true,
  "nextOffset": 20
}
```

`GET /api/tracks` 还可按 `status=pending|preparing|ready|expired|failed` 过滤，会同步本页最多 20 个准备中的任务。

常用对象：

| 对象 | 客户端需要关注的字段 |
| --- | --- |
| Candidate | id、bvid、title、creatorMid、creatorName、coverUrl、durationSeconds、tags、isPreferredCreator、isFavorited、sourceUrl |
| Favorite | id、candidateId、bvid、note、mood，以及用于缓存恢复的元数据快照 |
| Creator | id、biliMid、name、homepageUrl、notes |
| Playlist | id、name、description、trackCount、coverUrl、createdAt、updatedAt |
| PlaylistItem | id、position、addedAt、candidate；id 是条目 ID |
| Track | id、candidateId、bvid、title、status、failureReason、expiresAt、media、playbackRange |

这些是字段摘要，不是完整响应样例。完整对象及可空字段见 OpenAPI 的 components.schemas。不要用 candidate.id、playlist item.id、track.id 相互替代。

`GET /api/candidates/{id}` 返回 candidate 和当前音乐库的 interactions。sourceUrl 仅是 Bilibili 视频页面，不是可播放的音频地址。

`POST /api/candidates/{id}` 的请求体为 `{"action":"queued"}`，action 可为 viewed/liked/disliked/skipped/queued/extraction_failed。此接口只记录本地事件，不参与评分/推荐排序，也不写回 Bilibili；无需为了接入播放器实现点赞、点踩 UI。

## 7. 收藏与关注

### 收藏

`POST /api/favorites` 的 candidateId/bvid 至少传一个，引用已存在的候选元数据：

```json
{
  "candidateId": 123,
  "bvid": "BV1xx411c7mD",
  "note": "睡前听",
  "mood": "安静"
}
```

note 最多 500 字符，mood 最多 80 字符；均可省略或传 null。省略保留已有值，null 清空。重复收藏不会重复创建记录。

读取收藏优先渲染 `items[].candidate` 和对应的 `items[].favorite`，不自行把两个并列数组按下标配对。候选缓存丢失时可从收藏快照恢复元数据。

取消收藏使用 `DELETE /api/favorites/{candidateId}`，ID 取 `items[].candidate.id`，不是 favorite.id。收到 200 后更新 UI；不存在也返回 `{"deleted":false}`，无需再次删除。

### 关注 UP

`POST /api/creators`：

```json
{
  "biliMid": "10086",
  "name": "喜欢的音乐 UP",
  "notes": "关注的创作者"
}
```

biliMid 是 1–24 位数字字符串；也可省略 mid、提供 `https://space.bilibili.com/{mid}` 主页。不会从 name 中猜数字。name 最多 200 字符，省略时会尝试公开资料查询；主页归一为该 mid 的 Bilibili 空间。notes 最多 500 字符，可省略或传 null。

`PATCH /api/creators/{id}` 只接受 name、homepageUrl、notes。name 不能空，homepageUrl 必须属于原 UP，不能借编辑切换 MID；需要关注另一个 UP 时新增关注。省略字段保留原值，notes=null 清空备注。

收藏和关注都是本地元数据，不同步到 Bilibili。

## 8. 歌单调用

每个音乐库最多 100 个歌单，每单最多 200 首。name 为 1–80 字符的非空文字；description 最多 500 字符，省略时为空。

创建可同时添加一首候选曲目：

```bash
curl -X POST "$BASE_URL/api/playlists" -H "Content-Type: application/json" -H "Idempotency-Key: phone-playlist-001" -d '{"name":"晚间歌单","description":"轻松听一会儿","candidateId":123}'
```

保存响应 `playlist.id`，以下以 7 为例：

```bash
curl "$BASE_URL/api/playlists/7"
curl -X PATCH "$BASE_URL/api/playlists/7" -H "Content-Type: application/json" -d '{"name":"睡前歌单","description":""}'
curl -X POST "$BASE_URL/api/playlists/7/items" -H "Content-Type: application/json" -d '{"candidateId":456}'
```

详情的 `playlist.items` 已按顺序排列。每项包含条目 id 和完整 candidate；摘要接口和修改响应中的 playlist 不一定带 items，需要时重新读详情。

重排提交全部条目 ID，不是候选 ID：

```json
{
  "itemIds": [32, 31, 33]
}
```

将该对象发送到 `PATCH /api/playlists/{id}/items`。如果条目集合已变化，返回 409，重新读详情再提交；重复 ID 或错误类型返回 400。

移除条目用 `DELETE /api/playlists/{id}/items/{itemId}`；删除整单用 `DELETE /api/playlists/{id}`。这两类删除不存在时返回 404。不会删除收藏、其他歌单或音频。

整单播放由客户端将 items 顺序加入播放队列，只为实际要播放的一首调用 prepare；当前没有“整单准备/下载”接口。

## 9. 播放准备、状态与刷新

### 准备一首音乐

`POST /api/tracks/prepare` 的 candidateId/bvid 至少一个，引用已存在或可从收藏恢复的候选。最小调用：

```json
{
  "candidateId": 123
}
```

可选策略参数：

| 字段 | 规则 |
| --- | --- |
| strategyMode | auto 或 force；新客户端可显式使用 auto |
| strategy | force 时必须指定 api_dash/browser_network/mse_sourcebuffer 之一 |
| strategyOrder | auto 时可指定 1–3 个支持的策略；不传使用内核默认顺序 |

不要在 auto 模式同时指定 strategy，也不要在 force 模式指定 strategyOrder。新客户端不使用兼容的 snake_case 别名。

以下是省略部分元数据的响应节选：

```json
{
  "track": {
    "id": 456,
    "candidateId": 123,
    "bvid": "BV1xx411c7mD",
    "title": "歌曲标题",
    "status": "preparing",
    "failureReason": null,
    "playbackRange": {
      "accountId": "bili:123456",
      "bvid": "BV1xx411c7mD",
      "startSeconds": 0,
      "endSeconds": null,
      "revision": 0,
      "updatedAt": null,
      "configured": false
    },
    "media": {
      "streamUrl": null,
      "downloadUrl": null,
      "checksum": null,
      "sizeBytes": null,
      "mimeType": null,
      "fileName": null,
      "expiresAt": null,
      "resumable": false
    }
  },
  "pollAfterMs": 1500
}
```

HTTP 200 仅表示该请求完成；可能直接 ready，也可能 preparing 或 failed。重复 prepare 可复用已有 ready/preparing 曲目，不会要求用户反复创建任务。每个 Track 响应还携带当前账号的 playbackRange，准备、单首查询、批量状态和列表均会读取最新值。

### 轮询与终态

| track.status | 动作 |
| --- | --- |
| pending | 尚未准备；用户明确操作后调用 prepare |
| preparing | 串行轮询 `GET /api/tracks/{id}`，遵守 pollAfterMs/Retry-After |
| ready | 停止轮询，播放返回的 media.streamUrl |
| failed | 停止轮询，显示 failureReason，提供用户重试 |
| expired | 停止轮询；用户需要时重新准备 |

页面离开或切换曲目时取消旧轮询，设置有限等待时间，不让过期请求覆盖当前播放器状态。客户端取消等待不会自动取消内核任务；本版 App API 没有任务取消端点。

多首状态使用 `POST /api/tracks/status`：

```json
{
  "trackIds": [456, 457]
}
```

一次最多 20 个不同的正整数 ID，重复值会去重，非法值明确报错。响应为 tracks、missingTrackIds、pollAfterMs；缺失或无权访问的 ID 放入 missingTrackIds，不能把它们当作仍在准备。

`POST /api/tracks/{id}/refresh` 接收 JSON 对象，例如 `{}` 或上述策略参数，返回 track 和 pollAfterMs。它会重新准备 ready/failed/expired 曲目；正在 preparing 时复用进行中的任务。仅在用户明确重试/更新时调用。

## 10. 播放区间与网页/手机同步

播放区间以「服务端验证的账号 + BV」保存，不依赖候选 ID、track ID、浏览器缓存或临时音频文件，因此音频重新准备后仍有效。

### 读取

`GET /api/playback-ranges/{bvid}`，首次无设置的响应：

```json
{
  "playbackRange": {
    "accountId": "bili:123456",
    "bvid": "BV1xx411c7mD",
    "startSeconds": 0,
    "endSeconds": null,
    "revision": 0,
    "updatedAt": null,
    "configured": false
  }
}
```

startSeconds/endSeconds 单位是秒，支持小数，服务端归一到毫秒。endSeconds=null 表示原曲结尾；configured 表示是否设置了非默认区间。

### 保存

把读取时的 accountId、revision 分别放入 expectedAccountId、expectedRevision，再发送 `PATCH /api/playback-ranges/{bvid}`：

```json
{
  "startSeconds": 12.5,
  "endSeconds": 180,
  "expectedRevision": 0,
  "expectedAccountId": "bili:123456"
}
```

四个字段必填。开始不得小于 0，结束必须晚于开始，已知时长时不能超出原曲；最大秒数为 604800。响应返回最新 playbackRange。未改变值不增加 revision，同一成功写入的原样重发会复用结果。

- `409 / PLAYBACK_RANGE_CONFLICT`：其他设备更新了数据，重新 GET，向用户展示新值后再决定是否保存。
- `409 / ACCOUNT_CHANGED`：账号不同，不能继续提交旧账号草稿。
- `400 / INVALID_PLAYBACK_RANGE`、`PLAYBACK_RANGE_OUT_OF_BOUNDS`：调整输入，不自动重试。
- 恢复整首也使用 PATCH：startSeconds=0、endSeconds=null，携带当前账号和最新 revision，不删除版本记录。

网页播放栏可输入秒数或「分:秒」，也可把当前进度设为起点/终点。可见页面约每 5 秒及重新获得焦点时同步当前曲目的设置；再次点播会重新读服务端，不以旧浏览器缓存为准。换号立即停下旧播放器、关闭旧区间草稿，并按新账号恢复队列；原账号队列仍保留在该设备。

### 手机播放器必须应用区间

1. 准备/查询曲目，取得最新 track.playbackRange。
2. 每次用户点选歌曲，在媒体加载完成后先 seek 到 startSeconds，再播放。不要先播放 0 秒处再跳转。
3. 暂停恢复在区间内继续；已在终点时再次播放应回起点。拖动不得早于起点或晚于终点。
4. endSeconds 非空时，到该时间 pause，不自动切歌、不触发单曲循环；重新点歌仍从起点开始。
5. 区间超出实际音频时长时停止并提示调整，不悄悄退回有杂音的 0 秒起点。
6. 客户端离线可缓存账号/BV 对应的这份元数据，联网播放/编辑前重新读取并检查版本。

HTTP 字节流和下载文件仍是完整原音频；仅打开原始 streamUrl 的任意播放器不会自动获得此业务行为。手机客户端需按上述契约控制播放器。网页同时使用时间片段 URI 和事件/定时边界保护，不能只依赖稀疏的 timeupdate 事件。参考 [W3C 媒体片段](https://www.w3.org/TR/media-frags/) 和 [MDN timeupdate](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/timeupdate_event)。不重新转码、不复制音频，不改变内核 artifact 校验和。

## 11. 播放、下载和断点续传

媒体地址取自 track.media；sizeBytes、mimeType、fileName、expiresAt 和 checksum 用于客户端显示和校验。checksum 的结构为 `{"algorithm":"sha-256","value":"完整文件的64位十六进制SHA值"}`。

1. ready 后先 HEAD downloadUrl，记录 ETag、X-Content-SHA256、X-File-Size。
2. 播放时使用 streamUrl；主动下载使用 downloadUrl。
3. 中断续传发送 Range 和之前的强 ETag 作为 If-Range。
4. 返回 206 时核对 Content-Range 起点，再追加分片；返回 200 时覆盖旧临时分片，不能直接追加。
5. 全文件完成后校验 SHA-256，再标记为离线可用。不用整文件 SHA 去校验单个分片。
6. artifact 过期、404 转换成 410 或 ETag 改变后，不拼接旧、新音频。

```http
GET /api/tracks/456/download HTTP/1.1
Range: bytes=1048576-
If-Range: "sha256-替换为HEAD返回的真实摘要"
```

| 响应头 | 用途 |
| --- | --- |
| Content-Type | 实际媒体类型，不按固定字符串猜测 |
| Content-Length / Content-Range | 完整响应或当前分段的长度/范围 |
| Accept-Ranges | bytes 表示字节续传 |
| ETag / Last-Modified | 资源版本与条件请求 |
| X-Content-SHA256 / X-File-Size | 完整音频 SHA 与总大小 |
| Content-Disposition | download 的安全附件文件名 |
| X-Artifact-Expires-At | 服务端临时资源到期时间 |

GET/HEAD 均支持 Range、If-Range、If-None-Match、If-Modified-Since。304 无 body；不能把它保存成空音频。416 保留 `Content-Range: bytes */总大小`，需重新核对本地偏移。409 未就绪时查询 track；410 时由用户决定重新准备；502 等瞬时错误按有界重试处理。

手机可保存用户主动下载的离线文件；App 服务器只流式代理，不能保存第二份音频。禁止保存/传递签名媒体 URL、Bilibili Cookie、内核浏览器状态或 artifact 本地路径。

## 12. 封面、诊断与部署配置

`GET /api/image-proxy?url=编码后的封面URL` 只接受 i0/i1/i2.hdslb.com 的 /bfs/ 路径；拒绝凭据、非默认端口和重定向，HTTP 来源会归一到 HTTPS。允许 JPEG/PNG/WebP/AVIF/GIF/APNG 位图，不接受 SVG、HTML 或任意 image/*。成功为图片流；失败仍按 JSON 错误处理。

`GET /api/diagnostics` 仅供调试/管理查看元数据健康，不是推荐或打分接口。不要在普通页面高频调用。

由服务端部署配置、而不是客户端请求体传递的参数：

| 变量 | 用途 |
| --- | --- |
| KERNEL_BASE_URL | App 访问内核的内部地址 |
| APP_OWNER_ID / KERNEL_EXTERNAL_OWNER_ID | 旧本地库迁移来源和内核资料的稳定关联；不由客户端覆盖 |
| APP_LIBRARY_MODE | 默认 account；仅需保留原行为时显式设置 local |
| APP_SINGLE_USER_MODE | 历史配置，不再决定账号归属；不把 cookie 字段当作身份认证 |
| APP_ALLOWED_ORIGINS | 允许的 WebView/网页来源，逗号分隔 |
| DATABASE_PATH | App 元数据数据库位置 |
| KERNEL_REQUEST_TIMEOUT_MS | 内核 JSON 请求超时 |
| BILIBILI_SEARCH_TIMEOUT_MS / BILIBILI_SEARCH_LIMIT | 有界搜索超时/页大小 |
| TRACK_ARTIFACT_TTL_SECONDS | App 音频有效期判断配置 |

不要让客户端直调 Cookie 导入、内部 profile API，不实现批量抓取、无限翻页、账号池或访问权限绕过。正常登录不改变视频本身的可访问范围。

## 13. 验收与维护

接口的请求/响应类型以当前部署的 OpenAPI 为准；修改契约时同步此文档，不追加互相冲突的“旧版本说明”。

- [重复、并发和真实联调验收记录](MOBILE_API_ACCEPTANCE.md)
- [账号同步与播放区间验收](PLAYBACK_RANGE_ACCEPTANCE.md)
- [独立 HTTP 验收脚本及使用方法](../../../tests/mobile-api/README.md)
- [分页产品行为](PAGINATION.md)
- [歌单产品行为](PLAYLISTS.md)
- [账号、发现与搜索分工](ACCOUNT_AND_SEARCH.md)
