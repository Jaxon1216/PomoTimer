# 前端请求流程

当前链路是：

```text
React -> preload -> Main IPC -> TimerEngine -> SqliteStore
                           \-> Tray / Notification / event broadcast
```

启动时 Main 先取得单实例锁，再打开 `app.getPath("userData")/pomodoro.sqlite`、执行事务迁移、恢复快照并把上次运行中的轮次转为 `auto-paused/core-recovery`，随后创建窗口和托盘。重复启动只唤起已有窗口。计时不依赖 renderer 轮询。

Renderer 启动时并行读取快照、设置和 `getWindowMode`，并订阅经 schema 校验的事件。窗口初始为 `regular`；模式读取失败进入现有核心不可用界面。React 不根据 resize 推断窗口模式。

点击开始、暂停、继续、下一轮或重置时，React 调用 `window.pomodoro.command`。Preload 和 Main 分别做 schema 校验，Main 将命令交给唯一 TimerEngine；成功迁移后保存快照，并通过 `pomodoro:event` 广播到窗口和托盘。Renderer 从事件更新显示，不自行扣减权威剩余时间。

Main 每秒读取 `powerMonitor.getSystemIdleTime()`，只将秒数交给 TimerEngine。TimerEngine 根据阈值计算 `present/away`，遵循专注、活动休息和桌前休息规则；采样失败安全暂停并显示降级状态，用户明确继续后可手动计时，首次有效样本恢复自动化。suspend 事件冻结运行轮次并写入安全暂停状态；lock-screen 建立门禁，unlock-screen 解除门禁但等待下一有效样本才决定恢复。静止且状态未变化的输入不重复写入数据库。

专注完成后，TimerEngine 生成等待条件的休息轮并广播快照。Main 的输入采样驱动休息自动开始或恢复。休息的剩余时间仍等于总时长，且当前处于 `idle` 或因 `break-condition` 自动暂停时，Renderer 提供“手动开始休息”。用户点击后，前者发送 `start`，后者发送 `resume`。

休息已有进度、因最近有输入而暂停时，Renderer 显示“有输入 · 休息暂停”，按钮改为“继续计时”。用户点击后发送 `resume`。手动暂停和输入故障也提供“继续计时”，由 TimerEngine 按原有规则处理。

直接拖动窗口边缘时，Renderer 随内容区即时调整排版。常规窗口从初始 360×478 拖小后即可用作挂件，最小为 160×180。拖动本身无需窗口模式或计时 IPC。计时暂停时，用户能看清原因，并可点击继续向 Main 发送 `resume`。

窗口按钮或“更多操作”里的“切换迷你模式”“恢复常规窗口”调用 `setWindowMode`。Preload 和 Main 校验请求后，Main 记住当前模式的 bounds，再恢复目标模式的 bounds。首次进入迷你模式使用 220×240，也可拖到 160×180。Main 返回最终模式并广播 `window.modeChanged`。选择“恢复常规窗口”会回到上一次常规窗口的位置与尺寸。这些数据仅在本次运行的 Main 内存中保存。

设置页面提交后，Main 验证 patch、持久化设置、更新置顶状态并广播快照。统计页面调用 `getStatistics`，由 Store 按本机日期聚合完成专注记录。Renderer 不能访问 SQLite、Node、Electron 或任意未列出的 channel。

设置页面保存前校验数字范围与整数要求；普通操作失败在原视图提示并允许重试。完成事务提交或本地日期变化后 Main 发布 `stats.changed`；统计页重新聚焦时重新读取。存储运行时故障由 Main 冻结内存计时、停止后台写入并广播 `core.error`。初始化失败先由 Store 备份数据库及 WAL/SHM，再由 Main 原生对话框让用户选择退出或归档后重建，Renderer 不获得数据路径或重建权限。
