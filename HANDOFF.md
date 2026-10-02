# HANDOFF — Website Blocker

> **读者：接手这个仓库的下一个 AI 会话。**
> 读完这一份就够，不需要从 git log 反推设计意图。第 4 节是重点，那里有两条
> 「看起来合理但会重新引入 bug」的改动，动手前务必先看；番茄钟和 Todo 见第 8 节。

---

## 0. 这是什么

一个 Chrome Manifest V3 扩展，单人自用的「严格自律」工具：把指定网站/关键词彻底
拦死，可选给某些站点设每日使用时长上限，并维护一个连续坚持天数（streak）计数。

- 作者：Hysan Sun。个人项目，没有 issue tracker，也不接受外部 PR 的节奏要求
- CI：`.github/workflows/tests.yml`（GitHub Actions），push / PR 时跑两套 harness +
  `xvfb-run` 下的真浏览器冒烟测试。本地跑法见 README「Development」
- 用户沟通语言：中文
- 目录：`D:\软件项目\Blocker`

版本号：`2.0.2`（`manifest.json`），页面角标仍是 `v2.0`。加番茄钟时问过用户该以哪个
为准，他选了「统一为 2.0.0」；后来用户要靠版本号判断 `chrome://extensions` 的 reload
到底有没有生效，才一路升到 `2.0.2`。**下次改版本号前仍然先问。**

上一轮（2026-09-28 下午）用户报「版本已经是 2.0.2 了，错误卡片还在」。查下来的结论是两件事：
① 那张卡片是**陈旧记录**（错误确实抛过，但抛它的是 2.0.1，reload 不会清掉卡片，见 8.8-6）；
② 真正的功能性事故是 2.0.1 引入、2.0.2 仍在的 `syncAllRulesNow()` catch 里 `items` 越界
引用（见 8.8-7）。两处都已修，**版本号这次没有动 —— 要不要升 `2.0.3` 得先问用户**。

上一轮（2026-09-28 晚）做「计划用量 + run」（见 8.9）：任务可以设
预计单位数，从任务行 ▶ 弹对话框问「这次要跑几个单位 / 全部」，跑完估计单位后系统提问
「任务完成了吗」。**专注期从本轮起不能被 `skip`**（只有休息可以），用户明确要求。
改动只落在 `background.js` / `pomodoro.html` / `pomodoro.js` / `test/pomodoro-harness.js` /
`test/browser-smoke.py`；`streaks.js`、`settings.html`、`settings.js`、`blockpage.html`
依然一行未动。**版本号仍未动，要不要升 `2.0.3` 先问用户。**

本轮（2026-09-29）只加了一条用户拍板的纪律：**一次专注只准暂停一次，且最多 2 分钟**
（`POMODORO_MAX_PAUSE_MS`），超时由 worker 自己把时钟重新走起来；休息期不受限制。
页面还多了一张可折叠的中文 **Manual** 卡片。改动只在 `background.js` / `pomodoro.html` /
`pomodoro.js` / `test/pomodoro-harness.js` / `test/browser-smoke.py`。

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
| `manifest.json` | MV3 清单（名称/简介/快捷键走 `_locales/` 的 `__MSG_*__`） | 否 |
| `ui.js` / `ui.css` | 三个页面共用的反馈层（`WB.toast` / `WB.ok` / `WB.error` / `WB.armButton`） | 半 |
| `offscreen.html` / `offscreen.js` | 只负责响一声的隐藏页（service worker 不能放音频） | 否 |
| `PRIVACY.md` | 隐私声明（数据在哪、权限为什么、怎么删） | — |
| `_locales/` | 扩展名与简介的翻译（en / zh_CN） | — |
| `docs/` | 开发文档，**不随扩展发布**（`docs/legacy/` 放历史备份） | — |
| `test/streak-harness.js` | streak 逻辑的验证 harness（见第 5 节） | 否 |
| `test/pomodoro-harness.js` | 番茄钟 + Todo 的验证 harness（见第 5 节） | 否 |
| `test/browser-smoke.py` | 真浏览器冒烟测试：真的把扩展装进 Chromium（见第 5 节） | 否 |
| `docs/legacy/` | `streaks-back.js`、`manifest-back.json`、`maniback up.json`、`POMODORO-PLAN.md` 四个历史备份，**已不参与运行** | — |

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
- **例外（`!` 开头）走独立 ID 段 `ALLOW_RULE_ID_OFFSET = 1000000`**：`syncAllRulesNow()` 把 `val` 以
  `!` 开头的项变成 `priority: 100` 的 `allow` 规则（重定向规则是 `priority: 10`，最高优先级命中者胜），
  覆盖 `!` 后面那个主机及其所有子域。**设置页不用改** —— 就在同一个输入框里填 `!pan.baidu.com`。
  `trackActiveTab()` 里被例外的 host 既不计用量也不强制；专注期的封禁同样让位（见 8.4）。
