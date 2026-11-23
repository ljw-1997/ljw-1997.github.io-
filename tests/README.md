# V20.4 工程回归测试

本目录使用 Node.js 内置测试运行器，不需要安装 npm 依赖：

```bash
node --test tests/*.test.cjs
```

当前测试覆盖工作区数据 Schema 与本地损坏恢复分支、关键 Supabase SQL 契约、revision compare-and-swap 同步条件、Storage 私有 Bucket/用户目录策略、Base64 附件迁移及恢复保护代码路径。

V20.3 覆盖了真实字节上传进度回调、可访问进度 UI 和「我的学习站」品牌文案。V20.4 新增动效契约检查，覆盖弹窗关闭过渡与快速重开保护、移动端侧栏、Toast、图片预览和减少动态效果偏好。这些是无需真实 Supabase 项目的静态/单元级检查，不替代浏览器端交互测试、真实账号 RLS 验证或两台设备的端到端同步测试。RLS 手工检查步骤见 `supabase/tests/workspace-rls-smoke-test.sql`。

- `motion-polish.test.cjs`：弹窗开合、快速重开、侧栏、Toast、图片预览和减少动态效果偏好的动效契约检查。
