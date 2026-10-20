/**
 * 端到端测试：启动假模型服务 + 真实后端，跑通四种流程组合与三条协议。
 * 全程不联网、不需要任何真实密钥。
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockProvider, MOCK_MINUTES } from './mock-provider.mjs';
import { createApp } from '../server/index.mjs';
import { MASK } from '../server/config.mjs';

let provider;
let app;
let tmpRoot;
let dataDir;
let workspaceDir;
let workspaceId;

const logListeners = new Set();

/** 可用的测试日志器：写任务日志文件并广播，方便验证 SSE */
function makeTestLogger() {
  const write = (level, message, taskId) => {
    const entry = { at: Date.now(), level, message, taskId, formatted: `[mock] ${message}` };
    if (taskId) {
      const dir = path.join(dataDir, 'tasks', taskId);
      fs.mkdir(dir, { recursive: true })
        .then(() => fs.appendFile(path.join(dir, 'log.jsonl'), `${JSON.stringify(entry)}\n`))
        .catch(() => {});
    }
    for (const listener of logListeners) listener(entry);
  };
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    debug: () => {},
    subscribe(fn) {
      logListeners.add(fn);
      return () => logListeners.delete(fn);
    },
    task(taskId) {
      return {
        info: (m) => write('info', m, taskId),
        warn: (m) => write('warn', m, taskId),
        error: (m) => write('error', m, taskId),
        debug: () => {},
      };
    },
  };
}

