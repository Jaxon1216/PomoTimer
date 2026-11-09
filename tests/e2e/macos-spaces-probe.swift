import AppKit
import Carbon
import CoreGraphics
import Foundation

final class FullscreenProbe: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var reported = false
    private let electronPID: Int32
    private let electronWindowID: UInt32

    init(electronPID: Int32, electronWindowID: UInt32) {
        self.electronPID = electronPID
        self.electronWindowID = electronWindowID
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
                          styleMask: [.titled, .closable, .resizable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "Pomodoro isolated fullscreen validation"
        window.collectionBehavior = [.fullScreenPrimary]
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.window.toggleFullScreen(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
            if !self.reported { self.report(error: "Native fullscreen transition did not complete") }
            self.window.close()
            NSApplication.shared.terminate(nil)
        }
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.report(error: nil)
        }
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        window.close()
        NSApplication.shared.terminate(nil)
    }

    private func report(error: String?) {
        guard !reported else { return }
        reported = true
        let probePID = ProcessInfo.processInfo.processIdentifier
        let ownIDs = Set([electronPID, probePID])
        // 领域：macOS / 原生全屏验收
        // 顺序：自建窗口进入全屏 -> Window Server 只读列表 -> 两个测试进程的诊断。
        // 作用：确认计时器原生窗口仍在当前可见空间，并比较实际窗口层级。
        // 原因：Electron 的 Spaces getter 不能证明另一个应用全屏时实际可见。
        // 边界：不截屏，不输出其他进程的窗口、名称或桌面内容。
        let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let windows: [[String: Any]] = raw.compactMap { info in
            guard let pid = info[kCGWindowOwnerPID as String] as? Int32, ownIDs.contains(pid),
                  let id = info[kCGWindowNumber as String] as? UInt32 else { return nil }
            return ["pid": pid, "id": id,
                    "layer": info[kCGWindowLayer as String] ?? -1,
                    "bounds": info[kCGWindowBounds as String] ?? [:],
                    "onScreen": info[kCGWindowIsOnscreen as String] ?? false]
        }
        var result: [String: Any] = [
            "probePID": probePID, "probeWindowID": window.windowNumber,
            "electronPID": electronPID, "electronWindowID": electronWindowID,
            "nativeFullscreen": window.styleMask.contains(.fullScreen),
            "probeIsActive": NSApplication.shared.isActive,
            "windows": windows
        ]
        if let error = error {
            result["error"] = error
            printResult(result)
            return
        }
        checkCmdTab { outcome in
            result["cmdTab"] = outcome
            self.printResult(result)
            self.window.toggleFullScreen(nil)
        }
    }

    private func printResult(_ result: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) { print(text) }
    }

    // 领域：macOS / 应用切换验收
    // 顺序：记录全屏证据 -> 激活两个自建进程 -> 原生 Cmd-Tab -> 验证 Electron 激活。
    // 作用：验证真实应用切换入口，不以 Dock 可见标志代替键盘切换结果。
    // 原因：panel 的窗口激活方式不同，需要实际确认产品仍能通过 Cmd-Tab 进入。
    // 边界：不申请权限；仅在两个自建进程均确认激活后发送一次完整快捷键。
    private func checkCmdTab(_ completion: @escaping ([String: Any]) -> Void) {
        guard CGPreflightPostEventAccess() else {
            completion(["available": false, "skipped": true, "reason": "Event-posting access is not already granted"])
            return
        }
        guard let electron = NSRunningApplication(processIdentifier: electronPID) else {
            completion(["available": true, "skipped": true, "reason": "The isolated Electron process is unavailable"])
            return
        }
        guard electron.bundleIdentifier == "com.easton.pomodotimer" else {
            completion(["available": true, "skipped": true,
                        "reason": "Cmd-Tab requires the packaged product bundle ID to avoid grouping development Electron apps"])
            return
        }
        electron.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
            guard electron.isActive else {
                completion(["available": true, "skipped": true, "reason": "Could not confirm activation of the isolated Electron app"])
                return
            }
            NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
                guard NSRunningApplication.current.isActive else {
                    completion(["available": true, "skipped": true, "electronActivated": true,
                                "reason": "Could not confirm activation of the isolated probe app"])
                    return
                }
                let command = CGKeyCode(kVK_Command)
                let tab = CGKeyCode(kVK_Tab)
                for (key, down, flags) in [(command, true, CGEventFlags.maskCommand),
                                          (tab, true, CGEventFlags.maskCommand),
                                          (tab, false, CGEventFlags.maskCommand),
                                          (command, false, CGEventFlags())] {
                    let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down)
                    event?.flags = flags
                    event?.post(tap: .cghidEventTap)
                    usleep(80_000)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    completion(["available": true, "skipped": false, "electronActivated": true,
                                "probeActivated": true, "sent": true, "electronActiveAfter": electron.isActive,
                                "bundleID": electron.bundleIdentifier ?? ""])
                }
            }
        }
    }
}

if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--input-access" {
    print("{\"available\":\(CGPreflightPostEventAccess())}")
    exit(0)
}
// 领域：macOS / 原生缩放验收
// 顺序：调用方确认测试窗口 ID 与边界 -> 既有权限预检 -> 原生边缘拖动。
// 作用：验证透明 panel 的系统边缘缩放，而不以 setContentSize 代替用户操作。
// 原因：程序化改变尺寸不能证明原生窗口边缘接受拖动。
// 边界：不申请权限，不读取全局鼠标位置，仅使用调用方提供的自建窗口坐标。
if CommandLine.arguments.count == 6 && CommandLine.arguments[1] == "--drag",
   let startX = Double(CommandLine.arguments[2]), let startY = Double(CommandLine.arguments[3]),
   let endX = Double(CommandLine.arguments[4]), let endY = Double(CommandLine.arguments[5]) {
    guard CGPreflightPostEventAccess() else {
        print("{\"available\":false}")
        exit(0)
    }
    let start = CGPoint(x: startX, y: startY)
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(150_000)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(150_000)
    for step in 1...15 {
        let progress = Double(step) / 15
        let point = CGPoint(x: startX + (endX - startX) * progress, y: startY + (endY - startY) * progress)
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(20_000)
    }
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: CGPoint(x: endX, y: endY), mouseButton: .left)?.post(tap: .cghidEventTap)
    print("{\"available\":true,\"posted\":true}")
    exit(0)
}
guard CommandLine.arguments.count == 3,
      let electronPID = Int32(CommandLine.arguments[1]),
      let electronWindowID = UInt32(CommandLine.arguments[2]) else {
    fputs("Expected Electron PID and window ID\n", stderr)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = FullscreenProbe(electronPID: electronPID, electronWindowID: electronWindowID)
app.delegate = delegate
app.run()
