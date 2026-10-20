import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildDialogCommand,
  buildAppleScript,
  parseDialogResult,
  detectNativeDialog,
  nativeDialogInfo,
  pickDirectoryNative,
  WINDOWS_CSHARP,
  WINDOWS_SCRIPT,
  DIALOG_TIMEOUT_MS,
} from '../../server/lib/native-dialog.mjs';

const WIN_SUPPORT = {
  available: true,
  kind: 'windows-folder-dialog',
  label: 'Windows 系统文件夹对话框',
  command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
};

function runnerWith(result) {
  return async (plan) => {
    if (typeof result === 'function') return result(plan);
    return result;
  };
}

test('parseDialogResult：Windows 选中路径', () => {
  const result = parseDialogResult('windows-folder-dialog', {
    code: 0,
    stdout: 'PICKED:D:\\工作区\\会议录音\\\r\n',
    stderr: '',
  });
  assert.equal(result.canceled, false);
  assert.equal(result.path, 'D:\\工作区\\会议录音');
});

test('parseDialogResult：Windows 取消', () => {
  const result = parseDialogResult('windows-folder-dialog', { code: 0, stdout: 'CANCEL\r\n', stderr: '' });
  assert.deepEqual(result, { canceled: true, path: null });
});

test('parseDialogResult：脚本内报错抛出可读错误', () => {
  assert.throws(
    () => parseDialogResult('windows-folder-dialog', { code: 1, stdout: 'ERROR:找不到类型\r\n', stderr: '' }),
    (err) => err.code === 'NATIVE_DIALOG_FAILED' && /找不到类型/.test(err.message) && Boolean(err.hint),
  );
});

test('parseDialogResult：异常退出码也有兜底', () => {
  assert.throws(
    () => parseDialogResult('windows-folder-dialog', { code: 5, stdout: '', stderr: 'boom' }),
    (err) => err.code === 'NATIVE_DIALOG_FAILED',
  );
  assert.deepEqual(
    parseDialogResult('windows-folder-dialog', { code: 0, stdout: '', stderr: '' }),
    { canceled: true, path: null },
  );
});

test('parseDialogResult：macOS 与 Linux 输出', () => {
  assert.deepEqual(
    parseDialogResult('macos-choose-folder', { code: 0, stdout: '/Users/me/会议/\n', stderr: '' }),
    { canceled: false, path: '/Users/me/会议' },
  );
  assert.deepEqual(
    parseDialogResult('macos-choose-folder', { code: 1, stdout: '', stderr: 'User canceled.' }),
    { canceled: true, path: null },
  );
  assert.deepEqual(
    parseDialogResult('linux-zenity', { code: 0, stdout: '/home/me/会议\n', stderr: '' }),
    { canceled: false, path: '/home/me/会议' },
  );
  assert.deepEqual(
    parseDialogResult('linux-zenity', { code: 1, stdout: '', stderr: '' }),
    { canceled: true, path: null },
  );
});

test('buildDialogCommand：Windows 用 -File 执行临时脚本，并通过环境变量传参', () => {
  const plan = buildDialogCommand(WIN_SUPPORT, { title: '选择工作区', initialPath: 'D:\\旧目录' });
  assert.equal(plan.kind, 'windows-folder-dialog');
  assert.equal(plan.command, WIN_SUPPORT.command);
  assert.ok(plan.args.includes('-Sta'));
  assert.equal(plan.args.at(-1), '-File');
  assert.equal(plan.env.MNS_PICK_TITLE, '选择工作区');
  assert.equal(plan.env.MNS_PICK_INITIAL, 'D:\\旧目录');

  // 脚本内容随命令一起带出，运行时会写入临时 .ps1
  assert.equal(plan.script, WINDOWS_SCRIPT);
  assert.match(plan.script, /MnsFolderPicker/);
  assert.match(plan.script, /IFileDialog/);
  assert.match(plan.script, /FolderBrowserDialog/);
  assert.match(plan.script, /PICKED:/);
  assert.match(plan.script, /CANCEL/);
  // Windows PowerShell 5.1 用 -File 时按 ANSI 读无 BOM 文件，所以脚本必须是纯 ASCII
  assert.match(plan.script, /^[\x09\x0a\x0d\x20-\x7e]*$/);
});

test('WINDOWS_CSHARP 必须是纯 ASCII（避免 Add-Type 编译时的编码问题）', () => {
  assert.ok(WINDOWS_CSHARP.length > 500);
  assert.match(WINDOWS_CSHARP, /^[\x09\x0a\x0d\x20-\x7e]*$/);
  assert.match(WINDOWS_CSHARP, /class MnsFolderPicker/);
  assert.match(WINDOWS_CSHARP, /0x00000020u/);
});

