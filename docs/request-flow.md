# 前端请求流程

当前链路是：

```text
React -> preload -> Main IPC -> TimerEngine -> SqliteStore
                           \-> Tray / Notification / event broadcast
```

启动时 Main 先取得单实例锁，再打开 `app.getPath("userData")/pomodoro.sqlite`、执行事务迁移、恢复快照并把上次运行中的轮次转为 `auto-paused/core-recovery`，随后创建窗口和托盘。重复启动只唤起已有窗口。计时不依赖 renderer 轮询。

Renderer 启动时并行读取计时快照、设置和摄像头生命周期状态，并订阅经 schema 校验的事件。

点击开始、暂停、继续、下一轮或重置时，或在计时器页按空格执行开始/暂停/继续时，React 调用 `window.pomodoro.command`。Preload 和 Main 分别做 schema 校验，Main 将命令交给唯一 TimerEngine；成功迁移后保存快照，并通过 `pomodoro:event` 广播到窗口和托盘。Renderer 从事件更新显示，不自行扣减权威剩余时间。空格不拦截表单、菜单、其他控件、统计或设置页，不重复处理长按、组合键及输入法组合状态。

Main 每秒读取 `powerMonitor.getSystemIdleTime()`，只将秒数交给 TimerEngine。TimerEngine 根据阈值计算 `present/away`，遵循专注、活动休息和桌前休息规则；采样失败安全暂停并显示降级状态，用户明确继续后可手动计时，首次有效样本恢复自动化。suspend 事件冻结运行轮次并写入安全暂停状态；lock-screen 建立门禁，unlock-screen 解除门禁但等待下一有效样本才决定恢复。静止且状态未变化的输入不重复写入数据库。

主界面默认「触控」。用户选择「监控」时，Renderer 通过 `updateSettings({ focusPresenceSource: "camera" })` 提交选择；Main 在当前实际来源变化时安全暂停运行中的轮次、清空旧摄像头状态，再签发新的 `{ enabled, generation }`，经 `camera.state` 通知 Renderer。Renderer 只在启用状态请求视频权限，在本地初始化 MediaPipe/BlazeFace 并约每秒检测两次，约每 500ms 通过 `reportCameraPresence(presence, generation)` 提交三态。Preload 和 Main 校验严格的 `{ presence, generation }`，Main 拒绝旧代次报告，再由 TimerEngine 根据当前轮次和手动暂停锁处理。监控模式下，在场自动开始专注、离席自动开始活动休息；桌前休息始终使用系统输入。未结束的专注离席只暂停，不提前切轮。打开统计或设置不会重开摄像头。

Renderer 为权限、视频和模型启动设置 20 秒期限，Main 等待首个有效样本的上限为 25 秒。摄像头权限拒绝、设备中断、启动超时、有效报告间隔超过 5 秒或 Renderer 丢失时，Main 将摄像头标为 `unknown`、停止旧代次并持久化回退触控，通过 `settings.changed` 和可恢复错误说明回退原因。专注等待新的输入样本，手动暂停保持锁定。选择触控、锁屏/睡眠和退出会释放摄像头；锁屏/睡眠恢复若仍选监控，重新签发代次并等待新样本。摄像头帧、检测框与设备信息不经过 preload，也不写入 SQLite。

专注完成后，TimerEngine 生成等待条件的休息轮并广播快照。Main 使用当前实际输入源或摄像头源驱动自动休息，不要求先点击播放。采用输入的休息准备期由有效闲置样本推导 `automation.breakPreparation`；默认先显示“无输入 40 秒开始休息”，第 30 秒起显示 `10…1`，第 40 秒才开始正式休息。中途输入重新等待完整阈值，准备时间不抵扣正式休息剩余时间；该准备状态不进入检查点。

每轮自然完成并成功持久化后，TimerEngine 更新进程内完成版本和完成类型/时间。Main 显示独立无声卡片，以自身 preload 的 `getReminder/subscribeReminder` 读取及呈现最新完成；不调用会聚焦主窗口的唤起路径，也不再额外发系统完成通知。点击“知道了”经 `dismissReminder(id)` 仅确认当前 ID 的提醒，旧确认不能清除新提醒；下一轮的感知和计时不等待卡片。锁屏/睡眠隐藏卡片，恢复后重新展示未确认条目；退出清除内存状态。

专注中手动暂停形成锁，只有用户继续才能解除。休息中暂停不形成永久锁：未点暂停或点过暂停，都继续参与自动休息；下一有效休息条件可自动开始或恢复，不额外强制等待一遍阈值。实际键鼠操作产生新的输入时，输入来源会自然重新等待完整阈值。旧检查点中手动暂停的休息轮在恢复时转为自动等待，进度不变，旧的专注锁仍保留。

拖动计时器留白时，由系统移动窗口。拖动边缘时，Main 按内容区域约束尺寸，Renderer 根据可用宽高排版。初始内容区域为 360×478，可缩至 160×180，高度最多为宽度的 1.5 倍。缩到最小时，暂停原因和继续按钮仍然可见。点击继续才会向 Main 发送 `resume`。

在计时器右上角，感知模式按钮位于统计图标左侧，提交模式设置时仍经过同一 IPC 链。在计时器上点击统计图标，Renderer 在当前窗口切换到统计页。点击“更多操作”可打开设置、查看统计或重置当前轮次。统计和设置均可返回计时器。底部周期条按各阶段计划时长分配宽度，当前轮按已分配的总时长显示；当前位置与真实完成量分别命名。

设置页面提交后，Main 验证 patch、持久化设置、更新置顶状态并广播快照。统计页面调用 `getStatistics`，由 Store 按本机日期聚合完成专注记录。Renderer 不能访问 SQLite、Node、Electron 或任意未列出的 channel。

设置页面保存前校验数字范围与整数要求；普通操作失败在原视图提示并允许重试。完成事务提交或本地日期变化后 Main 发布 `stats.changed`；统计页重新聚焦时重新读取。存储运行时故障由 Main 冻结内存计时、停止后台写入并广播 `core.error`。初始化失败先由 Store 备份数据库及 WAL/SHM，再由 Main 原生对话框让用户选择退出或归档后重建，Renderer 不获得数据路径或重建权限。
