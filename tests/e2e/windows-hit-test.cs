using System;
using System.Runtime.InteropServices;

internal static class WindowsHitTest
{
    private const uint WM_NCHITTEST = 0x0084;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private const uint TimeoutMs = 2000;

    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr wParam,
        IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    private static bool Check(IntPtr window, string label, int x, int y, int expected)
    {
        // WM_NCHITTEST 把带符号的物理屏幕坐标分别放在 lParam 的高、低 16 位。
        IntPtr point = new IntPtr((y << 16) | (x & 0xffff));
        IntPtr result;
        IntPtr sent = SendMessageTimeoutW(window, WM_NCHITTEST, IntPtr.Zero, point, SMTO_ABORTIFHUNG, TimeoutMs, out result);
        if (sent == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            Console.Error.WriteLine("No WM_NCHITTEST reply for {0} at ({1},{2}) on HWND 0x{3:X}. " +
                "Timeout {4} ms, Win32 error {5}.", label, x, y, window.ToInt64(), TimeoutMs, error);
            return false;
        }
        if (result.ToInt64() != expected)
        {
            Console.Error.WriteLine("WM_NCHITTEST for {0} at ({1},{2}) on HWND 0x{3:X} returned {4}, expected {5}.",
                label, x, y, window.ToInt64(), result.ToInt64(), expected);
            return false;
        }
        return true;
    }

    private static int Main(string[] args)
    {
        IntPtr window = new IntPtr(Convert.ToInt64(args[0], 16));
        bool ring = Check(window, "timer ring (HTCAPTION)", int.Parse(args[1]), int.Parse(args[2]), 2);
        bool button = Check(window, "primary button (HTCLIENT)", int.Parse(args[3]), int.Parse(args[4]), 1);
        return ring && button ? 0 : 1;
    }
}