- **网站规则的 urlFilter 是 `||host^`，不是 `*://*.host/*` ⚠️**：2026-10-02 在真实 Chromium 里用
  `declarativeNetRequestFeedback` + `testMatchOutcome` 逐条量过，两个差别都很要命：
  ① `*://*.host/*` **不匹配裸域名** —— 规则里写 `baidu.com` 时 DNR 那层对 `baidu.com` 自己不生效，
  一直是靠 `content.js` 第二层兜着才没人发现；② 前导 `*` 不看主机边界，`host.evil.com` 也会被卷进来。
  `||host^` = 裸域名 + 全部子域，且止步于主机边界。`content.js` 的 `hostMatches()` 与它同语义，
  **三处（DNR / content.js / trackActiveTab）必须一致**；查旧代码时别再照抄 `*://*.host/*`。
- **所有改 DNR 规则的入口都走 `withDnrLock()` 串行队列**（`syncAllRules()` /
  `enforceTimeLimit()` / `resetDailyLimits()`）。alarm、tab 事件、消息处理之间 Chrome
  **不做串行化**：两个规则写入重叠时会各自先读到「当前规则集」再各自添加，后添加的那个
  直接抛 `Rule with id 1 does not have a unique ID`；更糟的是「后落地者胜」，可能留下过期
  规则（专注期结束后 timed 站点仍被封）。加新的规则写入口时，必须也走这把锁。
- **规则落盘只有一个写手：`syncAllRulesNow()` → `applyDynamicRules()`。** 配额超限
  （`enforceTimeLimit`）和每日重置（`resetDailyLimitsNow`）**自己不再写规则**：它们只改
  状态（写用量、清零用量）然后调 `syncAllRulesNow()` 重算整张表。规则集永远是「由状态
  推导出来的」，不存在第二个写手和它各写一半的可能。
- **`applyDynamicRules()` 用一次 `updateDynamicRules` 同时删 + 写**，删除列表 =
  `getDynamicRules()` 报出来的 id ∪ 本次要写的 id。两个原因缺一不可：
  ① Chrome 只要发现同 id 的规则还活着就抛 `Rule with id N does not have a unique ID`，
     而 API 报出来的集合和真正活着的集合**并不总是同一套**（2.0.1 就卡在这里，用户机器上
     每次同步都报 id 1 冲突），所以「马上要写的那些 id」必须显式点名删；
  ② 删和写放进同一次调用，Chrome 会把它们原子地一起应用 —— 不会出现「删掉了、写失败」
     导致**规则集被清空、所有站点悄悄放行**的窗口，也不会给别的写手留插队的空隙。
  2026-09-28 在真实 Chromium 里实测过：`{removeRuleIds: [...], addRules: [...]}` 只要
  removed ⊇ added 就永远成功（包括删除列表里有根本不存在的 id、重复执行、`addRules` 为空）；
  只有「删和写分两次调用」才会留下那个窗口。失败会重试 3 次，每次重新读一遍存活集合；
  写之前按 id 去重。报错日志里带「想写的 id / 当时的 id / 规则列表」，错误卡片上直接看得到。
  启动日志用 `chrome.runtime.getManifest().version` 打印版本，能自证构建。
  历史教训：2.0.1 的写法是 `removeRuleIds: stale.map(r => r.id)` —— **只删 API 报出来的 id**，
  漏掉「活着但没被报出来」的 id，于是每次 add 都撞车。别把「马上要写的 id」从删除列表里删掉。
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
git show 098e86e:background.js > $env:TEMP\baseline.js   # 098e86e = 修复前的快照
node test/streak-harness.js $env:TEMP\baseline.js        # 应 5/10，失败项即「不应清零却清零」
```

如果你改了逻辑后两个版本都是 10/10，说明 harness 已经失去区分度，**别就此认为
改动是安全的** —— 去补一个会在旧版本上失败的新场景。

`test/pomodoro-harness.js` 用同一套骨架，另外加了**可注入的假时钟**（锚在当天
12:00，避免跨午夜把「快进几小时」变成跨天）和 `chrome.action` / `chrome.notifications` /
真实记账的 DNR 桩：

```powershell
node test/pomodoro-harness.js background.js        # 当前版本，应 28/28
```

覆盖 28 个场景：正常到期/长休/挂钟语义不级联、worker 回收、暂停与跳过、`disable→enable` 作废该段、跨天清零、专注期封死 timed 且退出后按真实用量恢复、任务缺失、陈旧转换不发通知、
启动重新 arm、并发 tick 只记一次，外加四条回归护栏——P13「`chrome.notifications` 不存在时
worker 必须照样活着」、P14「`manifest.json` 必须把 `blockpage.html` 列进
`web_accessible_resources`」、P15「并发的规则同步不能撞 ID」、P16「一波并发同步不能留下
过期规则集」、P17「写入途中被外部规则插队的冲突要被吞掉并重试，不能只报个错、留下半套规则」、
P18「`getDynamicRules()` 没报出来、但其实还活着的 id 也必须被清掉，否则 add 永远撞车」、
P19「写不进去的规则不能让已经封着的站点被放行（规则集不许被清空），而且这次失败仍然要给
popup 回 `{success:true}`，不能变成挂死的消息端口」、P20「配额超限和每日重置都必须由同一个
写手推导出规则集（超限装规则 + 跳转标签页，重置卸掉配额规则、留下专注期的规则）」。
P21–P25 守着「计划用量与 run」（8.9）：run 会自己走完 N 个单位、在到达估计值时
提问；专注不可 skip 而休息可以；run 短于估计值时安静结束；`done` / `continue` / `later`
三个回答各自的效果；中途 `stop` 让 run 作废且已跑的部分不记账。对照做过：
① 让 run 不再自动续下一段 ⇒ P21/P22/P23 FAIL；② 允许 `skip` 掉专注 ⇒ P5/P22 FAIL；
③ 去掉「估计值不得低于已记单位」的夹取 ⇒ P24 FAIL。

P27/P28 守着「规则的宽度与例外」（2026-10-02 这一轮）：P27 断言 `!pan.testsite.invalid` 生成的是
`priority: 100` 的 allow 规则、filter 是 `||pan.testsite.invalid^`、且 id 落在 1000000 段；
P28 把同一个超配额的 timed 站点跑两遍 —— 一遍带 `!` 例外、一遍不带 —— 断言不带的那遍加了一分钟
并把标签页送去拦截页、带的那遍**一分不加、一次不跳**（这一对本身就是对照）。另外两条对照：
① 只把 `hostUrlFilter()` 改回 `*://*.host/*` ⇒ 冒烟测试掉 4 条，其中
「stays reachable: pan.testsite.invalid」变成 blocked=True，正是用户报的现象；
② 只把 `content.js` 的 `hostMatches()` 改成子串匹配 ⇒ `nottestsite.invalid` 与
`testsite.invalid.evil.invalid` 两条 FAIL。

