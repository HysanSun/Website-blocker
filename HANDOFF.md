# HANDOFF — Website Blocker

> **读者：接手这个仓库的下一个 AI 会话。**
> 读完这一份就够，不需要从 git log 反推设计意图。第 4 节是重点，那里有两条
> 「看起来合理但会重新引入 bug」的改动，动手前务必先看；番茄钟和 Todo 见第 8 节。

---

## 0. 这是什么

一个 Chrome Manifest V3 扩展，单人自用的「严格自律」工具：把指定网站/关键词彻底
拦死，可选给某些站点设每日使用时长上限，并维护一个连续坚持天数（streak）计数。

- 作者：Hysan Sun，个人项目（不是团队项目，没有 CI、没有 issue tracker）
- 用户沟通语言：中文
- 目录：`D:\软件项目\Blocker`

版本号：`2.0.1`（`manifest.json`），页面角标仍是 `v2.0`。加番茄钟时问过用户该以哪个
为准，他选了「统一为 2.0.0」；后来用户要靠版本号判断 `chrome://extensions` 的 reload
到底有没有生效，才升到 `2.0.1`。**下次改版本号前仍然先问。**

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
| `pomodoro.html` | 番茄钟 + Todo 的独立窗口页（计时器 / 任务 / 番茄钟设置都在这） | 是（新页面） |
| `pomodoro.js` | `pomodoro.html` 的 UI 逻辑 | 否 |
| `pomodoro-entry.js` | 跑在 `blockpage.html` 上的两个入口：顶栏 ⏱、被拦整页状态行 | 半 |
| `manifest.json` | MV3 清单 | 否 |
| `test/streak-harness.js` | streak 逻辑的验证 harness（见第 5 节） | 否 |
| `test/pomodoro-harness.js` | 番茄钟 + Todo 的验证 harness（见第 5 节） | 否 |
| `test/browser-smoke.py` | 真浏览器冒烟测试：真的把扩展装进 Chromium（见第 5 节） | 否 |
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
- **所有改 DNR 规则的入口都走 `withDnrLock()` 串行队列**（`syncAllRules()` /
  `enforceTimeLimit()` / `resetDailyLimits()`）。alarm、tab 事件、消息处理之间 Chrome
  **不做串行化**：两个 `syncAllRules` 重叠时会各自先读到「当前规则集」再各自添加，
  后添加的那个直接抛 `Rule with id 1 does not have a unique ID`；更糟的是「后落地者胜」，
  可能留下过期规则（专注期结束后 timed 站点仍被封）。加新的规则写入口时，必须也走这把锁。
  锁里面，`syncAllRulesNow()` 的「清空 + 安装」是**一次** `updateDynamicRules` 调用
  （`applyDynamicRules()`），中间没有窗口；万一还是有别的写者插进来（例如 reload 时
  正在被销毁的旧 worker 落下最后一笔），会重读旧集合并重试一次，而不是直接报错收工。
  写之前还会按 id 去重；报错日志会带上「想写的 id / 当时磁盘上的 id」，便于定位。
  启动日志用 `chrome.runtime.getManifest().version` 打印版本，控制台能自证是哪个构建。
- **alarm**：`heartbeat`(1min)、`tracking`(1min)、`dailyReset`(24h，00:01)，
  外加番茄钟的一次性 `pomodoroPhase`（见 8.3）。
- **番茄钟 / Todo 用另外三个键**（`pomodoro` / `pomodoroSettings` / `todo`），见第 8 节。
  番茄钟规则走独立 ID 段 `1500000+`，它**必须低于** `TIMED_RULE_ID_OFFSET`。
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

仓库里有两个 harness：`test/streak-harness.js`（streak）和 `test/pomodoro-harness.js`
（番茄钟 + Todo，见第 8 节）。两者都靠 Node 的 `vm` 起一个假的 MV3 环境。

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

`test/pomodoro-harness.js` 用同一套骨架，另外加了**可注入的假时钟**（锚在当天
12:00，避免跨午夜把「快进几小时」变成跨天）和 `chrome.action` / `chrome.notifications` /
真实记账的 DNR 桩：

```powershell
node test/pomodoro-harness.js background.js        # 当前版本，应 17/17
```

覆盖 17 个场景：正常到期/长休/挂钟语义不级联、worker 回收、暂停与跳过、`disable→enable` 作废该段、跨天清零、专注期封死 timed 且退出后按真实用量恢复、任务缺失、陈旧转换不发通知、
启动重新 arm、并发 tick 只记一次，外加四条回归护栏——P13「`chrome.notifications` 不存在时
worker 必须照样活着」、P14「`manifest.json` 必须把 `blockpage.html` 列进
`web_accessible_resources`」、P15「并发的规则同步不能撞 ID」、P16「一波并发同步不能留下
过期规则集」、P17「写入途中被外部规则插队的冲突要被吞掉并重试，不能只报个错、留下半套规则」。
它同样保留「会失败的对照」习惯：故意改坏一处必须掉分。