function api(pathname, { method = 'GET', body } = {}) {
  return (async () => {
    const res = await fetch(`${app.url}${pathname.replace(/^\//, '')}`, {
      method,
      headers: {
        'x-app-token': app.token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  })();
}

async function setModels(models) {
  const res = await api('/api/config', { method: 'PUT', body: { models } });
  assert.equal(res.status, 200, `配置保存失败：${JSON.stringify(res.data)}`);
}

const openaiBase = () => `${provider.baseUrl}/v1`;

function openaiModels() {
  return {
    transcribe: { kind: 'openai-asr', baseUrl: openaiBase(), apiKey: 'sk-mock', model: 'mock-asr', timeoutSec: 60, maxRetries: 1 },
    polish: { kind: 'openai-chat', baseUrl: openaiBase(), apiKey: 'sk-mock', model: 'mock-chat', timeoutSec: 60, maxRetries: 1 },
    minutes: { kind: 'openai-chat', baseUrl: openaiBase(), apiKey: 'sk-mock', model: 'mock-chat', timeoutSec: 60, maxRetries: 1 },
  };
}

async function waitForTask(id, timeoutMs = 40000) {
  const started = Date.now();
  for (;;) {
    const { data } = await api(`/api/tasks/${id}`);
    const task = data.task;
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(task.status)) return task;
    if (Date.now() - started > timeoutMs) throw new Error(`任务 ${id} 超时未结束（状态 ${task.status}）`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function runTask({ steps, inputName, title }) {
  const create = await api('/api/tasks', {
    method: 'POST',
    body: {
      workspaceId,
      steps,
      inputPath: path.join(workspaceDir, inputName),
      title,
    },
  });
  assert.equal(create.status, 200, `创建任务失败：${JSON.stringify(create.data)}`);
  return waitForTask(create.data.task.id);
}

function artifactOf(task, step) {
  return task.artifacts.find((a) => a.step === step);
}

async function readArtifact(task, step) {
  const { status, data } = await api(`/api/tasks/${task.id}/artifacts/${step}`);
  assert.equal(status, 200, `读取产物失败：${JSON.stringify(data)}`);
  return data.artifact.content;
}

/* 假的原生文件夹对话框：不弹窗，直接返回预设结果 */
let pickMode = 'path';
let lastPickPlan = null;
async function fakePickRunner(plan) {
  lastPickPlan = plan;
  if (pickMode === 'cancel') return { code: 0, stdout: 'CANCEL\n', stderr: '' };
  if (pickMode === 'error') return { code: 1, stdout: 'ERROR:模拟对话框失败\n', stderr: '' };
  if (pickMode === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { code: 0, stdout: `PICKED:${workspaceDir}\r\n`, stderr: '' };
  }
  return { code: 0, stdout: `PICKED:${workspaceDir}\r\n`, stderr: '' };
}

before(async () => {
  provider = await startMockProvider();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mns-e2e-'));
  workspaceDir = path.join(tmpRoot, '工作区');
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, '周会录音.mp3'), Buffer.alloc(180_000, 7));
  await fs.writeFile(
    path.join(workspaceDir, '会议字幕.srt'),
    ['1', '00:00:00,000 --> 00:00:05,000', '大家好，今天开个短会。', '', '2', '00:00:05,000 --> 00:00:12,000', '主要同步进度。'].join('\n'),
    'utf8',
  );
  await fs.writeFile(path.join(workspaceDir, '会议文本.txt'), '这是一段会议文本，用于测试纯文本输入。\n第二行内容。', 'utf8');

  dataDir = path.join(tmpRoot, 'data');
  app = await createApp({
    dataDir,
    port: 0,
    logger: makeTestLogger(),
    pickDirectoryRunner: fakePickRunner,
  });

  const created = await api('/api/workspaces', { method: 'POST', body: { path: workspaceDir, name: '测试工作区' } });
  assert.equal(created.status, 200, `创建工作区失败：${JSON.stringify(created.data)}`);
  workspaceId = created.data.workspace.id;
});

after(async () => {
  await app?.close();
  await provider?.close();
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('配置接口：密钥脱敏，槽位状态正确', async () => {
  await setModels(openaiModels());
  const { status, data } = await api('/api/config');
  assert.equal(status, 200);
  assert.equal(data.config.models.transcribe.apiKey, MASK);
  assert.equal(data.config.models.transcribe.hasApiKey, true);
  assert.equal(data.slots.allConfigured, true);
});

test('全部三项：音频 → 转写原文 + 润色 + 纪要', async () => {
  await setModels(openaiModels());
  const task = await runTask({
    steps: ['transcribe', 'polish', 'minutes'],
    inputName: '周会录音.mp3',
    title: '全流程测试',
  });

  assert.equal(task.status, 'succeeded', `任务失败：${JSON.stringify(task.error)}`);
  assert.equal(task.progress, 100);
  assert.equal(task.artifacts.length, 3);
  assert.deepEqual(task.artifacts.map((a) => a.step).sort(), ['minutes', 'polish', 'transcribe']);
  assert.equal(task.deliveryDir, workspaceDir);

  for (const artifact of task.artifacts) {
    const stat = await fs.stat(artifact.path);
    assert.ok(stat.size > 0, `${artifact.fileName} 是空文件`);
    assert.ok(artifact.path.startsWith(workspaceDir), '产物没有写到交付区');
  }

  const transcript = await readArtifact(task, 'transcribe');
  assert.match(transcript, /^# 转写原文：周会录音\.mp3/m);
  assert.match(transcript, /\[00:00:00\.0 - 00:00:12\.5\] 大家好/);
  assert.match(transcript, /时间戳：精确/);
  assert.equal(task.summary.segments, 5);

  const polished = await readArtifact(task, 'polish');
  assert.match(polished, /^# 润色稿：周会录音\.mp3/m);
  assert.match(polished, /本次会议围绕转写工具接入/);

  const minutes = await readArtifact(task, 'minutes');
  assert.match(minutes, /^# 会议纪要：周会录音\.mp3/m);
  assert.match(minutes, /## 会议信息/);
  assert.match(minutes, /## 待办事项/);

  // 上传给转写接口的表单里，file 必须是最后一个字段
  const order = provider.stats.transcriptionFieldOrder || [];
  assert.equal(order.at(-1), 'file');
});

test('润色 + 纪要：文本输入（srt）只产出两份', async () => {
  await setModels(openaiModels());
  const task = await runTask({
    steps: ['polish', 'minutes'],
    inputName: '会议字幕.srt',
    title: '文本输入测试',
  });
  assert.equal(task.status, 'succeeded', `任务失败：${JSON.stringify(task.error)}`);
  assert.equal(task.input.kind, 'text');
  assert.equal(task.artifacts.length, 2);
  assert.equal(artifactOf(task, 'transcribe'), undefined);
  const minutes = await readArtifact(task, 'minutes');
  assert.match(minutes, /## 核心议题与结论/);
  const polished = await readArtifact(task, 'polish');
  assert.match(polished, /你提供的文本/);
});

test('转写 + 纪要：纪要基于原文并产出两份', async () => {
  await setModels(openaiModels());
  const task = await runTask({
    steps: ['transcribe', 'minutes'],
    inputName: '周会录音.mp3',
    title: '无润色流程',
  });
  assert.equal(task.status, 'succeeded', `任务失败：${JSON.stringify(task.error)}`);
  assert.equal(task.artifacts.length, 2);
  assert.equal(artifactOf(task, 'polish'), undefined);
  const minutes = await readArtifact(task, 'minutes');
  assert.match(minutes, /转写原文/);
});

test('只勾转写：只产出一份', async () => {
  await setModels(openaiModels());
  const task = await runTask({ steps: ['transcribe'], inputName: '周会录音.mp3', title: '只转写' });
  assert.equal(task.status, 'succeeded', `任务失败：${JSON.stringify(task.error)}`);
  assert.equal(task.artifacts.length, 1);
  assert.equal(task.artifacts[0].step, 'transcribe');
});

test('百炼异步转写：OSS 上传表单 file 在最后，且带上必需请求头', async () => {
  await setModels({
    transcribe: {
      kind: 'dashscope-asr',
      baseUrl: provider.baseUrl,
      apiKey: 'sk-mock',
      model: 'paraformer-v2',
      languageHints: 'zh,en',
      timeoutSec: 60,
      maxRetries: 1,
    },
    polish: { kind: 'openai-chat', baseUrl: openaiBase(), apiKey: 'sk-mock', model: 'mock-chat', timeoutSec: 60, maxRetries: 1 },
    minutes: { kind: 'openai-chat', baseUrl: openaiBase(), apiKey: 'sk-mock', model: 'mock-chat', timeoutSec: 60, maxRetries: 1 },
  });

  const task = await runTask({ steps: ['transcribe', 'polish'], inputName: '周会录音.mp3', title: '百炼转写' });
  assert.equal(task.status, 'succeeded', `任务失败：${JSON.stringify(task.error)}`);
  assert.equal(task.artifacts.length, 2);

  const order = provider.stats.uploadFieldOrder || [];
  assert.equal(order.at(-1), 'file', `file 必须是最后一个表单字段，实际：${order.join(',')}`);
  assert.ok(order.includes('OSSAccessKeyId') && order.includes('Signature') && order.includes('policy'));

  assert.ok((provider.stats.uploadedKeys?.[0] || '').startsWith('oss://'), '提交任务应使用 oss:// 临时地址');
  assert.equal(provider.stats.dashscopeHeaders['x-dashscope-async'], 'enable');
  assert.equal(provider.stats.dashscopeHeaders['x-dashscope-ossresourceresolve'], 'enable');

  const transcript = await readArtifact(task, 'transcribe');
  assert.match(transcript, /\[00:00:12\.5 - 00:00:25\.0\]/);
  assert.match(transcript, /paraformer-v2/);
});

test('多模态转写模型兜底润色与纪要（Gemini 原生协议）', async () => {
  await setModels({
    transcribe: {
      kind: 'gemini-audio',
      isMultimodal: true,
      baseUrl: `${provider.baseUrl}/v1beta`,
      apiKey: 'sk-mock',
      model: 'gemini-2.5-flash',
      timeoutSec: 60,
      maxRetries: 1,
    },
    polish: { kind: 'openai-chat', baseUrl: '', apiKey: '', model: '' },
    minutes: { kind: 'openai-chat', baseUrl: '', apiKey: '', model: '' },
  });

  const task = await runTask({
    steps: ['transcribe', 'polish', 'minutes'],
    inputName: '周会录音.mp3',
    title: '多模态回退',
  });
  assert.equal(task.status, 'succeeded', `任务失败：${JSON.stringify(task.error)}`);
  assert.equal(task.artifacts.length, 3);
  assert.equal(task.modelPlan.polish.fallback, true);
  assert.equal(task.modelPlan.minutes.fallback, true);
  assert.equal(task.modelPlan.polish.source, 'transcribe');

  const transcript = await readArtifact(task, 'transcribe');
  assert.match(transcript, /时间戳：估算/);
  const minutes = await readArtifact(task, 'minutes');
  assert.match(minutes, /会议信息/);
});

test('多模态 chat 协议：input_audio 内联音频', async () => {
  await setModels({
    transcribe: {
      kind: 'multimodal-chat',
      isMultimodal: true,
      baseUrl: openaiBase(),
      apiKey: 'sk-mock',
      model: 'mock-omni',
      audioTransport: 'base64',
      timeoutSec: 60,
      maxRetries: 1,
    },
    polish: { kind: 'openai-chat', baseUrl: openaiBase(), apiKey: 'sk-mock', model: 'mock-chat', timeoutSec: 60, maxRetries: 1 },
    minutes: { kind: 'openai-chat', baseUrl: openaiBase(), apiKey: 'sk-mock', model: 'mock-chat', timeoutSec: 60, maxRetries: 1 },
  });
  const task = await runTask({ steps: ['transcribe'], inputName: '周会录音.mp3', title: '多模态内联' });
  assert.equal(task.status, 'succeeded', `任务失败：${JSON.stringify(task.error)}`);
  const transcript = await readArtifact(task, 'transcribe');
  assert.match(transcript, /\[00:00:00\.0 - 00:00:12\.5\]/);
});

test('内置模拟模型：完全不调用外部接口', async () => {
  await setModels({
    transcribe: { kind: 'mock', isMultimodal: true },
    polish: { kind: 'mock' },
    minutes: { kind: 'mock' },
  });
  const before = provider.stats.requests.length;
  const task = await runTask({ steps: ['transcribe', 'polish', 'minutes'], inputName: '周会录音.mp3', title: '模拟模型' });
  assert.equal(task.status, 'succeeded', `任务失败：${JSON.stringify(task.error)}`);
  assert.equal(task.artifacts.length, 3);
  assert.equal(provider.stats.requests.length, before, '模拟模型不应该访问外部接口');
});

test('流程需要但模型未配置时，创建任务被拒绝并给出中文提示', async () => {
  await setModels({
    transcribe: { kind: 'openai-asr', baseUrl: openaiBase(), apiKey: 'sk-mock', model: 'mock-asr' },
    polish: { kind: 'openai-chat', baseUrl: '', apiKey: '', model: '' },
    minutes: { kind: 'openai-chat', baseUrl: '', apiKey: '', model: '' },
  });
  const res = await api('/api/tasks', {
    method: 'POST',
    body: {
      workspaceId,
      steps: ['transcribe', 'polish'],
      inputPath: path.join(workspaceDir, '周会录音.mp3'),
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'MODEL_MISSING');
  assert.match(res.data.error.message, /润色模型/);
});

test('输入类型与流程不匹配时被拒绝', async () => {
  await setModels(openaiModels());
  const res = await api('/api/tasks', {
    method: 'POST',
    body: {
      workspaceId,
      steps: ['transcribe'],
      inputPath: path.join(workspaceDir, '会议文本.txt'),
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'INPUT_EXT_UNSUPPORTED');
});

test('工作区外的文件不能作为输入', async () => {
  await setModels(openaiModels());
  const outside = path.join(tmpRoot, 'outside.mp3');
  await fs.writeFile(outside, Buffer.alloc(100));
  const res = await api('/api/tasks', {
    method: 'POST',
    body: { workspaceId, steps: ['transcribe'], inputPath: outside },
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'INPUT_OUTSIDE_WORKSPACE');
});

test('SSE 能推送任务事件与日志', async () => {
  await setModels(openaiModels());
  const create = await api('/api/tasks', {
    method: 'POST',
    body: { workspaceId, steps: ['transcribe'], inputPath: path.join(workspaceDir, '周会录音.mp3'), title: 'SSE 测试' },
  });
  const id = create.data.task.id;
  const controller = new AbortController();
  const res = await fetch(`${app.url}api/tasks/${id}/events?token=${encodeURIComponent(app.token)}`, {
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes('event: task') && text.includes('event: log')) break;
  }
  controller.abort();
  assert.match(text, /event: task/);
  assert.match(text, /event: log/);
  await waitForTask(id);
});

test('任务列表与产物读取接口', async () => {
  const list = await api('/api/tasks');
  assert.equal(list.status, 200);
  assert.ok(list.data.tasks.length >= 1);
  const first = list.data.tasks[0];
  assert.ok('status' in first && 'artifacts' in first);

  const detail = await api(`/api/tasks/${first.id}`);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.data.logs));

  const stats = await api('/api/system/info');
  assert.equal(stats.status, 200);
  assert.ok(stats.data.dataDir);
  assert.ok('ffmpeg' in stats.data);
});

test('纪要模板默认包含固定骨架（来自 mock 输出校验）', () => {
  assert.match(MOCK_MINUTES, /## 会议信息/);
  assert.match(MOCK_MINUTES, /## 一句话结论/);
  assert.match(MOCK_MINUTES, /## 待办事项/);
});

test('取消运行中的任务', async () => {
  const base = openaiModels();
  await setModels({
    ...base,
    transcribe: { ...base.transcribe, model: 'mock-slow', maxRetries: 0 },
  });
  const create = await api('/api/tasks', {
    method: 'POST',
    body: {
      workspaceId,
      steps: ['transcribe'],
      inputPath: path.join(workspaceDir, '周会录音.mp3'),
      title: '取消测试',
    },
  });
  assert.equal(create.status, 200);
  const id = create.data.task.id;
  await new Promise((resolve) => setTimeout(resolve, 400));

  const canceled = await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
  assert.equal(canceled.status, 200);

  const task = await waitForTask(id);
  assert.equal(task.status, 'canceled');
  assert.equal(task.error.code, 'CANCELED');
});

test('失败后重新运行可以成功', async () => {
  const base = openaiModels();
  await setModels({
    ...base,
    transcribe: { ...base.transcribe, model: 'mock-flaky', maxRetries: 0 },
  });

  const failed = await runTask({ steps: ['transcribe'], inputName: '周会录音.mp3', title: '失败重试' });
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error?.message, '失败任务应带上错误信息');
  assert.equal(failed.artifacts.length, 0);

  await setModels(openaiModels());
  const retried = await api(`/api/tasks/${failed.id}/retry`, { method: 'POST' });
  assert.equal(retried.status, 200);
  // 队列是即时启动的，返回时可能已经进入 running
  assert.ok(['queued', 'running'].includes(retried.data.task.status), `重试后状态异常：${retried.data.task.status}`);

  const done = await waitForTask(failed.id);
  assert.equal(done.status, 'succeeded', `重试后仍失败：${JSON.stringify(done.error)}`);
  assert.equal(done.artifacts.length, 1);
  const content = await readArtifact(done, 'transcribe');
  assert.match(content, /\[00:00:00\.0 - 00:00:12\.5\]/);
});

test('原生文件夹选择接口：返回系统对话框选中的路径', async () => {
  pickMode = 'path';
  lastPickPlan = null;
  const res = await api('/api/fs/pick-directory', {
    method: 'POST',
    body: { title: '选择工作区', initialPath: workspaceDir },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.native, true);
  assert.equal(res.data.canceled, false);
  assert.equal(res.data.path, workspaceDir);

  // 标题与初始目录确实传给了系统对话框命令
  const plan = lastPickPlan;
  assert.ok(plan, '应该调用注入的 runner');
  assert.ok(plan.command, '应该带上可执行文件');
  if (process.platform === 'win32') {
    assert.equal(plan.kind, 'windows-folder-dialog');
    assert.equal(plan.env.MNS_PICK_TITLE, '选择工作区');
    assert.equal(plan.env.MNS_PICK_INITIAL, workspaceDir);
  }
});

test('原生文件夹选择接口：取消与出错', async () => {
  pickMode = 'cancel';
  const canceled = await api('/api/fs/pick-directory', { method: 'POST', body: { title: '选择文件夹' } });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.data.canceled, true);
  assert.equal(canceled.data.path, null);

  pickMode = 'error';
  const failed = await api('/api/fs/pick-directory', { method: 'POST', body: { title: '选择文件夹' } });
  assert.equal(failed.status, 500);
  assert.equal(failed.data.error.code, 'NATIVE_DIALOG_FAILED');
  assert.match(failed.data.error.message, /模拟对话框失败/);
});

test('系统信息里包含原生对话框能力', async () => {
  const res = await api('/api/system/info');
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.nativeDialog.available, 'boolean');
  assert.equal(typeof res.data.nativeDialog.label, 'string');
  assert.equal(res.data.nativeDialog.command, undefined, '不应把可执行文件路径暴露给前端');
});

test('工作区增删改：改名、删除后不能再用来建任务', async () => {
  const extraDir = path.join(tmpRoot, '临时工作区');
  await fs.mkdir(extraDir, { recursive: true });
  await fs.writeFile(path.join(extraDir, 'a.mp3'), Buffer.alloc(1024));

  const created = await api('/api/workspaces', { method: 'POST', body: { path: extraDir, name: '临时工作区' } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.workspace.id;

  const patched = await api(`/api/workspaces/${id}`, { method: 'PATCH', body: { name: '临时工作区-改' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.workspace.name, '临时工作区-改');

  const listed = await api('/api/workspaces');
  assert.ok(listed.data.workspaces.some((w) => w.id === id));

  const removed = await api(`/api/workspaces/${id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.ok, true);

  const listedAfter = await api('/api/workspaces');
  assert.equal(listedAfter.data.workspaces.some((w) => w.id === id), false);
  // 删除只是移除登记，文件夹和文件都还在
  assert.ok(await fs.stat(extraDir));
  assert.ok(await fs.stat(path.join(extraDir, 'a.mp3')));

  const rejected = await api('/api/tasks', {
    method: 'POST',
    body: { workspaceId: id, steps: ['transcribe'], inputPath: path.join(extraDir, 'a.mp3') },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.error.code, 'WORKSPACE_REQUIRED');
});

test('并发：同时创建 3 个慢任务会并行执行，而不是逐个排队', async () => {
  const base = openaiModels();
  await setModels({
    ...base,
    transcribe: { ...base.transcribe, model: 'mock-slow', maxRetries: 0 },
  });
  const cfg = await api('/api/config', { method: 'PUT', body: { server: { maxConcurrent: 3 } } });
  assert.equal(cfg.data.config.server.maxConcurrent, 3);

  const started = Date.now();
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const res = await api('/api/tasks', {
      method: 'POST',
      body: {
        workspaceId,
        steps: ['transcribe'],
        inputPath: path.join(workspaceDir, '周会录音.mp3'),
        title: `并发任务 ${i + 1}`,
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    ids.push(res.data.task.id);
  }

  // 三秒级任务刚创建时，应该至少有 2 个同时在跑
  const snapshot = await api('/api/tasks');
  const runningNow = snapshot.data.tasks.filter((t) => ids.includes(t.id) && t.status === 'running');
  assert.ok(runningNow.length >= 2, `同时运行的任务只有 ${runningNow.length} 个，并发没有生效`);

  const results = await Promise.all(ids.map((id) => waitForTask(id)));
  const elapsed = Date.now() - started;
  for (const task of results) {
    assert.equal(task.status, 'succeeded', `任务失败：${JSON.stringify(task.error)}`);
  }
  // 每个任务固定 3 秒；串行至少 9 秒
  assert.ok(elapsed < 8800, `3 个任务共耗时 ${elapsed}ms，看起来是串行执行的`);
});

test('删除任务：只删记录保留产物 / 连产物一起删 / 运行中拒绝', async () => {
  await setModels(openaiModels());

  // 1) 只删记录：产物文件仍在
  const kept = await runTask({ steps: ['transcribe'], inputName: '周会录音.mp3', title: '待删除-保留产物' });
  assert.equal(kept.status, 'succeeded');
  const keptArtifact = kept.artifacts[0].path;
  const del1 = await api(`/api/tasks/${kept.id}`, { method: 'DELETE' });
  assert.equal(del1.status, 200, JSON.stringify(del1.data));
  assert.equal(del1.data.ok, true);
  assert.equal(del1.data.deletedArtifacts, 0);

  const listAfter = await api('/api/tasks');
  assert.equal(listAfter.data.tasks.some((t) => t.id === kept.id), false, '删除后列表里不应再有这个任务');
  assert.ok(await fs.stat(keptArtifact), '只删记录时产物文件必须保留');
  assert.equal(await fs.stat(path.join(dataDir, 'tasks', kept.id)).then(() => true, () => false), false, '任务数据目录应被清理');

  const again = await api(`/api/tasks/${kept.id}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
  assert.equal(again.data.error.code, 'TASK_NOT_FOUND');

  // 2) 连产物一起删
  const purged = await runTask({ steps: ['transcribe', 'polish'], inputName: '周会录音.mp3', title: '待删除-连产物' });
  assert.equal(purged.status, 'succeeded');
  const purgedPaths = purged.artifacts.map((a) => a.path);
  assert.equal(purgedPaths.length, 2);
  const del2 = await api(`/api/tasks/${purged.id}?deleteArtifacts=1`, { method: 'DELETE' });
  assert.equal(del2.status, 200);
  assert.equal(del2.data.deletedArtifacts, 2);
  for (const target of purgedPaths) {
    assert.equal(await fs.stat(target).then(() => true, () => false), false, `产物应被删除：${target}`);
  }

  // 3) 运行中的任务不允许删除
  const base = openaiModels();
  await setModels({ ...base, transcribe: { ...base.transcribe, model: 'mock-slow', maxRetries: 0 } });
  const created = await api('/api/tasks', {
    method: 'POST',
    body: {
      workspaceId,
      steps: ['transcribe'],
      inputPath: path.join(workspaceDir, '周会录音.mp3'),
      title: '运行中-不可删',
    },
  });
  const runningId = created.data.task.id;
  const rejected = await api(`/api/tasks/${runningId}`, { method: 'DELETE' });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.data.error.code, 'TASK_RUNNING');

  await api(`/api/tasks/${runningId}/cancel`, { method: 'POST' });
  const canceled = await waitForTask(runningId);
  assert.equal(canceled.status, 'canceled');

  // 取消后可以删
  const del3 = await api(`/api/tasks/${runningId}`, { method: 'DELETE' });
  assert.equal(del3.status, 200);
});