P5（本轮重写）与 P26 守着「暂停限制」：一次专注只有一次暂停、最多 2 分钟、到点自己恢复、
恢复后这次专注再也不能暂停；休息可以一直暂停，暂停额度在下一次专注时归还。对照做过：
① 让暂停永不到期（`pauseEndsAt = 0`）⇒ P5/P26 FAIL；② 允许第二次暂停 ⇒ P5 FAIL；
③ 暂停期间不重新挂 alarm ⇒ P5 FAIL；④ 相位切换不归还暂停额度 ⇒ P26 FAIL。

它同样保留「会失败的对照」习惯：故意改坏一处必须掉分。P19/P20 的对照做过：
把写入改回「删、写两次调用」⇒ P19 FAIL；让 `enforceTimeLimit` 空转 ⇒ P20 FAIL；
把 `items` 挪回 `try` 里 ⇒ P19 连 harness 都炸（正是线上那个 ReferenceError）。

两个 harness 都跑在 Node 的 `vm` 里，**从不真正加载扩展**，所以抓不到「worker 在注册
任何东西之前就崩了」这一类事故。为此另有一个真浏览器冒烟测试：

```powershell
pip install playwright
playwright install chromium
python test/browser-smoke.py            # 当前版本，应 48/48（example.com 不可达时 46/46，那两条 SKIP）
```

它真的把扩展装进 Chromium（必须 `headless=False`，headless shell 不支持扩展），依次验证：
worker 存活、计时器真的倒数、加的任务进了 storage、被拦站点重定向到 `blockpage.html`、
被拦页顶栏的 ⏱ 按钮真的能开出计时窗口、一波并发 `syncRules` 之后每个被拦站点只剩一条规则，
并且**service worker 控制台一条 error 都没有**（DNR 规则冲突就是在这里现形的）。它还会
打印 `chrome.runtime.getManifest().version` —— 用来确认 reload 是否真的换上了新代码。
本轮又加了两组（`3b`、`7`）：▶ 能打开计划对话框、「All」填满剩余单位、启动后 worker 里
真的留下 `run`、估计值落进任务、专注期 `#skip-btn` 是 disabled；以及提问卡片（往
storage 种一个 `review` 状态再刷新页面）能显示并点名任务、「Not yet」会重开对话框、
「Yes, it's done」把任务归档进 Done、worker 拒绝 skip 专注、休息可以 skip。
「暂停」那一组（本轮）：点 Pause 后冻结剩余时间且 `pauseUsed` 落库、暂停提示里能看到
倒计时、Resume 后按钮变灰且**在鼠标悬停时也看得出是灰的**、再发一次 `pomodoroPause`
也被 worker 拒绝。

**这套脚本里所有跟规则有关的断言都不依赖网络**：`example.com` 只是用来验证「真的会跳转到
`blockpage.html`」那条，`saveRules` 本身在任何情况下都要发。曾经是把 `saveRules` 嵌在
「example.com 可达」的分支里，结果断网时那条 SKIP、规则集一直是空的，后面「一波并发同步
后只剩一条规则」就必挂（`[]`）——2026-09-29 追了半天才定位到是测试自己的问题，不是 DNR 的。
对照：把 `ctx.route("**://example.com/**", abort)` 挂上再跑，旧版 26/27（burst 那条 FAIL），
修好后 36/36。
`3b` 里还有一条「清空输入框再敲 `3` 不能变成 `13`」：计划对话框的两个数字框如果
**在 `input` 事件里无条件回写自己**，用户清空准备重输时值会被顶成 1、光标停在末尾，
接着敲的数字就接在后面。对照：把 `syncPlanDialog()` 改回「无条件回写两个框」⇒
那条 FAIL（`value=13`），并且连带「All」/run/估计值三条一起掉。
最后一组（`8`）守页面上的 **Manual**：默认折叠，点开后里面必须能读到计时设置与
Skip 规则（它就是给用户看的说明书，内容见 `pomodoro.html` 的 `#manual-panel`）。
对照：把 `manifest.json` 的 `web_accessible_resources` 删掉再跑，拦截那条必然 FAIL。

