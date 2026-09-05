import { API_REVISION } from "./apiCapabilities";
import { API_ROUTES } from "./apiRoutes";

type Schema = Record<string, unknown>;
const str = (extra: Schema = {}): Schema => ({ type: "string", ...extra });
const integer = (min = 0, max?: number): Schema => ({ type: "integer", minimum: min, ...(max === undefined ? {} : { maximum: max }) });
const bool: Schema = { type: "boolean" };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const array = (items: Schema, maxItems?: number): Schema => ({ type: "array", items, ...(maxItems === undefined ? {} : { maxItems }) });
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const ref = (name: string): Schema => ({ $ref: "#/components/schemas/" + name });
const id = integer(1, Number.MAX_SAFE_INTEGER);
const bv = str({ pattern: "^BV[0-9A-Za-z]{10}$" });
const textOrNull = nullable(str());
const stamp = str({ format: "date-time" });
const strategy = str({ enum: ["api_dash", "browser_network", "mse_sourcebuffer"] });
const prepareProperties = {
  candidateId: id, bvid: bv, strategyMode: str({ enum: ["auto", "force"], default: "auto" }),
  strategy, strategyOrder: { ...array(strategy, 3), minItems: 1 },
  strategy_mode: str({ enum: ["auto", "force"], deprecated: true }),
  strategy_order: { ...array(strategy, 3), minItems: 1, deprecated: true },
};
const candidateProperties = {
  id, bvid: bv, aid: textOrNull, title: str(), description: textOrNull,
  creatorMid: textOrNull, creatorName: textOrNull, coverUrl: textOrNull,
  durationSeconds: nullable(integer()), pubTime: textOrNull, sourceUrl: str(),
  category: textOrNull, tagsJson: textOrNull, searchKeyword: textOrNull, sourceProvider: str(),
  lastSeenAt: stamp, createdAt: stamp, updatedAt: stamp, tags: array(str()),
  isPreferredCreator: bool, isFavorited: bool,
};
const schemas: Record<string, Schema> = {
  ApiError: object({ error: str(), code: str(), retryable: bool, requestId: str(), details: { type: "object", additionalProperties: str() } }, ["error","code","retryable","requestId"]),
  PlaybackRange: object({accountId:str(),bvid:bv,startSeconds:{type:"number",minimum:0},endSeconds:nullable({type:"number",minimum:0}),revision:integer(),updatedAt:nullable(stamp),configured:bool},["accountId","bvid","startSeconds","endSeconds","revision","updatedAt","configured"]),
  SavePlaybackRange: {...object({startSeconds:{type:"number",minimum:0,maximum:604800},endSeconds:nullable({type:"number",minimum:0,maximum:604800}),expectedRevision:integer(),expectedAccountId:str()},["startSeconds","endSeconds","expectedRevision","expectedAccountId"]),additionalProperties:false},
  Candidate: object(candidateProperties, Object.keys(candidateProperties)),
  Interaction: object({ id, externalOwnerId: str(), candidateId: id, action: str({ enum: ["viewed","liked","disliked","skipped","queued","extraction_failed"] }), createdAt: stamp }, ["id","candidateId","action","createdAt"]),
  Creator: object({ id, externalOwnerId: str(), biliMid: str(), name: str(), homepageUrl: textOrNull, notes: textOrNull, createdAt: stamp, updatedAt: stamp }, ["id","biliMid","name"]),
  Favorite: object({
    id, externalOwnerId: str(), candidateId: nullable(id), bvid: bv, note: textOrNull, mood: textOrNull,
    titleSnapshot: str(), sourceUrlSnapshot: str(), creatorMidSnapshot: textOrNull, creatorNameSnapshot: textOrNull,
    coverUrlSnapshot: textOrNull, durationSecondsSnapshot: nullable(integer()), pubTimeSnapshot: textOrNull,
    categorySnapshot: textOrNull, tagsJsonSnapshot: textOrNull, snapshotQuality: str({enum:["minimal","partial","complete"]}),
    lastHydratedAt: textOrNull, createdAt: stamp, updatedAt: stamp,
  }, ["id","bvid","titleSnapshot","sourceUrlSnapshot"]),
  Pagination: object({ limit: integer(1,100), offset: integer(), hasMore: bool, nextOffset: nullable(integer()) }, ["limit","offset","hasMore","nextOffset"]),
  Playlist: object({ id, name: str(), description: str(), trackCount: integer(0,200), coverUrl: textOrNull, createdAt: stamp, updatedAt: stamp }, ["id","name","description","trackCount"]),
  PlaylistItem: object({ id, position: integer(), addedAt: stamp, candidate: ref("Candidate") }, ["id","position","addedAt","candidate"]),
  PlaylistDetail: { allOf: [ref("Playlist"), object({ items: array(ref("PlaylistItem"),200) }, ["items"])] },
  Track: object({
    id, externalOwnerId: str(), candidateId: id, bvid: bv, title: str(), sourceUrl: str(), kernelJobId: textOrNull,
    artifactName: textOrNull, artifactSha256: textOrNull, artifactSizeBytes: nullable(integer()), artifactMimeType: textOrNull,
    durationSeconds: nullable(integer()), status: str({enum:["pending","preparing","ready","expired","failed"]}),
    failureReason: textOrNull, expiresAt: textOrNull, createdAt: stamp, updatedAt: stamp, media: ref("TrackMedia"), playbackRange: ref("PlaybackRange"),
  }, ["id","candidateId","bvid","title","status","media","playbackRange"]),
  TrackMedia: object({
    streamUrl: textOrNull, downloadUrl: textOrNull, checksum: nullable(object({ algorithm: str({const:"sha-256"}), value: str() }, ["algorithm","value"])),
    sizeBytes: nullable(integer()), mimeType: textOrNull, fileName: textOrNull, expiresAt: textOrNull, resumable: bool,
  }, ["streamUrl","downloadUrl","checksum","sizeBytes","mimeType","fileName","expiresAt","resumable"]),
  SearchRequest: object({
    keyword: str({minLength:1,maxLength:200}), useRemote: { ...bool, default:false }, provider: str({enum:["auto","bilibili","kernel"],default:"auto"}),
    limit: {...integer(1,50),default:20}, page: {...integer(1,10),default:1}, searchId: str({maxLength:64}), sessionKey: str({maxLength:128}),
  }, ["keyword"]),
  SearchResult: object({
    provider: str(), source: str({enum:["remote","local","direct"]}), remoteUsed: bool, page: integer(1,10),
    limit: integer(1,50), hasPreviousPage: bool, hasNextPage: bool, candidates: array(ref("Candidate"),50),
    searchId: str(), sessionKey: str(), pageLimit: integer(1,10), totalPages: integer(), duplicatesRemoved: integer(), cached: bool, selectionNote: str(),
  }, ["provider","source","page","limit","hasNextPage","candidates","searchId","pageLimit","duplicatesRemoved","cached"]),
  PrepareRequest: { ...object(prepareProperties), anyOf:[{required:["candidateId"]},{required:["bvid"]}] },
  RefreshRequest: object(prepareProperties),
  PreparedTrack: object({ track: ref("Track"), pollAfterMs: nullable(integer()) }, ["track","pollAfterMs"]),
  TrackBatchRequest: object({trackIds:{...array(id,20),minItems:1},track_ids:{...array(id,20),deprecated:true}},[]),
  TrackBatch: object({tracks:array(ref("Track"),20),missingTrackIds:array(id),pollAfterMs:nullable(integer())},["tracks","missingTrackIds","pollAfterMs"]),
  CreatePlaylist: object({name:str({minLength:1,maxLength:80}),description:str({maxLength:500}),candidateId:id},["name"]),
  EditPlaylist: object({name:str({minLength:1,maxLength:80}),description:str({maxLength:500})}),
  AddPlaylistItem: object({candidateId:id},["candidateId"]),
  ReorderPlaylist: object({itemIds:{...array(id,200),uniqueItems:true}},["itemIds"]),
  CreateCreator: object({biliMid:str({pattern:"^\\d{1,24}$"}),name:str({maxLength:200}),homepageUrl:str({maxLength:1000}),notes:nullable(str({maxLength:500}))}),
  EditCreator: object({name:str({minLength:1,maxLength:200}),notes:nullable(str({maxLength:500})),homepageUrl:str({maxLength:1000})}),
  SaveFavorite: {...object({candidateId:id,bvid:bv,note:nullable(str({maxLength:500})),mood:nullable(str({maxLength:80}))}),anyOf:[{required:["candidateId"]},{required:["bvid"]}]},
  LoginStatus: object({
    loggedIn:bool,profileId:str(),externalOwnerId:str(),biliUid:textOrNull,nickname:textOrNull,lastVerifiedAt:textOrNull,
    appOwnerId:str(),libraryMode:str({enum:["local","account"]}),sessionKey:str(),loginStatus:str(),
  },["loggedIn","appOwnerId","libraryMode","sessionKey","loginStatus"]),
  LoginStart: object({loginSessionId:str(),status:str({const:"pending"}),message:str(),qrImageUrl:str(),qrImageSha256:textOrNull,expiresInSeconds:integer(1)},["loginSessionId","status","qrImageUrl","expiresInSeconds"]),
  LogoutRequest: object({confirmed:{...bool,const:true}},["confirmed"]),
  InteractionRequest: object({action:str({enum:["viewed","liked","disliked","skipped","queued","extraction_failed"]})},["action"]),
};

