# 嵌入式学习站 · Embedded Learning Station

**当前版本：V20.0（数据安全与持久化基础加固）**

一个无需构建步骤的中文嵌入式学习工作台，可直接部署到 GitHub Pages。网站使用原生 HTML、CSS 和 JavaScript；本地数据保存在浏览器中，可选接入 Supabase Auth 与 PostgreSQL 实现跨设备同步。

## 功能概览

- **学习总览与学习地图**：14 个内置学习模块、133 个知识单元；支持自定义课程、阶段和课时。
- **每日记录**：记录学习过程，支持列表、详情和日历视图。
- **我的知识库**：创建、编辑、分类和放大阅读知识卡片；富文本支持标题、字体、字号、颜色、高亮、列表、表格、代码块、图片和附件；ZIP 附件兼容不同浏览器返回的 MIME 类型；移除应用层的单文件、媒体总量、Data URL 字符长度及图片像素尺寸限制。
- **资源收藏**：收藏外部资料，支持编辑、分类和详情查看。
- **学习进度**：记录课时完成状态、继续学习位置和阅读位置。
- **操作保护**：删除操作提供独立撤销提示，每项有自己的 10 秒时限。
- **阅读体验**：知识卡片阅读宽度可调节，支持 1px 精度、流畅拖动和本地记忆；富文本弹窗采用统一布局。
- **数据管理**：支持完整工作区 JSON 导出和导入。
- **可选云同步**：接入 Supabase 后支持账号登录、跨设备同步及冲突处理。

## 发布到 GitHub Pages

本项目没有 npm 安装、打包或构建步骤。将以下文件放在仓库根目录即可：

| 文件 | 用途 |
|---|---|
| `index.html` | 页面入口 |
| `styles.css` | 页面样式与响应式布局 |
| `app.js` | 课程数据、界面渲染、交互和本地数据处理 |
| `workspace-schema.js` | 工作区运行时 Schema 校验（浏览器与测试共用） |
| `sync-config.js` | Supabase 公共连接配置，可留空 |
| `sync-client.js` | Supabase 登录、云端保存/恢复、冲突处理和容量监控调用 |
| `.nojekyll` | GitHub Pages 静态文件发布标记 |
| `supabase/` | 工作区建表/RLS/Realtime SQL、容量监控 SQL、Edge Function 与安全检查（需部署到 Supabase） |
| `README.md` | 使用说明与版本迭代记录 |

部署步骤：

1. 在 GitHub 创建仓库，将上述文件直接放在仓库根目录。
2. 打开仓库 **Settings → Pages**。
3. Source 选择 **Deploy from a branch**，Branch 选择 `main`，目录选择 `/(root)`。
4. 保存后等待 GitHub Pages 发布完成，通过提供的站点地址访问。

建议使用现代版 Chrome、Edge、Firefox 或 Safari。直接用 `file://` 打开时，部分浏览器会限制 `localStorage`；本地预览建议在工程目录运行：

```bash
python -m http.server 8000
```

随后访问 `http://localhost:8000`。

## Supabase 云同步

云同步是可选功能。不配置 Supabase 时，学习站仍可在当前浏览器本地使用；配置并登录后，工作区数据可在同一账号的多台设备间同步。

1. 在 Supabase Dashboard → SQL Editor 中以数据库管理员身份运行 `supabase/sql/workspace-schema.sql`。脚本会创建 `embedded_learning_workspaces`，配置每用户 SELECT/INSERT/UPDATE RLS 策略，并将表加入 `supabase_realtime` publication。脚本可重复运行。
2. 在 Supabase 的 Project Connect / API Keys 页面获取 Project URL 和 **publishable key**（旧项目的 anon key 仍可使用）。
3. 在网站「偏好与数据 → 跨设备云同步 → Supabase 连接配置」中填写 URL 和 key，保存并登录。
4. 首次迁移本机数据或恢复云端数据时，按页面提示明确选择操作；覆盖数据前建议先导出 JSON 备份。
5. 如需项目容量监控，再按后文说明额外部署 `usage-monitor.sql` 和 Edge Function。

`workspace-schema.sql` 是 V20.0 随包提供的工作区初始化脚本。对于已经有数据的现有项目，执行前应先做数据库备份；脚本会创建表（如果不存在）、补充缺少的状态字段、重建本项目使用的三条 RLS 策略，并确保 Realtime publication 包含工作区表。不要把 `service_role` 或 `sb_secret_...` 密钥写入前端代码、`sync-config.js` 或公开仓库；前端只能使用公开的 publishable/anon key。

如需让新设备自动获得连接地址，可在部署前将默认 Project URL 和公开 publishable key 填入 `sync-config.js`。若留空，则每台设备都可以在网站设置页单独配置。


### Supabase 容量监控（V19 增补）

