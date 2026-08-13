# A global hotkey, without a native module.
#
# RegisterHotKey is the Win32 call that Spotlight-style launchers are built on:
# the key combination is claimed system-wide, so it fires while the user is in
# any application rather than only when a window of ours has focus. It needs a
# message loop to deliver WM_HOTKEY, which is why this is a script that parks
# rather than a command that returns.
#
# One line of stdout per press. The Node side reads those and opens the window,
# so this file never needs to know what a hotkey is for.
#
#   powershell -File hotkey.ps1 -Modifiers "ctrl+alt" -Key "Space"

param(
  [string]$Modifiers = 'ctrl+alt',
  [string]$Key = 'Space',
  # Claim the combination, report whether it was free, and let go again. Answers
  # "is this key already taken" without parking a listener on it.
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class AirHotkey {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);
  [StructLayout(LayoutKind.Sequential)]
  public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
}
'@

# MOD_ALT 1, MOD_CONTROL 2, MOD_SHIFT 4, MOD_WIN 8. MOD_NOREPEAT (0x4000) stops
# a held key from firing hundreds of times, which would open hundreds of windows.
$flags = 0x4000
foreach ($part in $Modifiers.ToLower().Split('+')) {
  switch ($part.Trim()) {
    'alt'   { $flags = $flags -bor 1 }
    'ctrl'  { $flags = $flags -bor 2 }
    'control' { $flags = $flags -bor 2 }
    'shift' { $flags = $flags -bor 4 }
    'win'   { $flags = $flags -bor 8 }
  }
}

try {
  $vk = [int][System.Windows.Forms.Keys]::$Key
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  $vk = [int][System.Windows.Forms.Keys]::$Key
}
if (-not $vk) { Write-Error "Unknown key '$Key'."; exit 1 }

if (-not [AirHotkey]::RegisterHotKey([IntPtr]::Zero, 1, $flags, $vk)) {
  # Almost always means another application already owns the combination.
  Write-Error "Could not register $Modifiers+$Key - something else on this computer already claims it."
  exit 1
}

Write-Output "ready $Modifiers+$Key"

if ($Probe) {
  [AirHotkey]::UnregisterHotKey([IntPtr]::Zero, 1) | Out-Null
  exit 0
}

try {
  $msg = New-Object AirHotkey+MSG
  # GetMessage blocks until something arrives, so this loop costs nothing while
  # it waits. WM_HOTKEY is 0x0312.
  while ([AirHotkey]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0) -gt 0) {
    if ($msg.message -eq 0x0312) {
      Write-Output 'hotkey'
      [Console]::Out.Flush()
    }
  }
} finally {
  [AirHotkey]::UnregisterHotKey([IntPtr]::Zero, 1) | Out-Null
}