type Operation = { summary: string; response?: Schema; request?: string; status?: number; binary?: string; query?: Array<{name:string;schema:Schema;required?:boolean}>; idempotent?: boolean; description?: string };
const listing = [{name:"limit",schema:{...integer(1,100),default:100}},{name:"offset",schema:{...integer(0,100000),default:0}}];

const ops: Record<string, Operation> = {
  "GET /api/playback-ranges/{bvid}": {summary:"读取当前账号的歌曲播放区间",response:object({playbackRange:ref("PlaybackRange")},["playbackRange"]),description:"按服务端验证的账号和 BV 保存；默认 startSeconds=0、endSeconds=null。手机和网页共用，不修改原音频。"},
  "PATCH /api/playback-ranges/{bvid}": {summary:"保存／重置播放区间",request:"SavePlaybackRange",response:object({playbackRange:ref("PlaybackRange")},["playbackRange"]),description:"先 GET，携带 accountId 作为 expectedAccountId、revision 作为 expectedRevision。冲突返回 409。startSeconds=0、endSeconds=null 重置；指定终点后播放到终点停止，不自动切歌。"},
  "GET /api/health": {summary:"应用健康状态",response:object({status:str(),app:str(),apiVersion:str(),capabilitiesUrl:str(),provider:str(),metadataOnly:bool,expiredTracksMarked:integer()},["status"])},
  "GET /api/capabilities": {summary:"手机客户端能力与限制发现",response:object({apiVersion:str(),apiRevision:str(),serverTime:stamp,features:{type:"object",additionalProperties:bool},limits:{type:"object",additionalProperties:integer()},defaults:{type:"object"},endpoints:{type:"object",additionalProperties:str()}},["apiVersion","apiRevision","features","limits","endpoints"])},
  "GET /api/diagnostics": {summary:"受信任部署的数据健康诊断",response:object({status:str(),counts:{type:"object",additionalProperties:integer()},dataHealth:{type:"object",additionalProperties:integer()},expiredTracksMarked:integer()},["status","counts","dataHealth"])},
  "POST /api/search": {summary:"搜索／固定快照翻页",request:"SearchRequest",response:ref("SearchResult"),description:"新查询使用 page=1；后续只改变 page，保留返回的 provider、searchId、sessionKey 和 limit。准备音频不阻止搜索。失败时不切换来源。"},
  "GET /api/candidates": {summary:"候选曲目列表",query:listing,response:object({ownerId:str(),candidates:array(ref("Candidate")),pagination:ref("Pagination")},["candidates","pagination"])},
  "GET /api/candidates/{id}": {summary:"曲目详情",response:object({ownerId:str(),candidate:ref("Candidate"),interactions:array(ref("Interaction"))},["candidate","interactions"])},
  "POST /api/candidates/{id}": {summary:"记录一次互动",request:"InteractionRequest",response:object({interaction:ref("Interaction")},["interaction"]),status:201,idempotent:true,description:"通过 Idempotency-Key 安全重试同一个事件。"},
  "GET /api/favorites": {summary:"收藏列表",query:listing,response:object({ownerId:str(),favorites:array(ref("Favorite")),candidates:array(ref("Candidate")),items:array(object({favorite:ref("Favorite"),candidate:ref("Candidate")})),pagination:ref("Pagination")},["items","pagination"])},
  "POST /api/favorites": {summary:"保存收藏（按 BV 幂等）",request:"SaveFavorite",status:201,response:object({favorite:ref("Favorite"),candidate:ref("Candidate"),item:object({favorite:ref("Favorite"),candidate:ref("Candidate")})},["favorite","candidate"])},
  "DELETE /api/favorites/{candidateId}": {summary:"取消收藏",response:object({deleted:bool},["deleted"])},
  "GET /api/creators": {summary:"关注的 UP",response:object({ownerId:str(),creators:array(ref("Creator"))},["creators"])},
  "POST /api/creators": {summary:"关注 UP（按 MID 幂等）",request:"CreateCreator",status:201,response:object({creator:ref("Creator")},["creator"])},
  "PATCH /api/creators/{id}": {summary:"编辑 UP 备注",request:"EditCreator",response:object({creator:ref("Creator")},["creator"])},
  "DELETE /api/creators/{id}": {summary:"取消关注",response:object({deleted:bool},["deleted"])},
  "GET /api/playlists": {summary:"歌单列表",response:object({playlists:array(ref("Playlist"),100)},["playlists"])},
  "POST /api/playlists": {summary:"创建歌单",request:"CreatePlaylist",status:201,idempotent:true,response:object({playlist:ref("Playlist")},["playlist"]),description:"同一 Idempotency-Key 在 24 小时内只创建一个歌单；不同请求不能复用同一键。"},
  "GET /api/playlists/{id}": {summary:"歌单详情与有序曲目",response:object({playlist:ref("PlaylistDetail")},["playlist"])},
  "PATCH /api/playlists/{id}": {summary:"编辑歌单",request:"EditPlaylist",response:object({playlist:ref("Playlist")},["playlist"])},
  "DELETE /api/playlists/{id}": {summary:"删除歌单（保留收藏）",response:object({deleted:bool},["deleted"])},
  "POST /api/playlists/{id}/items": {summary:"添加曲目（同歌单按 BV 去重）",request:"AddPlaylistItem",response:object({added:bool,playlist:ref("Playlist")},["added","playlist"])},
  "PATCH /api/playlists/{id}/items": {summary:"重排全部条目",request:"ReorderPlaylist",response:object({reordered:bool},["reordered"]),description:"itemIds 是完整条目 ID 集合，不是 candidateId；并发集合变化返回 409。"},
  "DELETE /api/playlists/{id}/items/{itemId}": {summary:"移除歌单条目",response:object({removed:bool},["removed"])},
  "GET /api/recommendations": {summary:"旧收藏接口兼容别名",response:object({mode:str(),ownerId:str(),candidates:array(ref("Candidate")),emptyState:str()},["mode","candidates"])},
  "POST /api/tracks/prepare": {summary:"创建或复用准备任务",request:"PrepareRequest",response:ref("PreparedTrack"),description:"HTTP 200 表示请求处理成功，必须读取 track.status；preparing 按 pollAfterMs 查询，不应反复创建任务。"},
  "GET /api/tracks": {summary:"曲目与准备状态列表",query:[{name:"limit",schema:{...integer(1,100),default:50}},listing[1],{name:"status",schema:str({enum:["pending","preparing","ready","expired","failed"]})}],response:object({tracks:array(ref("Track")),pagination:ref("Pagination")},["tracks","pagination"])},
  "GET /api/tracks/{id}": {summary:"同步单个准备任务",response:ref("PreparedTrack")},
  "POST /api/tracks/status": {summary:"批量同步任务",request:"TrackBatchRequest",response:ref("TrackBatch")},
  "POST /api/tracks/{id}/refresh": {summary:"重新准备过期／失败曲目",request:"RefreshRequest",response:ref("PreparedTrack")},
  "GET /api/tracks/{id}/stream": {summary:"流式播放",binary:"audio/mp4"},
  "HEAD /api/tracks/{id}/stream": {summary:"查询播放资源头",binary:"audio/mp4"},
  "GET /api/tracks/{id}/download": {summary:"下载与断点续传",binary:"application/octet-stream"},
  "HEAD /api/tracks/{id}/download": {summary:"查询下载大小、校验和与断点能力",binary:"application/octet-stream"},
  "GET /api/kernel/health": {summary:"应用到内核连通检查",response:object({status:str()},["status"])},
  "GET /api/kernel/login/status": {summary:"当前登录和搜索上下文",response:ref("LoginStatus")},
  "POST /api/kernel/login/start": {summary:"开始或复用待扫码会话",response:ref("LoginStart"),description:"原生客户端显示返回的 qrImageUrl，每 3 秒读登录状态；达到 expiresInSeconds 后停止轮询。不会返回 Cookie。"},
  "POST /api/kernel/login/logout": {summary:"退出本机 B 站登录（保留音乐库）",request:"LogoutRequest",response:object({loggedIn:bool,message:str()},["loggedIn","message"]),description:"确认后调用。音频／搜索仍使用登录资料时返回 409；先退出成功，再调用 login/start 即换号。"},
  "GET /api/kernel/login/qr": {summary:"读取当前 owner 的二维码图片",binary:"image/png",query:[{name:"profileId",schema:str(),required:true},{name:"loginSessionId",schema:str(),required:true},{name:"externalOwnerId",schema:str()}]},
  "GET /api/image-proxy": {summary:"显示 Bilibili 封面",binary:"image/*",query:[{name:"url",schema:str(),required:true}]},
};
const commonHeaders = {
  "X-Request-Id": {schema:str(),description:"请求追踪 ID"},
  "X-API-Version": {schema:str()}, "X-API-Revision": {schema:str()},
  "Retry-After": {schema:str(),description:"忙碌或限流时按秒重试"},
};
const mediaHeaders = {
  ...commonHeaders, "Content-Length":{schema:str()}, "Content-Range":{schema:str()}, "Accept-Ranges":{schema:str()},
  ETag:{schema:str()}, "X-Content-SHA256":{schema:str()}, "X-File-Size":{schema:str()}, "X-Artifact-Expires-At":{schema:str()},
};