「偏好与数据 → 跨设备云同步」下方新增项目容量监控：显示 PostgreSQL 数据库总大小、`embedded_learning_workspaces` 工作区表大小、Storage 文件对象总量与文件数。设置页打开时每 60 秒查询一次，也可手动刷新。该显示属于近实时 SQL 估算，不是 Postgres RAM；Supabase Dashboard 的用量报表可能使用不同统计口径和刷新周期。界面默认按 Free Plan 参考值显示数据库 500 MB、Storage 1 GB，套餐不同请以 Dashboard 为准。

启用监控需要额外部署后端组件（仅上传网页文件不会自动启用）：

1. 在 Supabase SQL Editor 以数据库管理员身份运行 `supabase/sql/usage-monitor.sql`。
2. 将 `supabase/functions/usage-monitor/index.ts` 部署为名为 `usage-monitor` 的 Edge Function，并保留 `verify_jwt = true`（配置见 `supabase/config.toml`）。
3. 在 Edge Function Secrets 中设置 `USAGE_MONITOR_ALLOWED_USER_IDS`，值为允许查看项目整体容量的 Auth 用户 UUID。设置页的云端账号信息区域可复制/查看当前 UUID。
4. Edge Function 使用 `@supabase/server` 提供的服务端 `supabaseAdmin` 客户端调用受限 SQL RPC；Supabase 会通过服务端环境变量提供 secret key。若项目使用新 API Keys，SDK 会读取 `SUPABASE_SECRET_KEYS`；使用旧密钥的项目可继续使用 `SUPABASE_SERVICE_ROLE_KEY`。不要把任何 secret key 放进 `sync-config.js`、`app.js` 或浏览器。
5. 将更新后的 `app.js`、`sync-client.js`、`styles.css` 与原有网页文件发布到 GitHub Pages。网页登录已获准的账号后即可查看容量。

安全边界：SQL RPC 已撤销 `PUBLIC`、`anon` 和 `authenticated` 的执行权限，只允许 `service_role` 调用，并以调用者权限运行；Edge Function 再验证真实登录用户并检查 UUID 白名单。不要移除白名单校验或把 `service_role`/secret key 暴露给浏览器。若新增其他授权管理员，应将其 Auth UUID 加入 `USAGE_MONITOR_ALLOWED_USER_IDS`。

## 大型图片与附件说明（V19.2）

V19.2 已移除应用自身设定的 768 KiB 单文件限制、1 MiB 内嵌媒体总量限制、约 2 MB Data URL 字符长度限制、图片 12,000 px 尺寸拦截，以及 12 MiB JSON 备份导入上限。HTML 安全白名单仍然保留，只允许约定的图片和文档类型，不允许 HTML、SVG、脚本等主动内容作为附件。

**这不等于无限容量。** 当前版本仍将图片/附件转换成 Base64 Data URL，嵌入工作区 JSON；本地工作区仍写入浏览器 `localStorage`，登录后整个工作区仍写入 Supabase PostgreSQL 的 `embedded_learning_workspaces.state`。因此，大文件仍会受到浏览器站点存储配额、设备可用内存、Supabase 数据库剩余容量及 API 请求体限制影响；这些内容会占用数据库容量，而不是 Supabase Storage Bucket 容量。若浏览器存储空间不足，页面会提示本次更改未可靠保存，请先导出备份。

若要稳定支持大量或几十 MB 以上的文件，下一阶段应将二进制附件改为 Supabase Storage 对象，并在数据库只保存对象路径和元数据；单纯移除前端限制不能突破浏览器或 Supabase 平台配额。

## 本地工作区校验与恢复（V20.0）

应用启动时会对本地工作区执行结构校验。若 JSON 无法解析或关键字段不符合 Schema，页面会进入只读恢复保护模式：不会把临时初始数据写回 `localStorage`，也会暂停云同步，避免把空白工作区上传并覆盖原始数据。

建议恢复顺序：

1. 在恢复页面点击「下载原始本地数据」，先保存浏览器中读取到的原始内容（即使 JSON 已损坏也会原样导出）。
2. 选择最近一次由本应用导出的 JSON 备份。导入内容会先进行严格结构校验，再写入本地存储。
3. 只有在确认已有原始数据副本、且决定放弃损坏工作区时，才使用「初始化空工作区」。有有效原始数据时，页面会要求先导出后才能执行重置。

如果浏览器完全拒绝访问 `localStorage`，恢复页仍允许导入备份；但是否能完成恢复取决于浏览器是否恢复了站点存储权限。

## 数据保存与备份

- 未启用云同步时，课程编辑、完成状态、知识卡片、资源收藏、每日记录和个人偏好保存在当前浏览器的本地存储中。
- 阅读宽度等纯界面偏好独立保存在当前浏览器，不影响工作区数据。
- 启用 Supabase 并完成账号关联后，工作区数据会按同步状态上传到云端。
- 清除浏览器站点数据、重置工作区或使用旧备份覆盖数据前，请先导出完整工作区 JSON，或确认云端同步已经完成。
- 网站代码仓库不包含个人知识卡片种子文件；已有知识卡片属于用户工作区数据，需通过本地存储、云同步或完整 JSON 备份保留和迁移。

