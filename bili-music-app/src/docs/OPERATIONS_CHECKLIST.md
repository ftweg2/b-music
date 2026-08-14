# 运维与质量检查

## 当前已修复

- 收藏按 App 身份隔离。
- 关注 UP 按 App 身份隔离。
- 搜索排序使用当前 App 身份下的收藏和关注 UP。
- 互动记录现在也按 App 身份隔离，避免网页端和未来 Android 端多用户串数据。
- Track 只保存 metadata，音频通过 `/api/tracks/{id}/stream` 或 `/download` 流式代理给客户端。
- App owner 与 kernel artifact owner 已分开保存，避免多用户模式误用 owner。
- 下载支持 HEAD、Range、If-Range、大小、SHA-256 与 owner 隔离测试。

## 仍需后续完善

- 增加用户主动“把 local 收藏迁移到当前 B 站身份”的操作。
- 给生产部署补 App Dockerfile 或统一 compose，方便一键上云。
- 把 API 文档中的接口整理成稳定 `/api/v1/*` 前，先不要给 Android 承诺永久字段。
- 补真实 Docker kernel + App 双服务的浏览器端到端下载冒烟测试。
- 后续如果多人正式使用，需要从 SQLite 迁移到 Postgres 或至少增加定期 SQLite 备份。

## 安全检查

- App 不保存 Cookie。
- App 不保存 Bilibili storage state。
- App 不保存 browser profile。
- App 不保存音频、视频或完整 artifact body。
- kernel 不应暴露公网。
- 日志里不应出现 Cookie、Authorization、QR token、完整签名媒体 URL。