最后一组（`9`，2026-10-02 加）守「规则的宽度与例外」，而且**不依赖网络**：测试用的主机
（`testsite.invalid` 等）都用 `--host-resolver-rules` 指到脚本自己起的那个 HTTP 服务器上，所以
「这个站点没被封」是靠**页面里有没有 marker** 断言的 —— 只看「没跳到 `blockpage.html`」的话，
DNS 解析失败也会算通过。它先用 `testMatchOutcome` 单独问 DNR「裸域名到底有没有命中」（旧的
`*://*.host/*` 在这里返回 `[]`），再真的逐个访问：裸域名 / `www.` / `mail.` 必须被封，
`!` 例外的那个主机及其子域必须能开，`nottestsite.invalid` 与 `testsite.invalid.evil.invalid`
也必须能开。对照见上面 P27/P28 那段的 ①②。

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
| `098e86e` | 修复前的完整快照 —— **harness 的对照基线** |
| `4ecd7b5` | streak 修复：只在「关扩展」和「手动重置」时清零 |
| `7090749` | 补上第三条：撤销站点访问权限时清零 |
| `a250063` | 加 HANDOFF.md / CLAUDE.md / streak harness |
| `b5028bc` | 番茄钟 + Todo（独立窗口版），见第 8 节 |
| `60ed3b1` | 修 worker 启动即崩（8.8-4）与拦截重定向失效（8.8-5），补 P13/P14 与真浏览器冒烟测试 |
| `9e5df05` | DNR 规则写入串行化（见第 3 节），补 P15/P16 |
| `806faa5` | 规则写入改成原子更新 + 冲突重试（见第 3 节），补 P17 |
| `f3099b5` | 版本升到 `2.0.1`（用来判断 reload 是否生效）+ 失败日志带上 id，冒烟测试盯 worker 控制台 |
| `a4793d4` | 删除时显式点名「马上要复用的 id」（第 3 节），版本 `2.0.2`，补 P18 |
| `9bb22a4` | 规则写入改成**一次原子「删+写」**、配额/每日重置不再自己写规则（第 3 节）；修
`syncAllRulesNow()` catch 里 `items` 越界引用（8.8-7）；补 P19/P20 与冒烟测试第 7 项 |
| `90b8e05` | docs：把原子写入与「陈旧错误卡片」的诊断写进本文件 |
| `71cfab6` | 「计划用量 + run」（8.9）：任务的预计单位数、▶ 计划对话框、run 自动续段、到达估计值后提问；**专注期不可 skip**；补 P21–P25 |
| `ebeb92c` | 修计划对话框在 `input` 里回写自己、吃掉用户击键（`3` 变 `13`） |
| `58a45bb` | 把说明书放进 `pomodoro.html` 的 Manual；冒烟测试第 8 组 |
| `bee40e2` | 一次专注只能暂停一次、最多 2 分钟、到点自己恢复；补 P5/P26 |
| `329db6e` | 冒烟测试：`saveRules` 不再嵌在「example.com 可达」分支里 |
| `e8023b2` | docs：把暂停规则与冒烟测试的网络依赖写进本文件 |
| `06f333a` | 规则宽度：`||host^`（裸域名也封、止步于主机边界）+ `!host` 例外；`hostMatches()` 三处统一（第 3 节 / 8.4） |
| `d8b6193` | test：P27/P28 + 冒烟测试第 9 组（本地 marker 服务器 + `--host-resolver-rules`），含两条对照 |
| `e8023b2`、`06f333a`、`d8b6193`、`3a8612b` | 规则宽度 / 例外语义 / 对照测试，做法写进第 3 节 |
| `6696464` | docs：`PRODUCT-REVIEW.md`（产品评审 + 四档线路图），§6 是「做完」的定义 |
| `fbb9ab6` | **档位 ①-1**：配额按「经过的时间」结算（`usageClock`），补 P29–P31 |
| `38042de` | **档位 ①-2..9**：一套反馈层（`ui.js`）、AA 对比度配色、顶栏进页面顶部、`Close this tab`、真通知、streak 重置挪进设置页、规则可编辑 + 例外徽章、方形图标 |
| `843a6cb` | **档位 ②**：时段规则、临时放行、快捷键、提醒音、导出/导入；补 P32–P35 |
| `036ff12` | **档位 ③**：90 天本地趋势 + 7 天回顾；补 P36/P37 |
| `9b5cc0c` | **档位 ④**：`_locales` + `PRIVACY.md` + 仓库卫生（`docs/legacy/`），版本 `2.1.0` |
| `ef22b91` | 开源准备：`LICENSE`(MIT)、`.gitignore`、`README.md`、GitHub Actions（两套 harness + `xvfb` 冒烟）、`docs/screenshots/` 真截图、页脚署名 |
| `085c48d` | 页脚只留 `© 2026 Hysan Sun`，撤掉邮箱/微信 —— 随后两次 `filter-branch` 让联系方式从**整段历史**里消失 |
| `26068de` | docs：历史重写后两份文档里的 commit 哈希全部失效，按提交顺序重映射（规则 id 段位与示例值不动） |

