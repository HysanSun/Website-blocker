# HANDOFF — Website Blocker

> **读者：接手这个仓库的下一个 AI 会话。**
> 读完这一份就够，不需要从 git log 反推设计意图。第 4 节是重点，那里有两条
> 「看起来合理但会重新引入 bug」的改动，动手前务必先看。

---

## 0. 这是什么

一个 Chrome Manifest V3 扩展，单人自用的「严格自律」工具：把指定网站/关键词彻底
拦死，可选给某些站点设每日使用时长上限，并维护一个连续坚持天数（streak）计数。

- 作者：Hysan Sun，个人项目（不是团队项目，没有 CI、没有 issue tracker）
- 用户沟通语言：中文
- 目录：`D:\软件项目\Blocker`

注意一处不一致：`manifest.json` 里 `version` 是 `1.7.2`，但代码注释和页面角标都写
`v2.0`。用户没有澄清过该以哪个为准，改版本号前先问。

## 1. 怎么跑

**没有构建步骤、没有 `package.json`、没有任何依赖。** 纯静态文件。

1. `chrome://extensions` → 打开「开发者模式」
2. 「加载已解压的扩展程序」→ 选本目录
3. 改完代码后，点扩展卡片上的刷新按钮

调试入口：扩展卡片的「Service Worker」链接开 background 的 DevTools；
popup 右键「检查」；`chrome://extensions` 页面本身的报错容易漏掉，要主动看。

## 2. 文件地图

| 文件 | 角色 | 动它算改前端？ |
|---|---|---|
| `background.js` | Service Worker：DNR 规则同步、时长统计、streak 完整性、alarm | 否（逻辑层） |
| `content.js` | 内容脚本，`document_start` 注入的第二道防线 | 否 |
| `blockpage.html` | **双用途**：既是 popup 也是拦截落地页 | **是** |
| `streaks.js` | popup 的逻辑（streak 显示、快速添加、reset 按钮） | 半（见下） |
| `settings.html` / `settings.js` | 设置页，管理 block / timed 规则 | 是 |
| `manifest.json` | MV3 清单 | 否 |
| `test/streak-harness.js` | streak 逻辑的验证 harness（见第 5 节） | 否 |
| `streaks-back.js`、`manifest-back.json`、`maniback up.json` | 历史遗留备份，**已不参与运行** | — |

**`blockpage.html` 一个文件两种形态**：靠 `@media (min-width: 400px)` 切换 ——
popup 宽度 350px 走窄版，被重定向到整页时（宽度 > 400px）走卡片版并显示被拦提示。
改样式时两个形态都要看。

## 3. 架构要点

- **三道防线**：① DNR 动态规则重定向到 `blockpage.html`；② `content.js` 在
  `document_start` 再查一遍；③ 时长超限时由 background 主动改标签页 URL。冗余是
  故意的，别以为是重复代码就删一层。
- **规则存 `chrome.storage.sync`**，键 `blockedItems`：`{ val, mode, type, limitMin? }`。
  `mode`: `'website' | 'keyword'`；`type`: `'block' | 'timed'`。
- **用量存 `chrome.storage.local`**，键 `dailyUsage`，形如 `{ '2026/9/27': { 'bilibili.com': 1234567 } }`。
  日期键来自 `new Date().toLocaleDateString('zh-CN')`。
- **DNR 规则 ID 分配**：普通拦截从 `1` 起；timed 从 `TIMED_RULE_ID_OFFSET`（2000000）
  加规则下标起，靠这个区间区分两类规则（`>= OFFSET` 即 timed）。
- **三个 alarm**：`heartbeat`(1min)、`tracking`(1min)、`dailyReset`(24h，00:01)。
- **`storage.sync` 有配额**（约 8KB/项、100KB 总量），规则本身很小，但别往 sync 写用量。

**MV3 注意事项**：Service Worker 空闲约 30s 就被回收，**顶层代码每次 worker 启动
都会重跑**。所以写在顶层的代码必须幂等 —— 这是 `initialize()` 现在有 `initialized`
守卫的原因（重复执行会重建 alarm 并重置 alarm 周期）。新增顶层逻辑时注意同样问题。

## 4. streak 系统 —— 核心，动手前必读

### 4.1 数据与显示

