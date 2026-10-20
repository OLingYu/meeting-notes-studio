/**
 * 系统原生的「选择文件夹」对话框（零第三方依赖）。
 *
 * Windows：直接调 COM 的 IFileOpenDialog + FOS_PICKFOLDERS，也就是资源管理器同款的
 *          现代「选择文件夹」窗口（Win7 以后的新式窗口，不是老的 SHBrowseForFolder 树）。
 *          C# 互操作代码用 PowerShell 的 Add-Type 现场编译；万一编译/调用失败，
 *          再退回 WinForms 的 FolderBrowserDialog 作为兜底。
 * macOS：osascript 的 choose folder
 * Linux：zenity --file-selection --directory
 * 都不可用时抛 NATIVE_DIALOG_UNAVAILABLE，由前端回退到内置目录浏览器。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../errors.mjs';

const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;
let busy = false;

function executableOnPath(name) {
  const pathValue = process.env.PATH || '';
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch { /* 忽略无法访问的目录 */ }
    }
  }
  return null;
}

function windowsPowerShell() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return executableOnPath('powershell');
}

/** 当前系统能不能弹出原生文件夹对话框 */
export function detectNativeDialog() {
  if (process.platform === 'win32') {
    const command = windowsPowerShell();
    if (command) {
      return {
        available: true,
        kind: 'windows-folder-dialog',
        label: 'Windows 系统文件夹选择窗口',
        command,
      };
    }
    return {
      available: false,
      kind: 'windows-folder-dialog',
      label: 'Windows 系统文件夹选择窗口',
      reason: '没有找到 powershell.exe',
    };
  }
  if (process.platform === 'darwin') {
    const command = executableOnPath('osascript');
    if (command) {
      return { available: true, kind: 'macos-choose-folder', label: 'macOS 选择文件夹窗口', command };
    }
    return {
      available: false,
      kind: 'macos-choose-folder',
      label: 'macOS 选择文件夹窗口',
      reason: '没有找到 osascript',
    };
  }
  const command = executableOnPath('zenity');
  if (command) {
    return { available: true, kind: 'linux-zenity', label: 'Linux 文件夹选择器（zenity）', command };
  }
  return {
    available: false,
    kind: 'linux-zenity',
    label: 'Linux 文件夹选择器',
    reason: '没有找到 zenity（可安装 zenity，或使用内置目录浏览器）',
  };
}

/** 供 /api/system/info 输出的公开信息（不带可执行文件路径） */
export function nativeDialogInfo() {
  const support = detectNativeDialog();
  return {
    available: support.available,
    kind: support.kind,
    label: support.label,
    reason: support.reason || '',
  };
}

/**
 * Windows 下要用到的 C# 互操作代码：
 * IFileOpenDialog + FOS_PICKFOLDERS —— 资源管理器同款的新式「选择文件夹」窗口。
 * 编译由 PowerShell 的 Add-Type 完成，注意本段代码必须是纯 ASCII（中文改由环境变量传入）。
 */
export const WINDOWS_CSHARP = `using System;
using System.Runtime.InteropServices;

public static class MnsFolderPicker
{
    [ComImport]
    [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig]
        int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }

    [ComImport]
    [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint form, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }

    [ComImport]
    [Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    // The script host is DPI-unaware by default, so Windows bitmap-scales its windows
    // and the dialog looks blurry. Switch to PER_MONITOR_AWARE_V2 (-4) before creating
    // any window so text is rendered at native pixels.
    public static void EnableDpiAwareness()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { }
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
        catch { }
        try { SetProcessDPIAware(); }
        catch { }
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bindContext,
        ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    public static string Pick(string title, string initialDirectory, IntPtr owner)
    {
        EnableDpiAwareness();
        IFileDialog dialog = (IFileDialog)new FileOpenDialog();
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | 0x00000020u | 0x00000040u | 0x00000800u);

        if (!string.IsNullOrWhiteSpace(title))
        {
            dialog.SetTitle(title);
        }

        if (!string.IsNullOrWhiteSpace(initialDirectory))
        {
            try
            {
                Guid iid = typeof(IShellItem).GUID;
                IShellItem folder;
                SHCreateItemFromParsingName(initialDirectory, IntPtr.Zero, ref iid, out folder);
                if (folder != null)
                {
                    dialog.SetFolder(folder);
                }
            }
            catch
            {
            }
        }

        int hr = dialog.Show(owner);
        if (hr != 0)
        {
            if ((uint)hr == 0x800704C7u)
            {
                return null;
            }
            Marshal.ThrowExceptionForHR(hr);
        }

        IShellItem result;
        dialog.GetResult(out result);
        if (result == null)
        {
            return null;
        }

        IntPtr buffer;
        result.GetDisplayName(0x80058000u, out buffer);
        if (buffer == IntPtr.Zero)
        {
            return null;
        }
        try
        {
            return Marshal.PtrToStringUni(buffer);
        }
        finally
        {
            Marshal.FreeCoTaskMem(buffer);
        }
    }
}`;