test('DPI：脚本与 C# 都会切成 per-monitor aware，避免窗口被位图放大', () => {
  // DPI 不感知的宿主会让 Windows 把窗口位图放大，字就发虚
  assert.match(WINDOWS_CSHARP, /SetProcessDpiAwarenessContext/);
  assert.match(WINDOWS_CSHARP, /SetThreadDpiAwarenessContext/);
  assert.match(WINDOWS_CSHARP, /SetProcessDPIAware/);
  assert.match(WINDOWS_CSHARP, /public static void EnableDpiAwareness\(\)/);
  assert.match(WINDOWS_CSHARP, /EnableDpiAwareness\(\);/);

  // 脚本必须先启用 DPI 感知，再创建任何窗体
  const dpiAt = WINDOWS_SCRIPT.indexOf('[MnsFolderPicker]::EnableDpiAwareness()');
  const ownerAt = WINDOWS_SCRIPT.indexOf('$owner = New-HiddenOwner');
  assert.ok(dpiAt > 0 && ownerAt > 0 && dpiAt < ownerAt, 'EnableDpiAwareness 必须早于窗体创建');
});

test('窗口前置：用 1x1 TopMost 隐藏窗体作为对话框的 owner', () => {
  assert.match(WINDOWS_SCRIPT, /function New-HiddenOwner/);
  assert.match(WINDOWS_SCRIPT, /\$owner\.TopMost = \$true/);
  assert.match(WINDOWS_SCRIPT, /\$owner\.ShowInTaskbar = \$false/);
  assert.match(WINDOWS_SCRIPT, /\[MnsFolderPicker\]::Pick\(\$env:MNS_PICK_TITLE, \$env:MNS_PICK_INITIAL, \$owner\.Handle\)/);
});

test('buildDialogCommand：macOS 与 Linux 参数', () => {
  const mac = buildDialogCommand(
    { available: true, kind: 'macos-choose-folder', command: '/usr/bin/osascript' },
    { title: '选择"文件夹"', initialPath: '/Users/me' },
  );
  assert.equal(mac.command, '/usr/bin/osascript');
  assert.equal(mac.args[0], '-e');
  assert.match(mac.args[1], /choose folder with prompt "选择\\"文件夹\\""/);
  assert.match(mac.args[1], /default location \(POSIX file "\/Users\/me"\)/);

  const linux = buildDialogCommand(
    { available: true, kind: 'linux-zenity', command: '/usr/bin/zenity' },
    { title: '选择工作区', initialPath: '/home/me' },
  );
  assert.deepEqual(linux.args, ['--file-selection', '--directory', '--title=选择工作区', '--filename=/home/me/']);
});

test('buildDialogCommand：原生不可用时抛 NATIVE_DIALOG_UNAVAILABLE', () => {
  assert.throws(
    () => buildDialogCommand({ available: false, reason: '没有找到 zenity' }, {}),
    (err) => err.code === 'NATIVE_DIALOG_UNAVAILABLE' && /zenity/.test(err.hint),
  );
});