两个 harness 都跑在 Node 的 `vm` 里，**从不真正加载扩展**，所以抓不到「worker 在注册
任何东西之前就崩了」这一类事故。为此另有一个真浏览器冒烟测试：

```powershell
pip install playwright
playwright install chromium
python test/browser-smoke.py            # 当前版本，应 8/8；拦截那一条要能访问 example.com
```

它真的把扩展装进 Chromium（必须 `headless=False`，headless shell 不支持扩展），依次验证：
worker 存活、计时器真的倒数、加的任务进了 storage、被拦站点重定向到 `blockpage.html`，
并且**service worker 控制台一条 error 都没有**（DNR 规则冲突就是在这里现形的）。它还会
打印 `chrome.runtime.getManifest().version` —— 用来确认 reload 是否真的换上了新代码。
对照：把 `manifest.json` 的 `web_accessible_resources` 删掉再跑，拦截那条必然 FAIL。

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
| `503efef` | 加 HANDOFF.md / CLAUDE.md / streak harness |
| `ff4ac41` | 番茄钟 + Todo（独立窗口版），见第 8 节 |
| `e14a4fb` | 修 worker 启动即崩（8.8-4）与拦截重定向失效（8.8-5），补 P13/P14 与真浏览器冒烟测试 |
| `9d6fbac` | DNR 规则写入串行化（见第 3 节），补 P15/P16 |
| `85d98c9` | 规则写入改成原子更新 + 冲突重试（见第 3 节），补 P17 |
| `ba8b95c` | 版本升到 `2.0.1`（用来判断 reload 是否生效）+ 失败日志带上 id，冒烟测试盯 worker 控制台 |

### 已确认未做的事

- **streak 那次的改动前端一行未动**：全在 `background.js`。番茄钟那次（第 8 节）对
  `blockpage.html` 只有两处增量：顶栏加一个 ⏱ 图标、被拦整页加一行状态行。
  `streaks.js`、`settings.html`、`settings.js` 至今仍是原样（用户要求不改变原有布局）。
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
- 给 DNR 的实际拦截效果 / 时长统计补自动化测试（规则集合已有 harness 覆盖，端到端仍无覆盖）
- ~~统一 `1.7.2` vs `v2.0` 的版本号表述~~ —— 已完成，统一为 `2.0.0`
- 清理 `streaks-back.js` / `manifest-back.json` / `maniback up.json` 三个历史备份
  （**先问用户**，它们可能有留存意图）

## 8. 番茄钟 & Todo（独立窗口版）

### 8.1 界面与入口

- 全部 UI 在独立窗口页 `pomodoro.html`：计时器、任务清单、番茄钟设置都在这一个页面里。
  `pomodoro.js` 是它的逻辑，秒级 `setInterval` **只允许出现在这类普通页面**里。
- `pomodoro-entry.js` 跑在 `blockpage.html` 上，只做两件事：顶栏 ⏱ 按钮打开窗口、
  被拦整页显示「Focus in progress · MM:SS」或「Start a focus session」。
  它被包在 IIFE 里 —— 要和 `streaks.js` 共享全局作用域，不能撞名。
- 窗口是单例：先 `chrome.windows.getAll({populate:true})` 找已存在的页面并聚焦，
  没有才新建 460x660。
- **`streaks.js`、`settings.html`、`settings.js` 一行未动**。用户要求「不要改变原有界面
  布局」，所以番茄钟设置内嵌在自己的页面里，没往设置页加卡片；`blockpage.html` 只多了
  顶栏一个图标和整页一行状态。

### 8.2 存储

| 键 | 区域 | 含义 |
|---|---|---|
| `pomodoro` | local | 运行态：`phase` / `endAt` / `pausedRemainingMs` / `cycleDone` / `dayKey` / `focusToday` / `focusMsToday` / `taskId` / `strictNow` |
| `pomodoroSettings` | sync | 配置：三段时长、长休间隔、两个自动开始开关、`focusBlocksTimed` |
| `todo` | local | `{v, tasks:[{id,text,done,createdAt,doneAt,pomodoros,focusMs}]}`，数组顺序即显示顺序 |

### 8.3 计时机制

- **唯一权威是 `endAt` 时间戳**，剩余时间每次都用 `endAt - now` 求值。background
  **不跑 `setInterval`**：一个一次性 alarm `pomodoroPhase`（`when: endAt`）负责准点，
  已有的 `tracking` alarm（1min）兜底，`initialize()` 负责启动时的权威对齐。
- 到期语义是**挂钟语义**（用户拍板）：`now >= endAt` 就算这一段完成，哪怕晚了三小时。
  风险由两条硬约束兜住：**一次 tick 只推进一个相位**，且**新相位的 `endAt` 从 `now`
  重算**（不继承旧截止时间）。所以关机三小时回来只记 1 段，绝不级联。