### 已确认未做的事

- **streak 那次的改动前端一行未动**：全在 `background.js`。
- **档位 ① 之后，`streaks.js` / `settings.html` / `settings.js` 不再是「一行未动」**，
  这一点必须说实话：
  - `settings.html` / `settings.js` 在档位 ① 里按评审 BUG-3 / BUG-7 重写（例外徽章、
    编辑态、Reset 挪进来）；档位 ② 又加了「时段」控件和每行的 `Unlock` 按钮。
    规则行从「2 个按钮」变成「3 个按钮」，所以多了一个 `.rule-actions` 分组：一行放不下时
    三个按钮整体换到第二行右对齐，而不是散开。**这是本次唯一改到既有卡片观感的地方。**
  - `blockpage.html` 在档位 ①/② 里多了 `Close this tab`、整页 `Unlock` 行；
    顶栏仍只有 ⏱ 和 ⚙ 两个图标。
  - 用户的原话是「不要改变原有界面的前端布局」；档位 ① 是用户点名要做的，档位 ②③ 只新增
    控件/卡片，没有挪动既有卡片顺序。`pomodoro.html` 的 Trend 卡插在 Done 与 Timer settings
    之间，是唯一新增的卡片。
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
- ~~统一 `1.7.2` vs `v2.0` 的版本号表述~~ —— 已完成，页面角标改读 `getManifest().version`
- ~~清理 `streaks-back.js` / `manifest-back.json` / `maniback up.json` 三个历史备份~~
  —— 已完成（档位 ④），连同 `POMODORO-PLAN.md` 一起移进 `docs/legacy/`，没有删除
- **页面级 i18n**：`_locales/` 只覆盖了 manifest 的扩展名 / 简介 / 快捷键说明。
  三个页面的正文仍是「英文界面 + 中文 Manual」，要不要整体翻译请先问用户
- **任务跨设备同步**：只有任务文本适合进 `storage.sync`。没做，因为收益（备份文件已经能
  搬家）小于风险（`todo` 是本地的单一权威，改成同步要处理冲突）。要做请先想清楚合并规则

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
- 页面最下面还有一个可折叠的 **Manual** 卡片（中文使用说明，默认折叠）：和 Timer
  settings 同一套「标题即开关 + `▾/▴`」的写法。它纯静态、不读任何状态，加它不影响任何逻辑。

### 8.2 存储

| 键 | 区域 | 含义 |
|---|---|---|
| `pomodoro` | local | 运行态：`phase` / `endAt` / `pausedRemainingMs` / `cycleDone` / `dayKey` / `focusToday` / `focusMsToday` / `taskId` / `strictNow`，外加 `run`（多单位承诺）与 `review`（待回答的提问） |
| `pomodoroSettings` | sync | 配置：三段时长、长休间隔、两个自动开始开关、`focusBlocksTimed`、`soundOn`（默认关） |
| `todo` | local | `{v, tasks:[{id,text,done,createdAt,doneAt,pomodoros,focusMs,plannedUnits}]}`，数组顺序即显示顺序；`plannedUnits` = 预计单位数（0 = 未估），`pomodoros` = 已记单位数 |
| `tempUnlocks` | local | `{host: until}`：临时放行的到期时间。**只在 local**，且读取时永远按 `until > now` 过滤 |
| `stats` | local | `{v, days:{'YYYY-MM-DD':{focusMs, sessions, blocks:{host:n}}}}`，保留 90 天。**绝不能搬进 sync**（8KB/项、100KB 总量、1800 写/小时） |

### 8.3 计时机制

- **唯一权威是 `endAt` 时间戳**，剩余时间每次都用 `endAt - now` 求值。background
  **不跑 `setInterval`**：一个一次性 alarm `pomodoroPhase`（`when: endAt`）负责准点，
  已有的 `tracking` alarm（1min）兜底，`initialize()` 负责启动时的权威对齐。
- 到期语义是**挂钟语义**（用户拍板）：`now >= endAt` 就算这一段完成，哪怕晚了三小时。
  风险由两条硬约束兜住：**一次 tick 只推进一个相位**，且**新相位的 `endAt` 从 `now`
  重算**（不继承旧截止时间）。所以关机三小时回来只记 1 段，绝不级联。
