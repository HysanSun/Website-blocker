# POMODORO-PLAN —— 已实施，这里只留决策记录

> 设计已经落地。**现状请以 `HANDOFF.md` 第 8 节为准**（键名、状态机、红线、验证方式
> 都在那里）。本文只保留「当初为什么这么选」，免得下次重新纠结。
>
> 本文早期版本的「popup 内嵌卡片」方案已被推翻 —— 用户要求不改变原有界面布局。

## 用户拍板的选择

| 问题 | 选定 | 落点 |
|---|---|---|
| 界面放哪 | **独立窗口页 `pomodoro.html`**，不往 popup 里塞卡片 | `pomodoro.html` + `pomodoro.js` |
| 入口 | 允许顶栏加 1 个图标 + 被拦整页加一行状态 | `pomodoro-entry.js`，`blockpage.html` 两处增量 |
| Todo 与番茄钟 | 同页联动：以某任务启动，专注完成给该任务 +1 番茄 | `creditTaskFocus()` |
| 到期语义 | **挂钟语义**：`now >= endAt` 就算完成，哪怕晚了三小时 | `pomodoroTick()` |
| Todo 范围 | 完整版：增删改、手动排序、Done 归档、今日统计、Clear completed | `todo*` 消息 |
| 任务生命周期 | 未完成跨天保留；已完成不自动清理，只手动清 | `todo` 键 |
| 与拦截耦合 | **只加严**：专注期封死 timed 站点（不做「休息期放宽」） | `syncAllRules()` |
| 结束提醒 | 直接要 `notifications` 权限（不走 optional） | `manifest.json` |
| 版本号 | 统一为 `2.0.0` | `manifest.json` |
| 番茄钟设置放哪 | 内嵌在 `pomodoro.html`，**不动 `settings.*`** | 落实「不改变原有布局」 |
| 专注期能不能 skip | **不能**：只有休息可以 skip；专注的出口是 Stop（不记账） | `pomodoroSkip()` |
| 一次专注能暂停多久 | **只能暂停一次，最多 2 分钟**，到点自己恢复；休息不限 | `pomodoroPause()` / `pomodoroTick()` |
| 任务的预计用时 | 每个任务可设 `plannedUnits`（以番茄为单位）；行首 ▶ 弹框问「本次跑几个单位 / 全部」 | `pomodoro.html` + `setTaskPlan()` |
| 到达计划时间之后 | 系统提问「任务完成了吗」：完成⇒归档，没完成⇒重估单位继续 | `pomodoroReviewAnswer` |

## 实施中发现的坑（harness 已经守住）

- 长休判定必须带 `credit && cycleDone > 0`：否则「跳过第一段专注」白送一个长休
  （`0 % 4 === 0`）。P5 守。
- 新相位的 `endAt` 必须以 `now` 重算，不能继承旧截止时间，否则过期后会级联推进。P1/P3/P4 守。
- `pomodoroBusy` 防重入不能省：popup 的秒级 tick 与 alarm 重叠会重复记账、重复通知。P12 守。
- 通知的迟到判断只管通知，不影响记账。P10 守。
- 番茄钟规则 ID 段必须低于 `TIMED_RULE_ID_OFFSET`，否则会被 `resetDailyLimits` 误删。P8 守。
- harness 的假时钟要锚在当天 12:00，否则「快进三小时」在深夜会变成跨天，测试随机挂。
- 「到达估计值」的条件是 `credited >= planned`，所以估计值**不能低于已记单位**，否则提问
  从此再也触发不了。P24 守。
- run 期间要绕开 `autoStartFocus`，否则用户设的「不自动开始下一段」会把 run 停在第 2 段。P21 守。
- 计划对话框的数字框在 `input` 里回写自己会吃掉用户的击键（`3` 变 `13`）；只重画没在编辑的那个框。
- 暂停期间页面那个 1 秒循环**不能直接 `return`**：原来 `isPaused` 就返回，结果暂停倒计时不动、
  worker 自己恢复后页面还停在「已暂停」。真浏览器冒烟测试守这条。
- 暂停时没有 `endAt` 可等，`armPomodoroAlarm()` 必须改挂 `pauseEndsAt`，否则恢复要等 1 分钟兜底。P5 守。
- 封一个域名时会连它的子域一起封（`||host^`），所以「封 `baidu.com` 打不开 `pan.baidu.com`」不是 bug；
  要给某个子域开口子，就在设置里加 `!pan.baidu.com`（`!` 开头 = 该主机及其子域永不封）。
  DNR 的 `*://*.host/*` **不匹配裸域名**，别改回去。P27/P28 与冒烟测试第 9 组守这两条。

## 怎么验

```powershell
node test/pomodoro-harness.js background.js   # 应 28/28
node test/streak-harness.js background.js     # 应 10/10
```
