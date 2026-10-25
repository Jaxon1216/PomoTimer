# 前端请求流程

当前链路是：

```text
React -> preload -> Main IPC -> TimerEngine -> SqliteStore
                           \-> Tray / Notification / event broadcast
```

启动时 Main 先取得单实例锁，再打开 `app.getPath("userData")/pomodoro.sqlite`、执行事务迁移、恢复快照并把上次运行中的轮次转为 `auto-paused/core-recovery`，随后创建窗口和托盘。重复启动只唤起已有窗口。计时不依赖 renderer 轮询。

Renderer 启动时并行读取快照、设置，并订阅经 schema 校验的事件。Main 创建初始内容区域 360×478、最小 160×180 的窗口；Renderer 的 CSS 直接根据可用宽高调整布局，不读取或维护窗口模式。

点击开始、暂停、继续、下一轮或重置时，React 调用 `window.pomodoro.command`。Preload 和 Main 分别做 schema 校验，Main 将命令交给唯一 TimerEngine；成功迁移后保存快照，并通过 `pomodoro:event` 广播到窗口和托盘。Renderer 从事件更新显示，不自行扣减权威剩余时间。

Main 每秒读取 `powerMonitor.getSystemIdleTime()`，只将秒数交给 TimerEngine。TimerEngine 根据阈值计算 `present/away`，遵循专注、活动休息和桌前休息规则；采样失败安全暂停并显示降级状态，用户明确继续后可手动计时，首次有效样本恢复自动化。suspend 事件冻结运行轮次并写入安全暂停状态；lock-screen 建立门禁，unlock-screen 解除门禁但等待下一有效样本才决定恢复。静止且状态未变化的输入不重复写入数据库。

专注完成后 TimerEngine 生成等待条件的休息轮并广播快照；Renderer 显示“等待离席 · 将自动开始”或“等待无输入 · 将自动开始”。输入条件满足后仍由 Main 的采样驱动 TimerEngine 自动开始，Renderer 不启动本地倒计时，也不自动发送 start/resume。只有用户点击可选的“手动开始休息”图标才发送相应 start/resume；手动暂停后的继续与检测失败回退仍遵循同一权威状态机。

拖动原生窗口边框时，Main 约束最小内容区域并记住本次运行内单个窗口的位置与尺寸；恢复时将其限制在可用显示区域内。CSS 在窄小窗口收起次要信息，在 160×180 等微小窗口使用数字与细进度线，在宽至少 360 px 且高不超过 240 px 时将圆环放到信息与控制左侧。轮次、完整状态、监测信息和计时按钮保持可达。“更多操作”只提供统计、设置与重置入口；该布局链路没有 IPC 请求或专用事件，不经过 TimerEngine 或 Store，也不写入 SQLite。

设置页面提交后，Main 验证 patch、持久化设置、更新置顶状态并广播快照。统计页面调用 `getStatistics`，由 Store 按本机日期聚合完成专注记录。Renderer 不能访问 SQLite、Node、Electron 或任意未列出的 channel。

设置页面保存前校验数字范围与整数要求；普通操作失败在原视图提示并允许重试。完成事务提交或本地日期变化后 Main 发布 `stats.changed`；统计页重新聚焦时重新读取。存储运行时故障由 Main 冻结内存计时、停止后台写入并广播 `core.error`。初始化失败先由 Store 备份数据库及 WAL/SHM，再由 Main 原生对话框让用户选择退出或归档后重建，Renderer 不获得数据路径或重建权限。