- `skip` / `stop` / `pause` 都不记账；`pause` 把剩余冻进 `pausedRemainingMs` 并清 `endAt`。
- **暂停是有限的（本轮新增，用户拍板）**：一次**专注**只准暂停一次，且最多
  `POMODORO_MAX_PAUSE_MS`（2 分钟）。快照存在 `pauseUsed` / `pauseEndsAt` 里，两个字段
  **每次相位切换都归还**（`pomodoroEnterNextPhase`）。到点由 `pomodoroTick()` 自己恢复，
  并且**用 `now` 重新起算剩余冻时**（不比 `pauseEndsAt` 早、也不继承旧截止时间），
  所以睡过整个暂停只会得到一段完整的新时钟，不会凭空完成。暂停期间 `armPomodoroAlarm()`
  必须把 alarm 挂在 `pauseEndsAt` 上 —— 暂停时没有 `endAt` 可等，漏了它就要等 1 分钟的
  `tracking` 兜底。**休息期不受限**（暂停多久都行，也不会自己恢复）。
- **`pomodoroBusy` 是防重入的**：popup 的秒级 tick 和 alarm 可能重叠，缺了它就会重复
  记账、重复发通知（harness 的 P12 守这一条，故意删掉会掉分）。
- 休眠/关机后一次性 alarm 不保证还在，所以**启动时永远从 `endAt` 重新对齐并重新 arm**，
  不要往这条路径上加内存态假设。alarm 晚到最多约 1 分钟，这是有意的（`tracking` 兜底）。

### 8.4 与拦截系统的耦合

- `strictNow = (phase === 'focus' && settings.focusBlocksTimed)`，由 background 写进 local
  的 `pomodoro` 状态；`syncAllRules()` 和 `content.js` 都读它。**暂停不解锁**（暂停也算还在
  专注期），只有 `stop` 才离开（`skip` 从本轮起只作用于休息，见 8.9）。
- 专注期里 `syncAllRules()` 给每个 timed 站点直接注册规则，**不看当天用量**；离开专注期时
  整表重算，恢复成「按真实用量判断」。所以**真正超限的站点会继续被封**——不要改成
  「退出专注期就删掉番茄钟规则」，那会误放超限站点。
- 番茄钟规则的 ID 段是 `POMODORO_RULE_ID_OFFSET = 1500000`，**必须低于
  `TIMED_RULE_ID_OFFSET`（2000000）**：`enforceTimeLimit` / `resetDailyLimits` 用
  `id >= TIMED_RULE_ID_OFFSET` 筛 timed 规则，落进那个范围的番茄钟规则会被误删。
- 专注期被重定向到拦截页的标签页**不会自动回跳**，需要刷新（整页会显示倒计时）。
- 例外（`!host`，见第 3 节）**压过专注期的封禁**：allow 是 `priority: 100`、重定向是 10，
  最高优先级胜出，所以被例外的站点在专注期也能开。`strictNow` 只决定 timed 站点装不装规则。

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
- 每行操作：▶ 与行尾的 `N/M 🍅` 都会打开**计划对话框**（见 8.9）、勾选完成、双击改名、
  上移/下移、删除。**不引入拖拽**。

### 8.7 验证

见第 5 节：`node test/pomodoro-harness.js background.js`（应 25/25），以及
`python test/browser-smoke.py`（应 38/38，真浏览器）。

### 8.9 计划用量与 run（planned run，本轮新增）

用户要的语义：**任务可以设「预计用几个番茄单位」**（1 单位 = 1 段专注 + 紧随其后的休息，
时长由 `pomodoroSettings` 决定），再从任务行 ▶ 启动一段**有终点的**专注。

- 任务字段 `plannedUnits`（0 = 还没估）；`task.pomodoros` 是**已记单位数**（每段自然完成的
  专注 +1）。老数据没有这个字段，`normalizeTodo()` 一律补成 0。
- **`setTaskPlan()` 会把估计值向上夹到「已记单位」之上**（`max(credited, units)`）。这不是
  洁癖：review 的触发条件就是 `credited >= planned`，估计值一旦能低于已记单位，
  「到达估计值」这个时刻就永远不会再来一次。harness 的 P24 守着这条。
- `state.run = {taskId, units, focusDone}` 是一次**多单位承诺**：run 期间**不看
  `autoStartBreak` / `autoStartFocus`**，休息一结束就直接进下一段专注 —— 这就是「一直做到
  做完」。休息仍然可以 `skip`（提前结束休息，run 照样继续）。
- **专注期不能 `skip`**：`pomodoroSkip()` 对 `phase === 'focus'` 直接原样返回。唯一的出口是
  `stop`（不记账）。用户明确要求如此，P5/P22 守着。
- **review（系统提问）在 run 的最后一个休息结束时才触发**（不是最后一段专注结束时），这样
  「一个单位」真的包含了它的休息。条件是 `planned > 0 && credited >= planned`，写成
  `state.review = {taskId, at}`，页面据此显示 `#review-card`。
- 三个回答（`pomodoroReviewAnswer`）：`done` 归档任务；`continue` 只清问题，页面随后重开
  计划对话框（用户在框里重新估 ⇒ 走 `pomodoroStart` 的 `planUnits`）；`later` 只清问题。
  对同一个任务重新 `pomodoroStart` 也会清掉问题。
- run 比估计值短时（只跑 2 单位、估计 4 单位）**安静结束**，不提问（P23）。`stop` 让 run
  作废，**已跑过的那部分不记账**（P25）—— `skip` 掉专注做不到，所以不存在「skip 之后
  run 停在半路」的状态。

