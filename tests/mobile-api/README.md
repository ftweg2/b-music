# 手机 API 原生 HTTP 验收

在仓库根目录执行：

```powershell
& tests/mobile-api/run.ps1
```

需要现有 `kernel-kernel` 镜像（项目内核 Dockerfile 构建，包含 Chrome、ffmpeg）、Node 和已安装的 App 依赖。脚本先构建 App，再启动仅监听 `127.0.0.1:3100/8100` 的隔离服务；端口被占用时停止，不会关闭未知服务。`-SkipBuild` 复用已有构建，`-KeepRunning` 为后续手工 UI 检查保留测试服务。

- App 使用系统临时目录的新 SQLite，仅存元数据。日志和测试元数据目录会在结束时打印，便于复查。
- kernel 不挂载真实 `storage`；数据仅在测试容器 `/tmp/b-music-http-*`。浏览器登录、音频采集、下载、ffmpeg 和正式 HTTP 路由均真实运行。
- Bilibili upstream 为本地确定性数据；fake QR 不可用于真实登录；不读取或退出用户账号。夹具模块只有显式环境 guard 和隔离目录才能导入，生产入口不会导入它。
- `acceptance.mjs` 是独立的原生 HTTP 客户端，不导入业务代码，不读取 App/kernel 数据库，也不读取浏览器登录文件。媒体只在客户端内存中核对 SHA-256。
- 每次运行输出独立 JSON 报告，记录请求 ID、方法、路径、状态、耗时、响应大小、断言、成功/失败端点覆盖。实际响应按线上提供的 OpenAPI schema 校验。

范围：20 轮歌单/收藏/关注/互动 CRUD + 4–8 路重复写入；20 轮播放/下载/批量状态/Range/ETag/304/416/SHA；二维码重试、过期、取消、换号；音频捕获和处理期间访问未缓存搜索页；上游故障和媒体失败恢复；严格参数、CORS、封面代理。

账号分区与播放区间使用独立验收（正式默认是 account；full 套件显式以 local 模式保留原元数据回归覆盖）：

```powershell
& tests/mobile-api/run.ps1 -LibraryMode account -Suite ranges -KeepRunning
```

该套件以两个独立的原生 HTTP 调用方模拟手机/网页，覆盖 20 轮区间同步、6 路重复写入、版本冲突、两个已验证测试 UID 的数据隔离与切回、旧账号上下文不能退出新账号、Track 准备/批量/列表返回最新区间。保留服务后通过浏览器实际验证播放边界与可见按钮，不用 HTTP 返回 200 代替播放验收。

这是有边界的重复验收，不代表对真实上游可用性或未来所有输入“永远零 bug”的证明。首轮调试报告也保留，不冒充通过结果。正式部署与真实账户的有限联调证据在 `bili-music-app/src/docs/MOBILE_API_ACCEPTANCE.md` 中单独记录。

保留隔离服务后，可补充原生生命周期验收：

```powershell
node tests/mobile-api/lifecycle.mjs cancel
node tests/mobile-api/lifecycle.mjs readers
node tests/mobile-api/lifecycle.mjs before-restart
# 只针对带 b-music.acceptance=true 标签的上述测试容器：
docker kill --signal KILL b-music-http-fixture
docker start b-music-http-fixture
node tests/mobile-api/lifecycle.mjs after-restart
```

`cancel` 连续取消三次并重试；`readers` 检查 6 路并发中最多 4 个读租约、忙碌响应、限流与 Retry-After 恢复；restart 两阶段检查真实 Chrome 被强制结束后，任务终态修复、会话/音乐库保留和再次提取。检查脚本不操作正式服务；手工重启前必须核对容器名称和标签。