test('buildAppleScript 转义反斜杠与引号', () => {
  const script = buildAppleScript({ title: 'a"b\\c', initialPath: '/tmp/x"y' });
  assert.match(script, /a\\"b\\\\c/);
  assert.match(script, /\/tmp\/x\\"y/);
});

test('detectNativeDialog / nativeDialogInfo 返回可用信息', () => {
  const support = detectNativeDialog();
  assert.equal(typeof support.available, 'boolean');
  assert.equal(typeof support.kind, 'string');
  if (process.platform === 'win32') {
    assert.equal(support.available, true);
    assert.equal(support.kind, 'windows-folder-dialog');
    assert.ok(support.command);
  }
  const info = nativeDialogInfo();
  assert.equal(typeof info.label, 'string');
  assert.equal(info.command, undefined);
});

test('pickDirectoryNative：选中路径 / 取消 / 出错', async () => {
  const picked = await pickDirectoryNative({
    title: '选择文件夹',
    initialPath: 'D:\\起点',
    support: WIN_SUPPORT,
    runner: runnerWith({ code: 0, stdout: 'PICKED:D:\\选中的目录\r\n', stderr: '' }),
  });
  assert.deepEqual(picked, { canceled: false, path: 'D:\\选中的目录' });

  const canceled = await pickDirectoryNative({
    support: WIN_SUPPORT,
    runner: runnerWith({ code: 0, stdout: 'CANCEL', stderr: '' }),
  });
  assert.deepEqual(canceled, { canceled: true, path: null });

  await assert.rejects(
    () => pickDirectoryNative({
      support: WIN_SUPPORT,
      runner: runnerWith({ code: 1, stdout: 'ERROR:拒绝访问', stderr: '' }),
    }),
    (err) => err.code === 'NATIVE_DIALOG_FAILED',
  );
});

test('pickDirectoryNative：把标题与初始目录传给 runner', async () => {
  let seen = null;
  await pickDirectoryNative({
    title: '选择交付文件夹',
    initialPath: 'D:\\交付',
    support: WIN_SUPPORT,
    runner: async (plan) => {
      seen = plan;
      return { code: 0, stdout: 'CANCEL', stderr: '' };
    },
  });
  assert.equal(seen.env.MNS_PICK_TITLE, '选择交付文件夹');
  assert.equal(seen.env.MNS_PICK_INITIAL, 'D:\\交付');
});

test('pickDirectoryNative：同一时间只允许一个对话框', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = pickDirectoryNative({
    support: WIN_SUPPORT,
    runner: async () => {
      await gate;
      return { code: 0, stdout: 'CANCEL', stderr: '' };
    },
  });
  await assert.rejects(
    () => pickDirectoryNative({ support: WIN_SUPPORT, runner: runnerWith({ code: 0, stdout: 'CANCEL' }) }),
    (err) => err.code === 'DIALOG_BUSY',
  );
  release();
  await slow;
  // 释放后可以再次使用
  const again = await pickDirectoryNative({
    support: WIN_SUPPORT,
    runner: runnerWith({ code: 0, stdout: 'PICKED:D:\\ok' }),
  });
  assert.equal(again.path, 'D:\\ok');
});

test('pickDirectoryNative：中止信号会被透传', async () => {
  const controller = new AbortController();
  await assert.rejects(
    () => pickDirectoryNative({
      support: WIN_SUPPORT,
      signal: controller.signal,
      runner: async () => {
        controller.abort();
        const err = new Error('已取消等待文件夹选择');
        err.code = 'ABORTED';
        throw err;
      },
    }),
    (err) => err.code === 'ABORTED',
  );
});

test('pickDirectoryNative：原生不可用时给出可回退的错误码', async () => {
  await assert.rejects(
    () => pickDirectoryNative({ support: { available: false, reason: '没有找到 zenity' } }),
    (err) => err.code === 'NATIVE_DIALOG_UNAVAILABLE',
  );
});

test('DIALOG_TIMEOUT_MS 足够长（用户慢慢选也不会被杀）', () => {
  assert.ok(DIALOG_TIMEOUT_MS >= 60_000);
});

/** 本机 PowerShell 能否解析脚本（不弹窗，仅校验环境） */
test('Windows 脚本可被 PowerShell 解析', { skip: process.platform !== 'win32' }, async () => {
  const support = detectNativeDialog();
  assert.equal(support.available, true, 'Windows 上应能找到 powershell.exe');
  const plan = buildDialogCommand(support, { title: '校验', initialPath: '' });

  const scriptFile = path.join(os.tmpdir(), `mns-picker-${Date.now()}.ps1`);
  await fs.writeFile(scriptFile, plan.script, 'utf8');
  try {
    const check = [
      "$ErrorActionPreference = 'Stop'",
      `$parseErrors = $null`,
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${scriptFile}', [ref]$null, [ref]$parseErrors)`,
      'if ($parseErrors.Count -gt 0) {',
      "  $parseErrors | ForEach-Object { Write-Output ('PARSE_ERROR:' + $_.Message) }",
      '  exit 1',
      '}',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      "Write-Output 'SCRIPT_OK'",
    ].join('\n');

    const stdout = await new Promise((resolve, reject) => {
      execFile(
        support.command,
        ['-NoProfile', '-Sta', '-Command', check],
        { timeout: 40000, windowsHide: true },
        (err, out, errOut) => {
          if (err) reject(new Error(`${err.message}\n${errOut || ''}`));
          else resolve(out);
        },
      );
    });

    assert.match(stdout, /SCRIPT_OK/);
    assert.doesNotMatch(stdout, /PARSE_ERROR/);
  } finally {
    await fs.rm(scriptFile, { force: true });
  }
});

/** 新的 IFileOpenDialog 互操作代码能否被 Add-Type 编译（不弹窗） */
test('Windows C# 互操作代码可以用 Add-Type 编译', { skip: process.platform !== 'win32' }, async () => {
  const support = detectNativeDialog();
  const csFile = path.join(os.tmpdir(), `mns-picker-${Date.now()}.cs`);
  await fs.writeFile(csFile, WINDOWS_CSHARP, 'utf8');
  try {
    const check = [
      "$ErrorActionPreference = 'Stop'",
      `Add-Type -TypeDefinition (Get-Content -LiteralPath '${csFile}' -Raw -Encoding UTF8) -Language CSharp`,
      "if ('MnsFolderPicker' -as [type]) { Write-Output 'CSHARP_OK' } else { Write-Output 'CSHARP_MISSING' }",
    ].join('\n');

    const stdout = await new Promise((resolve, reject) => {
      execFile(
        support.command,
        ['-NoProfile', '-Sta', '-EncodedCommand', Buffer.from(check, 'utf16le').toString('base64')],
        { timeout: 60000, windowsHide: true },
        (err, out, errOut) => {
          if (err) reject(new Error(`${err.message}\n${errOut || ''}`));
          else resolve(out);
        },
      );
    });

    assert.match(stdout, /CSHARP_OK/);
  } finally {
    await fs.rm(csFile, { force: true });
  }
});
