import AppKit
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
            self.window.toggleFullScreen(nil)
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
        if let error = error { result["error"] = error }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) { print(text) }
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
