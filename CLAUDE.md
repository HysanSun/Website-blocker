# Website Blocker — 项目须知

Chrome MV3 扩展，无构建步骤、无依赖。开发时在 `chrome://extensions` 加载已解压的扩展。
改完代码需手动刷新扩展。

**动手前先读 `HANDOFF.md`** —— 里面有 streak 系统的完整设计依据、验证方法，
以及两条会重新引入 bug 的改动禁区。

两条最关键的禁区（即使没读全文也请遵守）：

1. **不要引入任何「时间差超过 N 就重置 streak」的逻辑。** 这正是原始 bug：
   心跳 alarm 60s、判定容差 61s，alarm 抖动/休眠/SW 回收都会误清零，
   导致 streak 永远显示 0。
2. **不要把 `chrome.permissions.contains(...) === false` 直接当成篡改。**
   新装扩展的 `<all_urls>` 站点访问默认就是 "on click"（返回 false），
   据此清零会让每次全新安装都误报 STRIKE。只在 true → false 跳变时清零。

改 streak 逻辑后必须跑：`node test/streak-harness.js background.js`（应 10/10），
并确认旧版本仍会失败以证明 harness 还有区分度（见 `HANDOFF.md` 第 5 节）。
