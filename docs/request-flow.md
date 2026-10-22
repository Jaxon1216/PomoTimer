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

专注完成后 TimerEngine 生成等待条件的休息轮并广播快照；Renderer 显示“等待离席 · 将自动开始”或“等待无输入 · 将自动开始”。输入条件满足后仍由 Main 的采样驱动 TimerEngine 自动开始，Renderer 不启动本地倒计时，也不自动发送 start/resume。只有用户点击可选的“手动开始休息”图标才发送相应 start/resume；手动暂停后的继续与检测失败回退仍遵循同一权威状态机。

点击“更多操作”中的“切换迷你模式”或“恢复常规窗口”时，React 调用 `setWindowMode`，经 Preload/Main 校验后由 Main 保存当前模式 bounds，再应用目标模式的最小尺寸与上次 bounds。Main 返回最终模式并广播 `window.modeChanged`，React 据此切换展示。常规首次 360×478、最小 320×300；迷你首次及最小 220×240。拖动仅调整模式内部排布，展开恢复之前的常规窗口；该链路不经过 TimerEngine 或 Store，模式与 bounds 也不写入 SQLite。

设置页面提交后，Main 验证 patch、持久化设置、更新置顶状态并广播快照。统计页面调用 `getStatistics`，由 Store 按本机日期聚合完成专注记录。Renderer 不能访问 SQLite、Node、Electron 或任意未列出的 channel。

设置页面保存前校验数字范围与整数要求；普通操作失败在原视图提示并允许重试。完成事务提交或本地日期变化后 Main 发布 `stats.changed`；统计页重新聚焦时重新读取。存储运行时故障由 Main 冻结内存计时、停止后台写入并广播 `core.error`。初始化失败先由 Store 备份数据库及 WAL/SHM，再由 Main 原生对话框让用户选择退出或归档后重建，Renderer 不获得数据路径或重建权限。