- 唯一状态是 `chrome.storage.local` 里的 `startDate`（时间戳）。
- 显示值在 `streaks.js` 的 `updateStreak()`：
  `floor((Date.now() - startDate) / 86400000)` —— 即**从 startDate 起经过的整天数**。
- `needsAlert`（storage.local）：后台清零时置 `true`，popup 打开时读它并弹
  "STRIKE DETECTED"，然后清掉。见 `streaks.js` 的 `checkIntegrity()`。
- popup 里的 Reset 按钮（`streaks.js` 的 `resetStreak()`）会写 `startDate` 和
  `lastHeartbeat`，**但不设 `needsAlert`**（手动重置不该弹「被抓到」提示）。

### 4.2 语义（用户明确拍板，不要自作主张改）

streak **只**被这三件事清零：

1. 扩展被关掉再打开
2. 用户撤销扩展的站点访问权限（`<all_urls>`）
3. 用户手动按 Reset Streak

**其余一切都不许清零。** 包括：浏览器重启、关机、休眠、Service Worker 被回收、
alarm 抖动、扩展 reload/更新、popup 打开关闭。

### 4.3 判定机制（`background.js` 的 `verifyStreakIntegrity()`）

依据是这三条已查证的 Chrome 行为：

| 事件 | Chrome 实际行为 |
|---|---|
| 关扩展 → 再打开 | **不触发任何生命周期事件**，且 `storage.session` 被清空 |
| 浏览器启动 | 触发 `onStartup` |
| reload / 版本更新 | 触发 `onInstalled`，`reason === "update"` |
| SW 被回收后唤醒 | `storage.session` **存活**（内存态，不受影响） |
| 电脑休眠 | `storage.session` 存活 |

所以：`storage.session` 里的 `swAlive` 标记 = 「这是同一次扩展生命周期内的唤醒」。
标记没了 + 又没有 `onStartup`/`onInstalled` ⇒ 只能是「被关掉过」⇒ 清零。
真机行为的来源见第 6 节的参考链接。

### 4.4 两条禁令 ⚠️

**① 绝对不要重新引入「基于时间差」的重置。**

原始 bug 就是 [在这里]：心跳 alarm 周期 60s，而判定写成 `gap > 61000` 才 1 秒余量。
Chrome 的 alarm 精度很差，加上 SW 回收、休眠、浏览器重启，gap 经常超 61s，
于是 streak 每几分钟被清零一次；而显示值是「经过的整天数」，所以它**永远显示 0**。

如果你（下一个 AI）想「顺手加个存活性检查」，请先读这一段：任何
`now - lastHeartbeat > X` 形式的重置都会重现这个 bug。`heartbeat()` 现在只写
时间戳并打日志，**刻意不碰 `startDate`**，这是有意为之，不是漏写。

**② 绝对不要把 `chrome.permissions.contains(...) === false` 直接当成篡改。**

Chrome 对**全新安装**的扩展，默认把 `<all_urls>` 站点访问设为
"when you click the extension"，此时 `contains()` 返回 `false`。直接据此清零会导致
**每次全新安装都误报一次 STRIKE DETECTED**（harness 的 S9 就在守这个）。

正确做法是只在 **true → false 跳变**时清零：用 `hadHostAccess` 记录上次已知的授权
状态，对比后判断（见 `verifyStreakIntegrity()` 里的注释）。

### 4.5 涉及的存储键

| 键 | 区域 | 含义 |
|---|---|---|
| `startDate` | local | streak 起点，**唯一权威状态** |
| `lastHeartbeat` | local | 仅诊断用，不再参与任何判定 |
| `needsAlert` | local | 待 popup 展示的「被抓到」提示 |
| `hadHostAccess` | local | 上次已知的 `<all_urls>` 授权状态 |
| `swAlive` | **session** | 同一次扩展生命周期的存活标记（内存态） |

## 5. 测试

仓库里唯一的测试是这个 harness：`test/streak-harness.js`。

```powershell
node test/streak-harness.js background.js            # 当前版本，应 10/10
```