/**
 * 由 PowerShell 执行的脚本：
 * 1) 先切 DPI 感知（否则窗口会被位图放大，字发虚）；
 * 2) Add-Type 编译 C#，用 IFileOpenDialog 弹出新式「选择文件夹」窗口（资源管理器同款）；
 * 3) 用一个 1x1 的 TopMost 隐藏窗体当 owner，保证窗口出现在浏览器前面；
 * 4) 新式窗口不可用时退回 WinForms 的 FolderBrowserDialog；
 * 5) 结果统一以 UTF-8 字节写到 stdout（避免控制台 GBK 把中文路径弄乱）。
 */
export const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdout = [System.Console]::OpenStandardOutput()
function Emit([string]$text) {
  $bytes = $utf8.GetBytes($text + "\`n")
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

$csharp = @'
${WINDOWS_CSHARP}
'@

function New-HiddenOwner {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  $owner = New-Object System.Windows.Forms.Form
  $owner.Text = 'owner'
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.FormBorderStyle = 'None'
  $owner.StartPosition = 'Manual'
  $owner.Width = 1
  $owner.Height = 1
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()
  return $owner
}

function Pick-ModernFolder {
  if (-not ('MnsFolderPicker' -as [type])) {
    Add-Type -TypeDefinition $csharp -Language CSharp | Out-Null
  }
  [MnsFolderPicker]::EnableDpiAwareness()
  $owner = New-HiddenOwner
  try {
    return [MnsFolderPicker]::Pick($env:MNS_PICK_TITLE, $env:MNS_PICK_INITIAL, $owner.Handle)
  } finally {
    try { $owner.Close() } catch { }
  }
}

function Pick-LegacyFolder {
  try { if ('MnsFolderPicker' -as [type]) { [MnsFolderPicker]::EnableDpiAwareness() } } catch { }
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $owner = New-HiddenOwner
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.ShowNewFolderButton = $true
  if ($env:MNS_PICK_TITLE) { $dialog.Description = $env:MNS_PICK_TITLE }
  if ($env:MNS_PICK_INITIAL -and (Test-Path -LiteralPath $env:MNS_PICK_INITIAL)) {
    $dialog.SelectedPath = $env:MNS_PICK_INITIAL
  }
  $result = $dialog.ShowDialog($owner)
  $owner.Close()
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    return $dialog.SelectedPath
  }
  return $null
}

$path = $null
$modernError = $null
try {
  $path = Pick-ModernFolder
} catch {
  $modernError = $_.Exception.Message
}

if (-not $path -and $modernError) {
  try {
    $path = Pick-LegacyFolder
    $modernError = $null
  } catch {
    Emit ('ERROR:' + $modernError + ' / ' + $_.Exception.Message)
    exit 1
  }
}

