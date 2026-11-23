# Supabase 容量监控部署说明

本功能分成三部分：网页显示层、Supabase Edge Function、PostgreSQL 只读统计函数。GitHub Pages 只托管网页；SQL 和 Edge Function 必须另外部署到你的 Supabase 项目。

## 1. 安装 SQL 函数

1. 打开 Supabase Dashboard，选择正在给学习站使用的 Project。
2. 打开 **SQL Editor**，新建 Query。
3. 将 `sql/usage-monitor.sql` 的全部内容粘贴进去并执行。
4. 函数 `public.get_project_usage()` 只授权给 `service_role` 执行；`PUBLIC`、`anon` 和 `authenticated` 均没有执行权限。函数使用 `SECURITY INVOKER`，因此统计查询以服务端 admin client 的权限执行。

## 2. 部署 Edge Function

将 `functions/usage-monitor/index.ts` 部署为名称恰好为 `usage-monitor` 的 Edge Function。

可通过 Supabase Dashboard → **Edge Functions → Deploy a new function → Via Editor** 创建；也可以使用 Supabase CLI 将 `functions/usage-monitor/` 目录部署。`config.toml` 中的 `verify_jwt = true` 应保持开启。代码使用 `@supabase/server` 的 `withSupabase({ auth: "user" })` 验证用户会话，并通过服务端 `ctx.supabaseAdmin` 调用 RPC。

## 3. 配置允许查看用量的账号

在 **Edge Functions → Secrets** 新增：

- Name：`USAGE_MONITOR_ALLOWED_USER_IDS`
- Value：你允许查看项目总用量的 Supabase Auth User UUID。若要授权多个账号，用英文逗号分隔多个 UUID。

当前登录账号的 UUID 会显示在网页「偏好与数据 → 跨设备云同步 → 当前账号」区域。

Supabase Edge Functions 会提供服务端 API URL 和密钥环境变量，`@supabase/server` 会读取这些环境变量。请勿将 Secret Key / service_role key 复制到网页、`sync-config.js` 或 GitHub Pages。Edge Function 的 `supabaseAdmin` 只在服务端运行。

## 4. 发布网页端

把更新后的 `app.js`、`sync-client.js`、`styles.css` 和原有网页文件发布到 GitHub Pages。使用已加入白名单的账号登录后，打开「偏好与数据 → 跨设备云同步」，容量监控会首次查询，并在设置页保持打开时每 60 秒刷新一次；也可以手动刷新。

## 5. 指标口径

- **PostgreSQL 数据库**：按 Supabase 文档推荐的 `pg_database_size` 对项目数据库求和，包含数据及索引等数据库对象；属于即时 SQL 估算。
- **学习工作区表**：`embedded_learning_workspaces` 表及其索引/TOAST 占用，用于单独观察学习站工作区数据量。
- **Supabase Storage**：对 `storage.objects.metadata->>'size'` 求和，统计当前对象文件总量和数量。
- 页面默认以 Free Plan 的 500 MB 数据库大小、1 GB Storage 作为参考线；若套餐不同，请以 Dashboard 的额度为准。
- 数据库大小、磁盘空间和服务器 RAM 是不同指标。本监控显示的是数据库/对象存储容量，不显示 Postgres RAM 使用量，也不代替 Supabase Dashboard 的计费报表。

如果页面显示 401，先确认函数 `verify_jwt` 已开启且网页端登录有效；显示 403，检查 UUID 白名单；显示 503，配置 `USAGE_MONITOR_ALLOWED_USER_IDS`；显示 500，重新执行 SQL 并确认函数已成功部署。