- `skip` / `stop` / `pause` 都不记账；`pause` 把剩余冻进 `pausedRemainingMs` 并清 `endAt`。
- **`pomodoroBusy` 是防重入的**：popup 的秒级 tick 和 alarm 可能重叠，缺了它就会重复
  记账、重复发通知（harness 的 P12 守这一条，故意删掉会掉分）。
- 休眠/关机后一次性 alarm 不保证还在，所以**启动时永远从 `endAt` 重新对齐并重新 arm**，
  不要往这条路径上加内存态假设。alarm 晚到最多约 1 分钟，这是有意的（`tracking` 兜底）。

### 8.4 与拦截系统的耦合

- `strictNow = (phase === 'focus' && settings.focusBlocksTimed)`，由 background 写进 local
  的 `pomodoro` 状态；`syncAllRules()` 和 `content.js` 都读它。**暂停不解锁**（暂停也算还在
  专注期），只有 `stop` / `skip` 才离开。
- 专注期里 `syncAllRules()` 给每个 timed 站点直接注册规则，**不看当天用量**；离开专注期时
  整表重算，恢复成「按真实用量判断」。所以**真正超限的站点会继续被封**——不要改成
  「退出专注期就删掉番茄钟规则」，那会误放超限站点。
- 番茄钟规则的 ID 段是 `POMODORO_RULE_ID_OFFSET = 1500000`，**必须低于
  `TIMED_RULE_ID_OFFSET`（2000000）**：`enforceTimeLimit` / `resetDailyLimits` 用
  `id >= TIMED_RULE_ID_OFFSET` 筛 timed 规则，落进那个范围的番茄钟规则会被误删。
- 专注期被重定向到拦截页的标签页**不会自动回跳**，需要刷新（整页会显示倒计时）。

### 8.5 通知与 badge

- badge 免权限：专注期显示剩余分钟 + 橙色，休息期绿色，idle 清空。精度受 1 分钟 alarm
  限制，最多滞后约 1 分钟。
- 系统通知走 `permissions: ["notifications"]`（用户要求直接要权限，不走 optional）。
  **只有 `now - endAt <= POMODORO_NOTIFY_MAX_LATE_MS`（2 分钟）才发**，避免休眠/关机后
  补发陈旧通知。注意：这条迟到判断**只管通知**，不影响记账。

### 8.6 Todo

- 未完成的任务跨天保留；已完成进 Done 区按 `doneAt` 倒序，**不自动清理**，只有
  「Clear completed」会删。今日完成数由 `doneAt` 派生，不单独存储。
- 专注自然完成时，若 `taskId` 指向的任务还在，就 `pomodoros+1`、`focusMs += 名义时长`；
  找不到就跳过（不报错）。任务在中途被勾完成仍照记。
- 每行操作：▶（以该任务启动一段专注）、勾选完成、双击改名、上移/下移、删除。**不引入拖拽**。

### 8.7 验证

见第 5 节：`node test/pomodoro-harness.js background.js`（应 17/17），以及
`python test/browser-smoke.py`（应 8/8，真浏览器）。

### 8.8 别踩的坑

1. **不要**在番茄钟代码里读写 `startDate` / `needsAlert` / `hadHostAccess` / `swAlive`。
   唯一的例外是一次**单向**调用：`breakStreak()` 里会 `pomodoroStop()`（扩展被关掉或
   站点访问权限被撤销 ⇒ 这一段的拦截保证已经不存在 ⇒ 该段作废）。番茄钟从不反向读
   streak 状态。
2. 8.3 的「挂钟语义 + 迟到判断」是**计时器语义**，与 4.4 禁令禁止的「按心跳间隔重置
   streak」是两件事。看到 `lateMs` / `POMODORO_NOTIFY_MAX_LATE_MS` 不要以为踩了 4.4 的雷，
   也不要「顺手统一」成同一套逻辑。
3. 别把秒级 `setInterval` 搬进 `background.js`。
4. **别在 `background.js` 顶层直接摸 `chrome.*` 的命名空间。** `chrome.notifications`
   在权限真正授予之前是 `undefined` —— 而「往 manifest 里加了权限之后 reload 一个未打包
   扩展」并不会授权。曾经顶层有一句 `chrome.notifications.onClicked.addListener(...)`，
   它一抛错，**它之后的顶层语句全都不执行**（message handler、alarm handler、
   `initialize()`、tabs 监听），症状就是「计时器不动、任务加不了、拦截也一起挂」。
   现在统一走 `notificationsAvailable()` 判定，`pomodoroStatus()` 也会回传
   `notifications` 供页面显示提示。harness 的 P13 守着这条。
5. **`blockpage.html` 必须留在 `manifest.json` 的 `web_accessible_resources` 里。**
   Chrome 拒绝对「非 web accessible 的扩展页」做重定向：DNR 的 `extensionPath` 重定向和
   `content.js` 里的 `location.href = getURL('blockpage.html')` 都会变成
   `ERR_BLOCKED_BY_CLIENT`，两层防线同时失效，拦截整个不可用。已在 Chromium 153 与 Edge
   上实测（v1.7.2 起就一直是坏的）。harness 的 P14 守着这条。