if ($path) {
  Emit ('PICKED:' + $path)
} else {
  Emit 'CANCEL'
}
`.trim();

function escapeAppleScript(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildAppleScript({ title, initialPath }) {
  const prompt = escapeAppleScript(title || '选择文件夹');
  const location = escapeAppleScript(initialPath || '');
  const defaultPart = location ? ` default location (POSIX file "${location}")` : '';
  return `POSIX path of (choose folder with prompt "${prompt}"${defaultPart})`;
}

/**
 * 组装要执行的命令。
 * 返回 { kind, command, args, env }
 */
export function buildDialogCommand(support, { title = '选择文件夹', initialPath = '' } = {}) {
  if (!support?.available) {
    throw new AppError('当前系统无法使用原生文件夹对话框', {
      code: 'NATIVE_DIALOG_UNAVAILABLE',
      status: 501,
      hint: support?.reason || '可以使用内置的目录浏览器',
    });
  }

  if (support.kind === 'windows-folder-dialog') {
    // 脚本里有 C# 源码，直接塞进 -EncodedCommand 会撞上 Windows 命令行长度上限，
    // 所以运行前写入临时 .ps1 再用 -File 执行（脚本本身是纯 ASCII）。
    return {
      kind: support.kind,
      command: support.command,
      args: ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File'],
      env: {
        ...process.env,
        MNS_PICK_TITLE: title,
        MNS_PICK_INITIAL: initialPath || '',
      },
      script: WINDOWS_SCRIPT,
    };
  }

  if (support.kind === 'macos-choose-folder') {
    return {
      kind: support.kind,
      command: support.command,
      args: ['-e', buildAppleScript({ title, initialPath })],
      env: { ...process.env },
    };
  }

  const args = ['--file-selection', '--directory', `--title=${title || '选择文件夹'}`];
  if (initialPath) args.push(`--filename=${initialPath.replace(/\/+$/, '')}/`);
  return {
    kind: 'linux-zenity',
    command: support.command,
    args,
    env: { ...process.env },
  };
}

/** 把进程输出解析成 { canceled, path } */
export function parseDialogResult(kind, { code, stdout, stderr } = {}) {
  const text = String(stdout || '');
  const picked = /^PICKED:(.+)$/m.exec(text);
  if (picked) {
    const value = picked[1].trim().replace(/[\\/]+$/, '');
    if (!value) {
      throw new AppError('系统对话框没有返回有效路径', { code: 'NATIVE_DIALOG_FAILED', status: 500 });
    }
    return { canceled: false, path: value };
  }
  if (/^CANCEL\s*$/m.test(text)) return { canceled: true, path: null };

  const failed = /^ERROR:(.+)$/m.exec(text);
  if (failed) {
    throw new AppError(`系统对话框出错：${failed[1].trim()}`, {
      code: 'NATIVE_DIALOG_FAILED',
      status: 500,
      hint: '可以改用内置目录浏览器',
    });
  }

  if (kind === 'macos-choose-folder') {
    if (code !== 0) return { canceled: true, path: null };
    const value = text.trim().replace(/\/+$/, '');
    if (value) return { canceled: false, path: value };
    return { canceled: true, path: null };
  }

  if (kind === 'linux-zenity') {
    if (code === 1) return { canceled: true, path: null };
    const line = text.split('\n').map((s) => s.trim()).filter(Boolean).pop();
    if (line) return { canceled: false, path: line.replace(/\/+$/, '') };
    return { canceled: true, path: null };
  }

  if (code === 0) return { canceled: true, path: null };
  throw new AppError(`系统对话框异常退出（退出码 ${code}）：${String(stderr || '').trim().slice(0, 300)}`, {
    code: 'NATIVE_DIALOG_FAILED',
    status: 500,
    hint: '可以改用内置目录浏览器',
  });
}

/** Windows 需要先落一个临时 .ps1（脚本含 C#，不能整段塞进命令行） */
async function materializeScript(plan) {
  if (!plan.script) return { args: plan.args, cleanup: async () => {} };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mns-pick-'));
  const scriptFile = path.join(dir, 'pick.ps1');
  await fsp.writeFile(scriptFile, plan.script, 'utf8');
  return {
    args: [...plan.args, scriptFile],
    cleanup: async () => {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function spawnRunner(plan, { signal, timeoutMs = DIALOG_TIMEOUT_MS } = {}) {
  const prepared = await materializeScript(plan);
  try {
    return await runProcess(plan.command, prepared.args, plan.env, { signal, timeoutMs });
  } finally {
    await prepared.cleanup();
  }
}

function runProcess(command, args, env, { signal, timeoutMs = DIALOG_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      reject(new AppError(`无法启动系统对话框：${err.message}`, {
        code: 'SPAWN_FAILED',
        status: 500,
        hint: '可以改用内置目录浏览器',
      }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const kill = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    };
    const onAbort = () => {
      kill();
      settle(reject, new AppError('已取消等待文件夹选择', { code: 'ABORTED', status: 499 }));
    };

    timer = setTimeout(() => {
      kill();
      settle(reject, new AppError('等待文件夹选择超时', {
        code: 'DIALOG_TIMEOUT',
        status: 504,
        hint: '重新点一次按钮即可',
      }));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      settle(reject, new AppError(`系统对话框进程启动失败：${err.message}`, {
        code: 'SPAWN_FAILED',
        status: 500,
        hint: '可以改用内置目录浏览器',
      }));
    });
    child.on('close', (code) => {
      settle(resolve, { code, stdout, stderr });
    });
  });
}

/**
 * 打开系统原生文件夹选择窗口，等到用户选完（或取消）才返回。
 * @param {object} options
 * @param {string} [options.title] 窗口标题
 * @param {string} [options.initialPath] 初始目录
 * @param {AbortSignal} [options.signal] 客户端断开时中止
 * @param {Function} [options.runner] 测试注入
 * @param {object} [options.support] 测试注入的 detectNativeDialog 结果
 */
export async function pickDirectoryNative({
  title = '选择文件夹',
  initialPath = '',
  signal,
  runner,
  support,
} = {}) {
  const info = support || detectNativeDialog();
  if (!info.available) {
    throw new AppError('当前系统无法使用原生文件夹对话框', {
      code: 'NATIVE_DIALOG_UNAVAILABLE',
      status: 501,
      hint: info.reason || '可以使用内置的目录浏览器',
    });
  }
  if (busy) {
    throw new AppError('已经有一个文件夹选择窗口打开了', {
      code: 'DIALOG_BUSY',
      status: 409,
      hint: '请先完成（或取消）当前弹出的选择窗口',
    });
  }

  busy = true;
  try {
    const plan = buildDialogCommand(info, { title, initialPath });
    const run = runner || spawnRunner;
    const result = await run(plan, { signal, timeoutMs: DIALOG_TIMEOUT_MS });
    return parseDialogResult(plan.kind, result);
  } finally {
    busy = false;
  }
}

export { DIALOG_TIMEOUT_MS };