- 计划对话框的两个数字框**不能在 `input` 里无条件回写自己**：用户清空输入框准备重新
  输入时，一次回写会把值顶成 1、光标留在末尾，接着敲的 `3` 就变成 `13`。
  `syncPlanDialog(source)` 只重画「不是正在编辑的那一个」框，真正的夹取留给 `planStart`。
  真浏览器冒烟测试有一条守它。

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
6. **`chrome://extensions` 的错误卡片不会因为你点「刷新」而消失。** 2026-09-28 下午用户
   就是被它坑住了：卡片记的是**当初在哪一行抛的错**，但下面那段源码是按**当前磁盘上的文件**
   重新渲染的。所以他 reload 到 2.0.2 之后，卡片上还写着 `background.js:110` —— 而 2.0.2 的
   第 110 行已经是 `seen.add(rule.id)`，只有 **2.0.1** 的第 110 行才是那个 `updateDynamicRules`。
   判断旧卡片的两招：① 用 `git show <旧 commit>:background.js` 对一下行号对应哪个版本；
   ② 看日志格式 —— `f3099b5` 之后的行尾会带「wanted rule ids / live rule ids」，旧卡片没有
   这一段。确认是旧卡片后，点错误页右上角「全部清除」。**报错不能只看卡片，要看它属于哪个版本。**
7. **catch 块里不要引用只在 `try` 里声明的 `const`。** `syncAllRulesNow()` 的 catch 曾经引用
   `items`（`const items = ...` 声明在 try 内部）→ 规则写入一旦失败，catch 自己抛
   `ReferenceError: items is not defined`，而这个错**会逃出 `syncAllRules()`**：
   ① 消息处理器 `await` 它时 promise 变 rejected ⇒ `sendResponse` 永远不调用 ⇒ popup 那边
      `chrome.runtime.sendMessage` 的回调一直不来 ⇒ **界面看起来完全死了（计时点不动、
      按钮没反应）**；
   ② `initialize()` 里的 `await syncAllRules()` 抛错 ⇒ 它**之后**的 alarm 创建全被跳过 ⇒
      `tracking` / `dailyReset` 定时器根本没建起来。
   用户报的「完全无法计时」= 4 号坑（worker 启动即崩）+ 这个坑叠加。现在 `wantedIds` /
   `liveIds` / `items` 三个诊断变量都在 `try` 外面声明。P19 守着这条：它不仅断言规则集不被
   清空，还断言规则写失败时 `syncRules` 仍然要回 `{success:true}`。

## 9. 档位 ②③④（时段 / 临时放行 / 快捷键 / 声音 / 备份 / 趋势 / 产品化）

### 9.1 时段规则（`blockedItems[i].window`）

`window: { days:[0..6]（0=周日）, from:'HH:MM', to:'HH:MM' }`，可选。

- **窗口之外这条规则不存在**，不是「放宽」：`syncAllRulesNow()` 直接 `continue`，
  `timedRuleForHost()` / `content.js` / 设置页灰显都照同一条语义。timed 规则在窗口外
  **不计额度**。
- `to <= from` 表示跨午夜（如 22:00–06:00），**午夜之后那一段算在起始日**：
  `belongsTo = (crossesMidnight && nowMin < to) ? (day+6)%7 : day`。
  这是最容易写错的地方，P33 用三个固定时刻 + 不同 `days` 守住它。
- 读不出来的窗口（`from`/`to` 解析失败）**按「生效」处理** —— 静默失效比误封危险。
- **一个写手**:`windowSignatureOf()` 只生成一串 `'0'/'1'`，`syncAllRulesNow()` 记进
  `lastWindowSignature`，`trackActiveTab()` 发现签名变了才 `syncAllRules()`。
  所以窗口开关不是在整点自动生效的，而是**下一次 per-minute tick**（最多晚 1 分钟），
  这也意味着 `trackActiveTab()` 里那段签名判断**必须在 `tab && tab.url` 分支里** ——
  P32 一开始就是因为它没焦点标签页而失败。
- 设置页为了灰显复制了一份 12 行的 `isWindowActive()`。**它只影响一层灰色**，
  判定权威始终是 background；两处漂移的后果仅限于颜色。

### 9.2 临时放行（`tempUnlocks`）

- 机制就是**例外规则的同一套 allow 规则**，额外带一个到期时间。优先级 100，id 段
  `TEMP_UNLOCK_ID_OFFSET = 3000000`（在所有其他段之上，任何按低段过滤的逻辑都扫不到它）。
  段位梯子：`1..N` 完整 block、`1000000+` 例外、`1500000+` 专注期 timed、`2000000+`
  超额 timed、`3000000+` 临时放行。
- `expireTempUnlocks()` 按 `until > now` 过滤并写回，`armTempUnlockAlarm()` 把 alarm 挂在
  **最早到期**的那个上。**`initialize()` 里必须重新 arm**：解锁状态活得比 worker 久。
  （这条曾经漏过 —— 只挂 alarm 不重新 arm，重启后没人收回它。）
