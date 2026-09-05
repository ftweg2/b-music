# 性能优化与独立 VPS 部署

目标：不改变现有音乐、账号、歌单、播放区间和手机 API 行为，减少重复计算与数据库开销；构建可复现的生产镜像，部署到 bmusic.ftwegc.com，保持同机其他项目不变，并推送 GitHub。

## 验收清单

- [x] 优化前后基准及输出一致性证据。
- [x] 全部单元/集成、API、播放区间回归通过。
- [x] Linux 生产镜像构建并在隔离环境验收。
- [x] VPS 专用目录/端口/网络/数据目录和资源上限。
- [x] 独立 Nginx 虚拟主机、有效 HTTPS、入口访问保护。
- [x] 域名访问和认证后的功能冒烟，原 Nginx 配置及其他服务保持不变。
- [x] GitHub 提交推送成功，不包含私钥、Cookie、数据库、音频和私密验收产物。

本文件在验证后补充具体数据和部署结果，不以构建成功代替上线验收。

## 已验证的性能结果

Windows Node v24.19.0，独立临时 SQLite 中 20,000 条元数据，预热 25 次、测量 500 次。它是数据库/组装基准，不代表真实网络整页加载会快同样倍数。

| 操作 | 优化前中位数 | 优化后中位数 | 输出 |
| --- | --- | --- | --- |
| 账号/状态过滤的 51 条曲目分页 | 4.8601 ms | 0.1473 ms | 顺序和数据不变，查询不再创建排序临时 B-tree |
| 100 首曲目的 API 对象及区间组装 | 1.0856 ms | 0.2191 ms | 从逐条区间查询变为按 owner 批量查询 |

两次完整响应 SHA-256 均为 `392c9bd6169e72eb71000d8a702e69e40b99ebb0592d164bf900f22bb0a32129`。此外，已存在的内核 profile 查询不再执行无效 INSERT/写事务；重复且完全相同的账号轮询不再触发 UI 通知。真实身份仍逐次确认，不跨请求缓存登录身份。

实际 Linux standalone App 和原功能完整的 kernel 镜像，在拟用于 VPS 的 CPU/内存限额下完成 40 项操作、1,507 次 HTTP 回归，以及 238 次账号/区间调用。录音采集、ffmpeg、并行翻页、版本冲突、二维码和字节流均经过隔离上游验收。空闲时观测 App 约 112 MiB、内核约 216 MiB；Chrome 任务启动后仍需留有预算，不能把空闲内存当峰值。

脚本与部署方式见 [部署说明](../../../deploy/README.md)。详细原始报告和性能样本保留在本机的 tests/mobile-api/reports 与 tests/performance-reports，默认不上传 GitHub，避免暴露个人运行信息。

## VPS 验收（2026-09-05）

- 域名：`https://bmusic.ftwegc.com`。未认证请求为 401；正确认证后 HTML、静态资源、健康、能力、OpenAPI、音乐库读取均为 200。外站 Origin 修改请求被拒绝，本域 HTTPS Origin 正常到达参数校验。
- Certbot webroot 证书签发成功，到期日 2026-12-04，已安装仅针对本域的续期后 Nginx 校验/重载钩子。
- 项目目录 `/opt/bmusic`；独立网络 `bmusic_default`；仅本机 13100/18100 端口；App 224 MiB、kernel 512 MiB 限额。只限制本项目的 swap/OOM 优先级，不改主机全局内存配置。
- 原 nginx.conf、komari.conf、ip-acme.conf 的 SHA-256 在部署前后完全一致；原监控容器仍从 2026-08-04 启动，重启计数 0。另有 x-ui 每分钟重启的既有任务，部署前日志已存在，本次没有修改它。
- 音乐库迁移包含 2 条收藏、9 条曲目和 1 条区间设置；25 个 artifact 的大小/校验和验证无误。未传输本机浏览器 Cookie，VPS 首次需要重新扫码。
- 排除了不支持 AAC 的无品牌 headless shell；采用同版本 Google 官方 branded Headless Shell，AAC/MSE 与 Opus 实测可用。VPS 空白页启动从完整 Chrome 约 115 秒降至约 17 秒，保留全部音频策略。
- B 站新版页面已包含二维码 PNG；优先读取该位图，避免低配 VPS 的页面截图阻塞，并保留原选择器/截图回退。公网二维码创建返回 200（首次冷启动约 42 秒），PNG 图片获取为 200，已目视确认二维码。测试会话结束后 active_jobs/profile_locks/profile_readers 均为 0，没有退出真实登录账号。
- 因低配冷启动而给 QR 准备设置有界的 60 秒服务端预算、90 秒客户端预算；二维码生成后的 180 秒有效期不变。数据与接口字段保持兼容。

访问凭据由 `deploy/create-access.mjs` 生成，只保留在忽略的私密文件和 VPS Nginx 中，不在本报告或 GitHub 中公开。完整站点冒烟报告在本机 `deploy/private/site-verification.json`。

GitHub 的 main 要求 PR 与状态检查，因此代码推送到 `codex/performance-vps-deploy`，提交 PR [#20](https://github.com/ftweg2/b-music/pull/20)，没有绕过分支保护。CI/Release 的 Node 主版本与生产镜像统一为 24。