## 基础测试（V20.0）

需要 Node.js 18 或更高版本，无需安装 npm 依赖：

```bash
node --test tests/*.test.cjs
```

测试覆盖工作区 Schema、本地损坏数据恢复分支、工作区 SQL/RLS/Realtime 契约、revision compare-and-swap 关键条件，以及恢复保护代码路径。它们属于本地静态/单元级检查，不替代真实 Supabase 项目的 RLS 登录态测试或多设备端到端测试。部署后可按 `supabase/tests/workspace-rls-smoke-test.sql` 对真实 Auth 用户执行 RLS 可见性检查。

## 安全与隐私

- 不要将个人学习数据、工作区备份、账号密码或 Supabase 私密密钥提交到公开仓库。
- `sync-config.js` 只允许存放公开 publishable/anon key，不能放置 `service_role` 或 secret key。
- GitHub Pages 是静态托管；仓库公开时，仓库中的 HTML、CSS、JavaScript 和配置文件都可被访问。
- 退出云同步账号不会自动清除当前浏览器缓存；共享设备使用后应主动管理本地站点数据。

## 版本迭代记录

以下只保留产品功能演进摘要，不在工程中保留历史截图、旧版报告或每轮测试产物。

| 版本 | 主要变化 |
|---|---|
| V1 | 建立学习工作台基础：学习总览、学习地图、每日记录、资源收藏和个人知识库。 |
| V2 | 深化工程结构、学习内容、安全清洗和数据备份能力。 |
| V3 | 完善删除撤销、移动端导航与编辑工具图标。 |
| V4 | 优化富文本工具栏布局，并让工具状态跟随当前文字格式。 |
| V5 | 修复编辑工具重叠、文字截断、空白区域和弹窗外点击关闭行为。 |
| V6 | 完善弹窗固定头尾、课程阅读位置记忆、富文本格式持久化和代码块显示。 |
| V7 | 统一弹窗三段式结构；每次删除使用独立撤销提示和独立 10 秒期限。 |
| V8 | 统一知识卡片、课程和课时富文本编辑弹窗的尺寸与工具栏规范。 |
| V9 | 将个人计算机知识整理成 23 张卡片并加入知识库；知识内容作为工作区数据保存。 |
| V10 | 增加知识卡片阅读宽度调节、本地记忆和默认宽度恢复。 |
| V11 | 使用绘制帧合并宽度更新，提升拖动流畅度并减少存储写入。 |
| V12 | 调整宽度控制器的固定定位。 |
| V13 | 将宽度控制器移入阅读弹窗底部操作栏，并完善窄屏布局。 |
| V14 | 清理网页中的内部导入、审校和阶段性过程文案。 |
| V15 | 移除知识卡片种子文件和自动导入代码，避免在工程中保留个人知识内容副本。 |
| V16 | 生产工程精简：移除测试脚本、数据库 SQL/测试目录、历史截图、旧版报告和冗余代码快照；统一使用本 README 记录版本历史。 |
| V17 | 修复手机与电脑多端同步回声：远端应用写入不再触发本地上传；工作区指纹采用稳定序列化；相同内容的新 revision 只确认版本、不重复弹窗；Realtime 订阅按账号复用，避免反复重连和重复事件。 |
| V18 | 修复接收端同步时被强制带回首页的问题；保留当前页面、学习地图中的课程/课时位置、筛选与滚动位置；有未提交表单或正在编辑时不重绘界面，避免同步刷新覆盖输入中的内容。 |
| V19（容量监控增补） | 在设置页增加数据库与 Storage 容量监控；通过带用户白名单的 Edge Function 调用受限 SQL RPC，浏览器不接触服务端密钥。 |
| V19.1（ZIP 附件兼容修复） | 识别 `application/x-zip-compressed`、`application/x-zip`、`multipart/x-zip` 及无 MIME 但扩展名为 `.zip` 的文件；统一写入 `application/zip` Data URL，避免保存时被 HTML 白名单清洗。 |
| V19.2（解除应用层媒体大小限制） | 移除单文件、总媒体、Data URL 长度、图片像素尺寸与 JSON 备份导入的应用层固定上限；明确提示浏览器本地存储和 Supabase 数据库仍有平台配额。 |
| V20.0 | 加入工作区严格 Schema 校验；本地 JSON 损坏时进入只读恢复保护模式并保留原始数据导出入口；恢复期间阻止本地保存和云同步；补充 Supabase 工作区建表、每用户 RLS 与 Realtime 初始化 SQL；新增 Node 内置测试及 RLS 手工烟雾测试。 |

---

**项目类型：** 静态 HTML/CSS/JavaScript 应用，无构建步骤。  
**当前发行版本：** V20.0 · Workspace Data Safety Baseline