- `minutes === 0` 表示「现在锁回去」，调用方不用再来一条消息。
- 拦截页怎么知道该放行谁：DNR 重定向的 `extensionPath` 带 `?host=<rule.val>`，
  `redirectActiveTabAway()` 和 `content.js` 还多带一个 `?url=` 用来回到原来那一页。
  **query string 在 `extensionPath` 里是合法的**（Chromium 实测：存进去是什么样，跳过去就是
  什么样），这是拦截页唯一能拿到的「是谁拦的我」。
- 有意为之：**专注期也能按临时放行**。`!host` 例外本来就能穿过专注期拦截，
  临时放行是同一个东西；「删扩展」不该是唯一出口。说明书里明说了这一点。

### 9.3 快捷键、提醒音、备份

- `commands`：`Alt+Shift+P` 开窗口、`Alt+Shift+S` 暂停/继续。`background.js` 里注册前先判
  `chrome.commands && chrome.commands.onCommand`（harness 里没有这个命名空间）。
  **`togglePomodoroTimer()` 不能绕过「一次专注只准暂停一次」** —— 它只调
  `pomodoroPause()`，让 worker 自己拒绝第二次。P5 的语义不许被快捷键旁路。
- 提醒音：service worker 放不了声音，所以有一个 `offscreen.html` + `offscreen.js`，
  用 WebAudio **现场合成两个音**（不下载任何音频文件，隐私声明里承诺了这一点）。
  **默认关**（`soundOn:false`），只有在设置里勾了才播。`playPhaseSound()` 不 await。
- 导出/导入在设置页：导出 `storage.local` + `storage.sync` 的全量 JSON；导入**整体替换**，
  导入后要 `syncRules` 让 DNR 跟上。这是对「删扩展 = 唯一解锁」的对冲。

### 9.4 趋势（`stats`）

- 记两个点：专注**完成**时（`pomodoroEnterNextPhase` 的 credit 分支）记 `focusMs/sessions`；
  额度**刚被跨过**时（`trackActiveTab` 里 `prevMs < limitMs && newMs >= limitMs`）记一次
  `blocks[host]`。**一次跨越一次**，不是每分钟一次（P37）。
- **绝不允许写进 `storage.sync`**。它的量按分钟增长，而 sync 有每项 8KB / 总量 100KB /
  每小时 1800 次写的配额，写爆会连用户的规则设置一起丢。
- 写入点全部包在 try/catch 里：**统计是记录，不是规则**，写失败不能影响记账或相位推进。
- `pruneStats()` 在每次写时按 `'YYYY-MM-DD'` 字符串比较裁掉 90 天前（P36 用一条
  `2000-01-01` 的记录守这条）。
- UI 是 `pomodoro.html` 里插在 Done 与 Timer settings 之间的折叠卡：7 根柱子 +
  「Last 7 days: N sessions · Xh Ym」+ 「在哪跑完额度最多」。

### 9.5 产品化（档位 ④）

- `_locales/en` + `_locales/zh_CN`，`default_locale: "en"`，manifest 里
  `name/description/commands[].description/action.default_title` 用 `__MSG_*__`。
  **缺 key 会让扩展整个装不上**，改完必须跑一次冒烟测试（它会真的加载扩展并打印版本）。
- `PRIVACY.md` 是完整声明；`pomodoro.html` 的 Manual 里有一节说同样的话。
  里面的「不联网」是可验证的事实，不是口号：`grep -n "fetch(\|XMLHttpRequest\|sendBeacon\|WebSocket"`。
- 通知图标用 `icon128.png`（方图）；`icon.png` 是 470×320 的横版字标，只做页面展示。
- `docs/legacy/` 放历史备份，`docs/README.md` 说明 `docs/` 不随扩展发布。
- 版本只写在 `manifest.json` 一处，页面角标读 `chrome.runtime.getManifest().version`。

### 9.6 旧 worker 陷阱（2026-10-02 实测踩到，代价是用户几小时的困惑）

- **改磁盘上的文件不会换掉正在跑的 service worker。** 未打包扩展要在
  `chrome://extensions` 点 Reload 才会重新注册 worker；而页面（`settings.html` 等）
  下一次打开时**读的是磁盘上的新代码**。于是会出现「新页面 + 旧 worker」的混合体。
- 症状：页面有 Unlock 按钮（新代码），点下去却弹 `Could not unlock` —— 旧 worker 的
  `onMessage` 落进 `default:` 分支，回 `{success:false, error:'Unknown action'}`。
  **这不是规则问题，也不是这个功能的 bug**，重载扩展即可。
- 判定方法：`User Data/<profile>/Secure Preferences` 里
  `extensions.settings.<id>.service_worker_registration_info.version` 是 worker 的版本，
  `last_update_time` 是上次 Reload 的时刻，和 `manifest.json` 对不上就是 worker 旧了。
  另一个指纹：`Local Extension Settings/<id>/` 里找不到 `usageClock` / `tempUnlocks` /
  `stats` 这些只有新代码才会写的键。
- 因此 `default:` 分支会把动作名回给页面（`unknownAction`），`settings.js` 的
  `staleWorker()` 据此把提示换成「Reload the extension at chrome://extensions」。
  冒烟测试有一条守着这个契约。
