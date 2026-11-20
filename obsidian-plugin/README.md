# Embedded Learning Hub Sync 1.0.0

Obsidian 桌面端与手机端双向同步插件。将本目录中的 `main.js`、`manifest.json` 和 `styles.css` 放入 Vault 的 `.obsidian/plugins/embedded-learning-hub-sync/` 文件夹，然后在 Obsidian 的「设置 → 第三方插件」中启用。

## 首次连接

1. 先将学习网站部署为 V19，并在网站中登录现有 Supabase 账号，等待一次云同步完成。
2. 在插件设置中填写同一 Supabase Project URL 和公开 publishable/anon key。
3. 使用学习网站已有邮箱和密码登录；电脑和手机上的 Obsidian 分别登录一次。若使用 Obsidian Sync 分发插件，请在每台设备的「设置 → 同步 → Vault 配置同步」中分别启用「已安装社区插件列表」与「活动社区插件列表」。本插件通过 Supabase 同步 `Embedded Learning Hub/` 内容，建议把该目录加入 Obsidian Sync 的「排除文件夹」，避免两套同步服务同时写同一批笔记。
4. 运行「现在同步学习网站与 Obsidian」。

资源收藏笔记需要填写有效的 `http://` 或 `https://` 链接后才会同步。首次同步会在 `Embedded Learning Hub/` 创建 `知识库/`、`学习记录/`、`课程笔记/` 和 `资源/` 四个目录。插件只管理这个根目录内带有 `elh_type` frontmatter 的 Markdown 文件。

命令面板还提供新建知识卡片、学习记录、资源收藏、课程笔记，以及从云端课程列表中选择课程后新建课时笔记的命令。课程笔记还同步阶段名称与学习目标。Vault 中独立存放的图片/PDF 等二进制附件不会作为附件文件单独上传；同步的是 Markdown 正文和工作区字段。

## 自动同步

- Obsidian 启动、Vault 文件创建/修改/删除/重命名、网络恢复、应用回到前台时触发同步。
- 应用处于前台时按设置的 30–900 秒间隔检查云端，默认 90 秒。
- 手机应用进入后台后，操作系统可能暂停插件；再次打开或回到前台会继续同步。

## 冲突与删除

同步使用稳定 `elh_id` 和云端 revision。若同一条内容在网站和 Obsidian 同时修改，插件保留本机版本到 `_同步冲突/`，同步笔记按云端版本恢复；请人工合并冲突副本。删除同步笔记会删除网站对应条目；删除课程会连同其课时、完成状态和课时编辑一起移除。删除前请先备份网站工作区 JSON。

## 安全和兼容性

- 使用 Supabase 用户会话及现有 RLS，不需要新表或额外数据库权限。
- 只使用公开 publishable/anon key；禁止使用 `service_role` 或 `sb_secret_`。
- 登录密码只用于请求认证，不保存；刷新令牌保存在本设备 Obsidian 本地存储中。
- 仅使用 Obsidian API、`requestUrl` 和 Web API；没有依赖 Node.js 文件系统或 Electron，`isDesktopOnly` 为 `false`。
- 插件未发布到社区插件目录，当前为手动安装包。使用 Obsidian Sync 分发插件时，需在每台设备分别打开社区插件列表同步，并将 `Embedded Learning Hub/` 加入排除文件夹；iOS 手动访问隐藏的 `.obsidian/plugins/` 配置目录可能受系统文件管理限制。
- 图片等复杂富文本在 Markdown 中编辑后可能需要重新排版；未编辑的原始 HTML 会通过隐藏注释保留。
