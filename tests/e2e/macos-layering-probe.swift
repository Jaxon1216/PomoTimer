import AppKit
import CoreGraphics
import Foundation

final class LayeringProbe: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let timerPID: Int32
    private var timerWindowID: UInt32
    private var window: NSWindow!
    private var fullscreenLabel: String?

    init(timerPID: Int32, timerWindowID: UInt32) {
        self.timerPID = timerPID
        self.timerWindowID = timerWindowID
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let rectangle = coveringRectangle() else {
            emit(["error": "The isolated timer window must be on screen before starting the probe"])
            NSApplication.shared.terminate(nil)
            return
        }
        window = NSWindow(contentRect: rectangle, styleMask: [.titled, .closable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Pomodoro isolated layering validation"
        window.level = .normal
        window.delegate = self
        window.collectionBehavior = [.fullScreenPrimary]
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.emit(["ready": true]) }
        DispatchQueue.global().async {
            while let line = readLine() {
                guard let data = line.data(using: .utf8),
                      let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] else { continue }
                DispatchQueue.main.async { self.receive(request) }
            }
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { NSApplication.shared.terminate(nil) }
    }

    private func receive(_ request: [String: String]) {
        let label = request["label"] ?? "sample"
        switch request["command"] {
        case "activate":
            activateAndSample(label, attempts: 20)
        case "sample":
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.sample(label) }
        case "target":
            guard let id = request["windowID"].flatMap(UInt32.init) else {
                emit(["error": "A native target window ID is required"])
                return
            }
            timerWindowID = id
            retargetAndSample(label, attempts: 20)
        case "fullscreen":
            fullscreenLabel = label
            window.toggleFullScreen(nil)
        case "quit":
            window.close()
            NSApplication.shared.terminate(nil)
        default:
            emit(["error": "Unsupported probe command"])
        }
    }

    private func retargetAndSample(_ label: String, attempts: Int) {
        if let rectangle = coveringRectangle() {
            if !window.styleMask.contains(.fullScreen) { window.setFrame(rectangle, display: true) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.sample(label) }
        } else if attempts > 1 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.retargetAndSample(label, attempts: attempts - 1) }
        } else {
            emit(["error": "The exact native target did not reach the Window Server visible list"])
        }
    }

    private func activateAndSample(_ label: String, attempts: Int) {
        NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        window.makeKeyAndOrderFront(nil)
        window.makeKey()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            if NSApplication.shared.isActive && self.window.isKeyWindow {
                self.sample(label)
            } else if attempts > 1 {
                self.activateAndSample(label, attempts: attempts - 1)
            } else {
                self.emit(["error": "The synthetic ordinary application could not acquire the activation precondition"])
            }
        }
    }

    func windowDidEnterFullScreen(_ notification: Notification) { fullscreenChanged() }
    func windowDidExitFullScreen(_ notification: Notification) { fullscreenChanged() }

    private func fullscreenChanged() {
        guard let label = fullscreenLabel else { return }
        fullscreenLabel = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.sample(label) }
    }

    private func coveringRectangle() -> NSRect? {
        guard let timer = ownWindows().first(where: { ($0[kCGWindowNumber as String] as? UInt32) == timerWindowID }),
              let bounds = boundsOf(timer), let desktopTop = NSScreen.screens.first?.frame.maxY else { return nil }
        return NSRect(x: bounds.minX - 20, y: desktopTop - bounds.maxY - 20,
                      width: bounds.width + 40, height: bounds.height + 40)
    }

    // 领域：macOS / 普通应用遮挡回归
    // 顺序：自建普通应用激活 -> Window Server 顺序 -> 精确两个测试窗口。
    // 作用：确认真实计时器在重叠普通窗口上方，且没有取得普通应用的键盘焦点。
    // 原因：isAlwaysOnTop 不能证明实际窗口顺序；只看层级也不能证明窗口重叠。
    // 边界：不截屏、不输出其他应用信息，只保留本脚本启动的两个进程窗口。
    private func ownWindows() -> [[String: Any]] {
        let ownPIDs = Set([timerPID, ProcessInfo.processInfo.processIdentifier])
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return windows.filter { info in
            guard let pid = info[kCGWindowOwnerPID as String] as? Int32 else { return false }
            return ownPIDs.contains(pid)
        }
    }

    private func sample(_ label: String) {
        let windows = ownWindows()
        let timerIndex = windows.firstIndex { ($0[kCGWindowNumber as String] as? UInt32) == timerWindowID }
        let probeIndex = windows.firstIndex { ($0[kCGWindowNumber as String] as? Int) == window.windowNumber }
        let timer = timerIndex.map { windows[$0] }
        let probe = probeIndex.map { windows[$0] }
        let timerBounds = timer.flatMap(boundsOf)
        let probeBounds = probe.flatMap(boundsOf)
        emit([
            "label": label,
            "probeActive": NSApplication.shared.isActive,
            "timerAppActive": NSRunningApplication(processIdentifier: timerPID)?.isActive ?? false,
            "probeKeyWindow": window.isKeyWindow,
            "probeFullscreen": window.styleMask.contains(.fullScreen),
            "targetWindowID": timerWindowID,
            "timerOnScreen": timer != nil,
            "probeOnScreen": probe != nil,
            "overlap": timerBounds.map { timer in probeBounds.map { $0.intersects(timer) } ?? false } ?? false,
            "timerAboveProbe": timerIndex.map { timer in probeIndex.map { timer < $0 } ?? false } ?? false,
            "timerLayer": timer?[kCGWindowLayer as String] ?? -1,
            "probeLayer": probe?[kCGWindowLayer as String] ?? -1,
            "targetBounds": timer?[kCGWindowBounds as String] ?? [:],
            "probeBounds": probe?[kCGWindowBounds as String] ?? [:],
        ])
    }

    private func boundsOf(_ window: [String: Any]) -> CGRect? {
        guard let bounds = window[kCGWindowBounds as String] as? [String: NSNumber],
              let x = bounds["X"], let y = bounds["Y"],
              let width = bounds["Width"], let height = bounds["Height"] else { return nil }
        return CGRect(x: x.doubleValue, y: y.doubleValue, width: width.doubleValue, height: height.doubleValue)
    }

    private func emit(_ result: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            print(text)
            fflush(stdout)
        }
    }
}

guard CommandLine.arguments.count == 3,
      let timerPID = Int32(CommandLine.arguments[1]),
      let timerWindowID = UInt32(CommandLine.arguments[2]) else {
    fputs("Usage: macos-layering-probe <isolated-timer-pid> <timer-window-id>\n", stderr)
    exit(2)
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = LayeringProbe(timerPID: timerPID, timerWindowID: timerWindowID)
application.delegate = delegate
application.run()
