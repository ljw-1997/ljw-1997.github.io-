# Embedded Learning Bridge

这是“嵌入式学习站”V19 的 Obsidian 双向同步插件。插件源码包含 `manifest.json` 与 `main.js`，支持 Obsidian 桌面版与移动版。

## 安装

将这两个文件放到 Vault 的 `.obsidian/plugins/embedded-learning-bridge/`，在 Obsidian 设置 → 第三方插件中启用。然后在插件设置中填写 Supabase URL、公开 publishable/anon key 和学习站账号，登录后即可同步。

先在 Supabase SQL Editor 执行网站项目根目录的 `obsidian-sync-schema.sql`。首次使用前，建议先让网站登录并完成云工作区迁移。

插件不保存明文密码，但会保存 access/refresh token。若使用 Obsidian Sync 同步配置，请不要让多个设备共用该插件的 `data.json`；每台设备分别登录同一账号。

自动同步目录是 `嵌入式学习站/`。本机冲突版本保存在 `嵌入式学习站/同步冲突/`，该目录不参与自动同步。
