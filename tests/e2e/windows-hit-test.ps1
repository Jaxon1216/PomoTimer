param([string]$WindowHandleHex, [int]$RingX, [int]$RingY, [int]$ButtonX, [int]$ButtonY)
$ErrorActionPreference = 'Stop'

Add-Type -Namespace PomodoroTest -Name User32 -MemberDefinition @'
[DllImport("user32.dll")]
public static extern IntPtr SendMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
'@

# WM_NCHITTEST takes signed physical screen coordinates in the two words of lParam.
$handle = [IntPtr]([Convert]::ToInt64($WindowHandleHex, 16))
function Get-HitTest([int]$X, [int]$Y) {
    $point = [IntPtr](($Y -shl 16) -bor ($X -band 0xffff))
    return [PomodoroTest.User32]::SendMessageW($handle, 0x0084, [IntPtr]::Zero, $point).ToInt32()
}

$ring = Get-HitTest $RingX $RingY
$button = Get-HitTest $ButtonX $ButtonY
if ($ring -ne 2 -or $button -ne 1) {
    throw "WM_NCHITTEST for HWND 0x$WindowHandleHex returned $ring at the ring ($RingX,$RingY), expected HTCAPTION (2), and $button at the primary button ($ButtonX,$ButtonY), expected HTCLIENT (1)."
}
