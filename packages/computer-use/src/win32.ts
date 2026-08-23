import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'
import type { ComputerUseService } from './computer-use'
import { ocrTesseract } from './ocr-tesseract'

const execAsync = promisify(execCallback)

/** Windows PowerShell 可执行名（Windows 10/11 自带 5.1） */
const PS = 'powershell.exe'

/** 写临时 .ps1 并执行；参数一律无空格安全值（坐标/数字/base64），避免引号地狱 */
async function runPs(script: string, args: string[] = []): Promise<void> {
  const file = join(tmpdir(), `shanhai-ps-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`)
  try {
    await fs.writeFile(file, script, 'utf8')
    const argStr = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(' ')
    await execAsync(`${PS} -NoProfile -ExecutionPolicy Bypass -File "${file}" ${argStr}`)
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined)
  }
}

/** 截图：System.Drawing 从虚拟屏幕 CopyFromScreen 存 PNG，并把鼠标光标画上去 */
const SHOT_PS = `
param([string]$OutPath)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CursorCapture {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct CURSORINFO {
    public int cbSize;
    public int flags;
    public IntPtr hCursor;
    public POINT ptScreenPos;
  }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
  [DllImport("user32.dll")] public static extern bool DrawIcon(IntPtr hdc, int x, int y, IntPtr hIcon);
}
"@
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
# 光标属于 GDI 覆盖层，CopyFromScreen 不会拷进来，需用 GetCursorInfo 手动读取并绘制
$ci = New-Object CursorCapture+CURSORINFO
$ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][CursorCapture+CURSORINFO])
if ([CursorCapture]::GetCursorInfo([ref]$ci) -and (($ci.flags -band 1) -eq 1)) {
  $hdc = $g.GetHdc()
  [void][CursorCapture]::DrawIcon($hdc, ($ci.ptScreenPos.X - $bounds.X), ($ci.ptScreenPos.Y - $bounds.Y), $ci.hCursor)
  $g.ReleaseHdc($hdc)
}
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`

/** 鼠标点击：SetCursorPos + mouse_event；Clicks=2 为双击 */
const CLICK_PS = `
param([int]$X, [int]$Y, [int]$Clicks = 1)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[WinInput]::SetCursorPos($X, $Y)
for ($i = 0; $i -lt $Clicks; $i++) {
  [WinInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [WinInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  if ($Clicks -gt 1) { Start-Sleep -Milliseconds 60 }
}
`

/** 输入文本：剪贴板 + Ctrl+V（支持中文），文本以 base64 传入避免参数转义问题 */
const TYPE_PS = `
param([string]$TextB64)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinInput {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$Text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextB64))
Set-Clipboard -Value $Text
[WinInput]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[WinInput]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
[WinInput]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)
[WinInput]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
`

/** 按键：keybd_event 按下 + 抬起 */
const KEY_PS = `
param([int]$Vk)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinInput {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[WinInput]::keybd_event($Vk, 0, 0, [UIntPtr]::Zero)
[WinInput]::keybd_event($Vk, 0, 2, [UIntPtr]::Zero)
`

/** 滚动：mouse_event 滚轮；Delta 正数向上、负数向下 */
const SCROLL_PS = `
param([int]$Delta)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinInput {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[WinInput]::mouse_event(0x0800, 0, 0, $Delta, [UIntPtr]::Zero)
`

/** Windows 键位名 → 虚拟键码 */
function winKeyCode(key: string): number {
  const map: Record<string, number> = {
    enter: 0x0d,
    return: 0x0d,
    space: 0x20,
    tab: 0x09,
    escape: 0x1b,
    esc: 0x1b,
    left: 0x25,
    right: 0x27,
    up: 0x26,
    down: 0x28,
  }
  return map[key.toLowerCase()] ?? 0
}

/** Windows computer-use：截图走 System.Drawing，OCR 走 tesseract.js，键鼠走 user32 P/Invoke */
export function createWin32ComputerUseService(): ComputerUseService {
  const screenshotToFile = async (): Promise<string> => {
    const tmp = join(tmpdir(), `shanhai-shot-${Date.now()}.png`)
    await runPs(SHOT_PS, [tmp])
    return tmp
  }

  return {
    screenshot: async () => {
      const tmp = await screenshotToFile()
      try {
        const buf = await fs.readFile(tmp)
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
      }
    },
    clickAt: async (x, y) => {
      await runPs(CLICK_PS, [String(Math.round(x)), String(Math.round(y)), '1']).catch(() => undefined)
    },
    doubleClickAt: async (x, y) => {
      await runPs(CLICK_PS, [String(Math.round(x)), String(Math.round(y)), '2']).catch(() => undefined)
    },
    typeText: async (text) => {
      const b64 = Buffer.from(text, 'utf8').toString('base64')
      await runPs(TYPE_PS, [b64]).catch(() => undefined)
    },
    pressKey: async (key) => {
      const vk = winKeyCode(key)
      if (!vk) return
      await runPs(KEY_PS, [String(vk)]).catch(() => undefined)
    },
    scroll: async (direction, amount) => {
      const lines = Math.max(1, Math.min(Math.round(amount ?? 3), 20))
      // Windows 滚轮：正数向上，负数向下，每格 120
      const delta = (direction === 'down' ? -1 : 1) * lines * 120
      await runPs(SCROLL_PS, [String(delta)]).catch(() => undefined)
    },
    ocr: async (imageBase64) => {
      let tmp = ''
      try {
        if (imageBase64) {
          tmp = join(tmpdir(), `shanhai-ocr-${Date.now()}.png`)
          await fs.writeFile(tmp, Buffer.from(imageBase64, 'base64'))
        } else {
          tmp = await screenshotToFile()
        }
        return await ocrTesseract(tmp)
      } finally {
        if (tmp) await fs.rm(tmp, { force: true }).catch(() => undefined)
      }
    },
  }
}