它用 Node 的 `vm` 模拟真实的 MV3 Service Worker 生命周期：跨「worker 生命周期」
持久化的 storage（`local` / `session` / `sync` 分别按真实语义清空或保留）、
按 Chrome 时序派发 `onStartup` / `onInstalled`、并模拟 `chrome.permissions`
的授权状态。覆盖 10 个场景，包括休眠、浏览器重启、reload、关扩展、
权限撤销、全新安装默认权限。

**它的价值在于「会失败的对照」**。改 streak 逻辑前，先用修复前的版本跑一遍确认
harness 还有区分度：

```powershell
git show 1f3dc96:background.js > $env:TEMP\baseline.js   # 1f3dc96 = 修复前的快照
node test/streak-harness.js $env:TEMP\baseline.js        # 应 5/10，失败项即「不应清零却清零」
```

如果你改了逻辑后两个版本都是 10/10，说明 harness 已经失去区分度，**别就此认为
改动是安全的** —— 去补一个会在旧版本上失败的新场景。

harness 只覆盖 streak 这一块。DNR 规则、时长统计、拦截本身**没有任何自动化测试**，
只能手动在浏览器里验。

## 6. 参考（设计依据，非必须重读）

- `storage.session` 生命周期（关扩展/reload/重启清空，SW 回收存活）：
  https://developer.chrome.com/docs/extensions/reference/api/storage
- Chrome 在 disable→enable 时不触发任何事件、reload 报 `onInstalled:update`：
  https://github.com/w3c/webextensions/issues/926
- `chrome.permissions` 的 `contains()` 无需在 manifest 声明：
  https://developer.chrome.com/docs/extensions/reference/api/permissions
- 新装扩展 `<all_urls>` 默认 "on click"：
  https://github.com/interledger/web-monetization-projects/issues/2894

## 7. 当前状态与未决事项

### git

仓库是本次工作新建的，`user.name/email` 只配在 **local**（没动全局配置）。

| commit | 内容 |
|---|---|
| `1f3dc96` | 修复前的完整快照 —— **harness 的对照基线** |
| `81abc1d` | streak 修复：只在「关扩展」和「手动重置」时清零 |
| `22827b2` | 补上第三条：撤销站点访问权限时清零 |

### 已确认未做的事

- **前端一行未动**：用户明确要求「不要改前端页面」，本次改动全在 `background.js`。
  `blockpage.html`、`streaks.js`、`settings.*` 保持原样。
- `streaks.js` 的 `resetStreak()` 没有清 `needsAlert`，也没记 `hadHostAccess`。
  不影响正确性（后台每次启动都会重算），但如果以后 popup 要展示更细的状态，
  从这里入手。

### 已知限制（都是有意接受，不是遗漏）

1. **权限撤销有最多约 60 秒延迟才清零**：检测发生在 worker 启动时
   （`verifyStreakIntegrity` 在 `initialize()` 完成后延迟 1500ms 执行），
   而 worker 靠 alarm 每分钟至少启动一次。对以「天」为单位的计数无所谓，
   但撤销权限后立刻开 popup 可能还看到旧值。
   想做到即时，需要加 `chrome.permissions.onRemoved` 监听 —— 但**该事件对
   「站点访问」这类 UI 改动是否触发，未查到确定结论**，当时不想依赖未验证的行为
   所以没加。要加的话请先用 harness 补一个场景守住它。
2. **`heartbeat` alarm 现在是冗余的**：它做的事（写时间戳、打日志）和 `tracking`
   alarm 的唤醒节奏完全重合，只为保留诊断信息而留着。想省电可以删掉整个 alarm +
   `lastHeartbeat` 键。
3. **disable 检测是 Chrome 专属语义**：Firefox/Safari 在 enable 时的行为不同
   （Safari 会触发 `onInstalled:install`）。当前 manifest 只针对 Chrome，没问题；
   若以后要跨浏览器，第 4.3 节的判定必须重做。

### 建议的下一步（用户未要求，仅备选）

- 用第 6 节的思路给「权限撤销」加即时检测（需先解决限制 1 的验证问题）
- 给 DNR / 时长统计补自动化测试（目前是零覆盖）
- 统一 `1.7.2` vs `v2.0` 的版本号表述（**先问用户以哪个为准**）
- 清理 `streaks-back.js` / `manifest-back.json` / `maniback up.json` 三个历史备份
  （**先问用户**，它们可能有留存意图）