export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of API_ROUTES) {
    const path: Record<string, unknown> = {};
    for (const method of route.methods) {
      const definition = ops[method + " " + route.path];
      if (!definition) throw new Error("Missing API contract: " + method + " " + route.path);
      const parameters: Schema[] = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({name:match[1],in:"path",required:true,schema:match[1]==="bvid"?bv:id}));
      parameters.push({name:"X-Request-Id",in:"header",required:false,schema:str({maxLength:64})});
      parameters.push({name:"X-Account-Context",in:"header",required:false,schema:str(),description:"沿用登录状态的 sessionKey；账号变化时阻止误写。此值不是鉴权凭证。"});
      for (const query of definition.query ?? []) parameters.push({...query,in:"query",required:Boolean(query.required)});
      if (definition.idempotent) parameters.push({name:"Idempotency-Key",in:"header",required:false,schema:str({minLength:8,maxLength:128})});
      const responses: Record<string, unknown> = {};
      if (definition.binary) {
        if (route.path.includes("/tracks/")) for (const name of ["Range","If-Range","If-None-Match","If-Modified-Since"]) parameters.push({name,in:"header",required:false,schema:str()});
        for (const code of route.path.includes("/tracks/") ? [200,206,304] : [200]) responses[code] = {
          description:code===206?"部分资源":code===304?"资源未改变":"资源就绪",headers:mediaHeaders,
          ...(method==="HEAD"||code===304?{}:{content:{[definition.binary]:{schema:{type:"string",format:"binary"}}}}),
        };
      } else {
        responses[definition.status ?? 200] = {description:"成功",headers:commonHeaders,content:{"application/json":{schema:definition.response}}};
      }
      for (const code of [400,403,404,409,410,413,415,416,429,500,502,503,504]) responses[code] = {
        description:"明确的错误；按 code 和 retryable 处理",headers:commonHeaders,
        ...(method==="HEAD"?{}:{content:{"application/json":{schema:ref("ApiError")}}}),
      };
      path[method.toLowerCase()] = {
        operationId:(method+"_"+route.path).replace(/[^A-Za-z0-9]+/g,"_"),summary:definition.summary,
        description:definition.description,parameters,responses,
        ...(definition.request?{requestBody:{required:true,content:{"application/json":{schema:ref(definition.request)}}}}:{}),
      };
    }
    paths[route.path] = path;
  }
  return {
    openapi:"3.1.0",
    info:{title:"B-Music 手机客户端 API",version:API_REVISION,description:"保留 v1 URL，增加账号/BV 播放区间与版本冲突保护。默认按内核验证的当前 Bilibili 账号分区，网页和手机共用同一服务的设置；当前仍是单个活动 Bilibili 登录，不是独立多客户端认证。手机使用该安装实例的 Base URL；不可信网络须通过带鉴权的 HTTPS 网关。媒体 URL 相对 Base URL 解析，原音频不裁切，手机客户端按 playbackRange 控制起止。"},
    servers:[{url:"/"}],paths,components:{schemas},
  };
}
