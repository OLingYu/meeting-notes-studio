/**
 * 任务状态机与队列：创建、排队、执行、取消、重试、断点续跑。
 * 一个任务按勾选的步骤顺序执行：转写 → 润色 → 纪要。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AppError, errorPayload, isAbortError, toAppError } from '../errors.mjs';
import {
  ensureDir,
  nowIso,
  readJson,
  readTailLines,
  shortId,
  writeJson,
} from '../store.mjs';
import {
  inputKindFor,
  normalizeSteps,
  resolveModels,
  STEP_LABELS,
  validationForInput,
} from './resolve.mjs';
import { runTranscribe } from './transcribe.mjs';
import { runPolish } from './polish.mjs';
import { runMinutes } from './minutes.mjs';
import {
  ARTIFACTS,
  baseNameOf,
  buildMinutesMarkdown,
  buildPolishMarkdown,
  buildTranscriptMarkdown,
  resolveArtifactPath,
  writeArtifact,
} from './artifacts.mjs';
import {
  charCount,
  looksLikeSubtitle,
  normalizeNewlines,
  parseSubtitle,
  preview,
  stripTimestampPrefixes,
  subtitleToPlainText,
} from '../lib/text.mjs';
import { formatDuration } from '../lib/time.mjs';

const STEP_WEIGHT = { transcribe: 60, polish: 25, minutes: 15 };
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);

export function pathWithin(base, target) {
  const baseResolved = path.resolve(base);
  const targetResolved = path.resolve(target);
  const rel = path.relative(baseResolved, targetResolved);
  if (!rel) return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

async function readTextInput(filePath) {
  const content = await fsp.readFile(filePath, 'utf8');
  if (looksLikeSubtitle(content)) {
    const segments = parseSubtitle(content);
    return { text: subtitleToPlainText(segments).trim(), segments };
  }
  return { text: normalizeNewlines(content).trim(), segments: [] };
}

function planSnapshot(plan) {
  const snapshot = {};
  for (const slot of ['transcribe', 'polish', 'minutes']) {
    const entry = plan[slot];
    if (!entry) continue;
    snapshot[slot] = {
      slot,
      source: entry.source,
      fallback: entry.fallback,
      kind: entry.kind,
      model: entry.model,
      label: entry.label,
    };
  }
  return snapshot;
}

export class TaskManager {
  constructor({ configStore, dataDir, logger }) {
    this.configStore = configStore;
    this.dataDir = dataDir;
    this.logger = logger;
    this.tasksDir = path.join(dataDir, 'tasks');
    this.tasks = new Map();
    this.queue = [];
    this.controllers = new Map();
    this.running = 0;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await ensureDir(this.tasksDir);
    const entries = await fsp.readdir(this.tasksDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskFile = path.join(this.tasksDir, entry.name, 'task.json');
      const task = await readJson(taskFile, null);
      if (!task?.id) continue;
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'interrupted';
        task.stageMessage = '服务重启，任务已中断';
        task.error = {
          code: 'INTERRUPTED',
          message: '服务重启，任务被中断',
          hint: '点击「重新运行」会从上次完成的步骤继续',
        };
        await this.#persist(task);
      }
      this.tasks.set(task.id, task);
    }
    this.initialized = true;
    this.logger.info(`已加载 ${this.tasks.size} 个历史任务`);
  }

  taskDir(taskId) {
    return path.join(this.tasksDir, taskId);
  }

  cacheDir(taskId) {
    return path.join(this.taskDir(taskId), 'cache');
  }

  subscribe(taskId, listener) {
    const channel = `task:${taskId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  #emit(taskId, payload) {
    this.emitter.emit(`task:${taskId}`, payload);
  }

  #public(task) {
    return {
      id: task.id,
      title: task.title,
      workspaceId: task.workspaceId,
      workspaceName: task.workspaceName,
      workspacePath: task.workspacePath,
      deliveryDir: task.deliveryDir,
      steps: task.steps,
      input: task.input,
      modelPlan: task.modelPlan,
      status: task.status,
      currentStep: task.currentStep,
      progress: task.progress,
      stageMessage: task.stageMessage,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      completedSteps: task.completedSteps,
      artifacts: task.artifacts,
      error: task.error,
      usage: task.usage,
      summary: task.summary,
      stepStates: task.stepStates,
    };
  }

  list() {
    return [...this.tasks.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((t) => this.#public(t));
  }

  get(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError('任务不存在', { code: 'TASK_NOT_FOUND', status: 404 });
    return this.#public(task);
  }

  async logs(taskId, maxLines = 300) {
    return readTailLines(path.join(this.taskDir(taskId), 'log.jsonl'), maxLines);
  }

  async #persist(task) {
    await writeJson(path.join(this.taskDir(task.id), 'task.json'), task);
  }

  #update(task, patch) {
    Object.assign(task, patch);
    this.#emit(task.id, { type: 'task', task: this.#public(task) });
    return task;
  }

  #progressWeights(steps) {
    const total = steps.reduce((sum, step) => sum + STEP_WEIGHT[step], 0) || 1;
    const cumulative = {};
    let acc = 0;
    for (const step of steps) {
      cumulative[step] = { base: acc / total, weight: STEP_WEIGHT[step] / total };
      acc += STEP_WEIGHT[step];
    }
    return cumulative;
  }

  /** 创建任务：校验工作区、输入文件、流程、交付区、模型 */
  async create({ workspaceId, title, inputPath, steps, deliveryDir }) {
    const config = this.configStore.get();
    const workspace = config.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) {
      throw new AppError('请先选择一个工作区', {
        code: 'WORKSPACE_REQUIRED',
        hint: '在「工作区」页添加文件夹，或新建任务时添加',
      });
    }

    const normalizedSteps = normalizeSteps(steps);
    if (!normalizedSteps.length) {
      throw new AppError('至少要选择一个流程', { code: 'STEPS_REQUIRED', hint: '转写 / 润色 / 纪要 至少勾一项' });
    }

    const inputKind = inputKindFor(normalizedSteps);
    const resolvedInput = path.resolve(String(inputPath || ''));
    if (!inputPath) {
      throw new AppError(`请选择要处理的${inputKind === 'audio' ? '音频' : '文本'}文件`, { code: 'INPUT_REQUIRED' });
    }
    if (!pathWithin(workspace.path, resolvedInput)) {
      throw new AppError('所选文件不在这个工作区里', {
        code: 'INPUT_OUTSIDE_WORKSPACE',
        hint: '请把文件放进工作区文件夹，再在任务里选择',
      });
    }
    const extCheck = validationForInput(inputKind, resolvedInput);
    if (!extCheck.ok) {
      throw new AppError(extCheck.message, { code: 'INPUT_EXT_UNSUPPORTED', hint: '换一个受支持的文件，或调整勾选的流程' });
    }
    const stat = await fsp.stat(resolvedInput).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new AppError('找不到这个输入文件', { code: 'INPUT_NOT_FOUND', hint: '确认文件还在工作区里' });
    }
    if (stat.size === 0) {
      throw new AppError('输入文件是空的', { code: 'EMPTY_INPUT' });
    }

    const resolvedDelivery = path.resolve(String(deliveryDir || workspace.defaultDeliveryPath || workspace.path));
    const deliveryStat = await fsp.stat(resolvedDelivery).catch(() => null);
    if (!deliveryStat || !deliveryStat.isDirectory()) {
      throw new AppError('交付区文件夹不存在', {
        code: 'DELIVERY_NOT_FOUND',
        hint: '重新选择一个存在的文件夹，或先用默认的工作区',
      });
    }
    try {
      await fsp.access(resolvedDelivery, (await import('node:fs')).constants.W_OK);
    } catch {
      throw new AppError('交付区不可写', {
        code: 'DELIVERY_NOT_WRITABLE',
        hint: '换一个有写权限的文件夹，或改用工作区作为交付区',
      });
    }

    const { plan, missing, ready } = resolveModels(config, normalizedSteps);
    if (!ready) {
      throw new AppError(missing.map((m) => m.message).join('\n'), {
        code: 'MODEL_MISSING',
        hint: '到「设置」里补齐模型配置，或使用内置模拟模型先跑通流程',
      });
    }

    const taskId = shortId('task');
    await ensureDir(path.join(this.taskDir(taskId), 'cache'));

    const task = {
      id: taskId,
      title: String(title || '').trim() || `${baseNameOf(resolvedInput)} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      deliveryDir: resolvedDelivery,
      steps: normalizedSteps,
      input: {
        path: resolvedInput,
        name: path.basename(resolvedInput),
        kind: inputKind,
        sizeBytes: stat.size,
      },
      modelPlan: planSnapshot(plan),
      status: 'queued',
      currentStep: null,
      progress: 0,
      stageMessage: '排队中',
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      completedSteps: [],
      artifacts: [],
      error: null,
      usage: {},
      summary: {},
      stepStates: Object.fromEntries(normalizedSteps.map((step) => [step, 'pending'])),
    };

    this.tasks.set(taskId, task);
    await this.#persist(task);
    this.queue.push(taskId);
    this.logger.task(taskId).info(`任务已创建：${task.title}`);
    this.#emit(taskId, { type: 'task', task: this.#public(task) });
    this.#pump();
    return this.#public(task);
  }

  cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError('任务不存在', { code: 'TASK_NOT_FOUND', status: 404 });
    if (TERMINAL.has(task.status)) {
      throw new AppError('任务已经结束了，不需要取消', { code: 'TASK_FINISHED' });
    }
    const controller = this.controllers.get(taskId);
    if (controller) {
      controller.abort();
    } else {
      this.queue = this.queue.filter((id) => id !== taskId);
      task.status = 'canceled';
      task.finishedAt = nowIso();
      task.stageMessage = '已取消';
      task.error = { code: 'CANCELED', message: '任务已取消', hint: '产物会保留已生成的部分' };
      this.#persist(task).catch(() => {});
      this.#emit(taskId, { type: 'task', task: this.#public(task) });
      this.#emit(taskId, { type: 'end', task: this.#public(task) });
    }
    this.logger.task(taskId).warn('收到取消请求');
    return this.#public(task);
  }

  /**
   * 删除任务记录（可选：连已交付的产物文件一起删）。
   * 只删记录时，产物文件保留在交付区；连同删除时，只删本任务记录过的 .md 文件。
   */
  async remove(taskId, { deleteArtifacts = false } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError('任务不存在', { code: 'TASK_NOT_FOUND', status: 404 });
    if (!TERMINAL.has(task.status)) {
      throw new AppError('任务还在运行，先取消它再删除', {
        code: 'TASK_RUNNING',
        status: 409,
        hint: '在任务详情里点「取消任务」，或等它跑完再删',
      });
    }

    let deletedArtifacts = 0;
    if (deleteArtifacts) {
      for (const artifact of task.artifacts || []) {
        const target = artifact?.path;
        // 只删本任务记录过、且确实是 Markdown 产物的文件，避免误删别的东西
        if (typeof target !== 'string' || !target.toLowerCase().endsWith('.md')) continue;
        const stat = await fsp.stat(target).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        await fsp.rm(target, { force: true }).catch(() => {});
        deletedArtifacts += 1;
      }
    }

    this.tasks.delete(taskId);
    this.queue = this.queue.filter((id) => id !== taskId);
    await fsp.rm(this.taskDir(taskId), { recursive: true, force: true }).catch(() => {});
    this.logger.info(
      `已删除任务：${task.title}${deleteArtifacts ? `（连同 ${deletedArtifacts} 个产物）` : '（产物保留）'}`,
    );
    return { ok: true, taskId, deletedArtifacts };
  }

  async retry(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError('任务不存在', { code: 'TASK_NOT_FOUND', status: 404 });
    if (!['failed', 'interrupted', 'canceled'].includes(task.status)) {
      throw new AppError('只有失败/中断/已取消的任务可以重新运行', { code: 'TASK_NOT_RETRYABLE' });
    }
    // 恢复输入价格校验（文件可能已被删除）
    const stat = await fsp.stat(task.input.path).catch(() => null);
    if (!stat) {
      throw new AppError('原始输入文件已经不在了，无法重试', {
        code: 'INPUT_NOT_FOUND',
        hint: '把文件放回原位置，或新建一个任务',
      });
    }
    task.status = 'queued';
    task.error = null;
    task.finishedAt = null;
    task.stageMessage = '排队中';
    task.progress = 0;
    for (const step of task.steps) {
      task.stepStates[step] = task.completedSteps.includes(step) ? 'done' : 'pending';
    }
    await this.#persist(task);
    this.queue.push(taskId);
    this.logger.task(taskId).info('任务已加入队列，准备继续运行');
    this.#emit(taskId, { type: 'task', task: this.#public(task) });
    this.#pump();
    return this.#public(task);
  }

  #pump() {
    const max = Math.max(1, Math.min(5, this.configStore.get().server.maxConcurrent || 1));
    while (this.running < max && this.queue.length) {
      const id = this.queue.shift();
      const task = this.tasks.get(id);
      if (!task || task.status !== 'queued') continue;
      this.running += 1;
      this.#runTask(task)
        .catch((err) => this.logger.error(`任务 ${id} 运行异常：${err?.message || err}`))
        .finally(() => {
          this.running -= 1;
          this.#pump();
        });
    }
  }

  async #runTask(task) {
    const taskLog = this.logger.task(task.id);
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const weights = this.#progressWeights(task.steps);

    const setStage = (step, fraction, message) => {
      const conf = weights[step] || { base: 0, weight: 0 };
      const clamped = Math.min(1, Math.max(0, Number(fraction) || 0));
      // 运行中最多显示 99%，完成时再给 100%
      const percent = Math.min(99, Math.round((conf.base + conf.weight * clamped) * 100));
      this.#update(task, {
        currentStep: step,
        progress: percent,
        stageMessage: message || `${STEP_LABELS[step] || ''}中`,
      });
    };

    try {
      const config = this.configStore.get();
      const { plan, missing, ready } = resolveModels(config, task.steps);
      if (!ready) {
        throw new AppError(missing.map((m) => m.message).join('\n'), {
          code: 'MODEL_MISSING',
          hint: '到「设置」里补齐模型配置后重试',
        });
      }

      this.#update(task, {
        status: 'running',
        startedAt: task.startedAt || nowIso(),
        stageMessage: '开始处理',
        progress: Math.max(task.progress || 0, 1),
        error: null,
      });
      taskLog.info(`开始执行：${task.steps.map((s) => STEP_LABELS[s]).join(' → ')}`);
      for (const slot of Object.keys(plan)) {
        const entry = plan[slot];
        if (!entry) continue;
        taskLog.info(`${STEP_LABELS[slot] || slot}使用：${entry.label} / ${entry.model || '(未填模型名)'}${entry.fallback ? '（多模态模型回退）' : ''}`);
      }

      const cacheDir = this.cacheDir(task.id);
      const tempDir = path.join(this.taskDir(task.id), 'tmp');
      await ensureDir(cacheDir);
      await ensureDir(tempDir);
      const sourceName = task.input.name;
      const baseName = baseNameOf(task.input.path);

      let transcript = null;
      let polished = null;
      let userText = null;

      // ---- 转写 ----
      if (task.steps.includes('transcribe')) {
        const cached = await readJson(path.join(cacheDir, 'transcript.json'), null);
        if (task.completedSteps.includes('transcribe') && cached) {
          transcript = cached;
          taskLog.info('转写步骤已完成，复用缓存结果');
        } else {
          task.stepStates.transcribe = 'running';
          setStage('transcribe', 0, '正在转写音频');
          this.#update(task, { stepStates: { ...task.stepStates } });
          const result = await runTranscribe({
            cfg: plan.transcribe.cfg,
            filePath: task.input.path,
            signal: controller.signal,
            log: taskLog,
            tempDir,
            onProgress: (f) => setStage('transcribe', f, f >= 1 ? '转写完成' : '正在转写音频'),
          });
          transcript = result;
          await writeJson(path.join(cacheDir, 'transcript.json'), result);
        }
        task.usage = { ...task.usage, sttSeconds: transcript.usage?.sttSeconds };
        task.summary = { ...task.summary, segments: transcript.segments?.length || 0, durationMs: transcript.durationMs || 0 };

        if (!task.artifacts.some((a) => a.step === 'transcribe')) {
          const createdAt = new Date();
          const content = buildTranscriptMarkdown({
            sourceName,
            inputBytes: transcript.inputBytes || task.input.sizeBytes,
            durationMs: transcript.durationMs,
            modelLabel: transcript.label || plan.transcribe.model,
            quality: transcript.quality,
            segments: transcript.segments || [],
            createdAt,
          });
          const filePath = await resolveArtifactPath({
            deliveryDir: task.deliveryDir,
            baseName,
            suffix: ARTIFACTS.transcribe.suffix,
            createdAt,
          });
          const written = await writeArtifact(filePath, content);
          this.#recordArtifact(task, 'transcribe', written, {
            model: transcript.label || plan.transcribe.model,
            createdAt,
          });
          taskLog.info(`已写出：${path.basename(filePath)}`);
        }
        task.stepStates.transcribe = 'done';
        if (!task.completedSteps.includes('transcribe')) task.completedSteps.push('transcribe');
        setStage('transcribe', 1, '转写完成');
        await this.#persist(task);
        this.#update(task, { stepStates: { ...task.stepStates } });
      }

      // ---- 准备正文 ----
      let inputSegments = transcript?.segments || [];
      if (transcript) {
        userText = transcript.text || (transcript.segments || []).map((s) => s.text).join('\n');
      } else {
        const read = await readTextInput(task.input.path);
        userText = read.text;
        inputSegments = read.segments;
        task.summary = { ...task.summary, chars: charCount(userText) };
        taskLog.info(`已读取文本输入：${charCount(userText)} 字${read.segments.length ? `，${read.segments.length} 个时间段` : ''}`);
      }
      const rawPlain = stripTimestampPrefixes(userText);

      // ---- 润色 ----
      if (task.steps.includes('polish')) {
        const cachedPath = path.join(cacheDir, 'polished.json');
        const cached = await readJson(cachedPath, null);
        if (task.completedSteps.includes('polish') && cached?.text) {
          polished = cached;
          taskLog.info('润色步骤已完成，复用缓存结果');
        } else {
          task.stepStates.polish = 'running';
          setStage('polish', 0, '正在润色');
          this.#update(task, { stepStates: { ...task.stepStates } });
          const result = await runPolish({
            cfg: plan.polish.cfg,
            inputText: rawPlain,
            signal: controller.signal,
            log: taskLog,
            cacheDir,
            onProgress: (f) => setStage('polish', f, f >= 1 ? '润色完成' : '正在润色'),
          });
          polished = result;
          await writeJson(cachedPath, result);
        }
        if (!task.artifacts.some((a) => a.step === 'polish')) {
          const createdAt = new Date();
          const content = buildPolishMarkdown({
            sourceName,
            modelLabel: plan.polish.model,
            body: polished.text,
            basedOn: transcript ? '转写原文（已自动去掉时间戳）' : '你提供的文本',
            charCount: charCount(polished.text),
            createdAt,
          });
          const filePath = await resolveArtifactPath({
            deliveryDir: task.deliveryDir,
            baseName,
            suffix: ARTIFACTS.polish.suffix,
            createdAt,
          });
          const written = await writeArtifact(filePath, content);
          this.#recordArtifact(task, 'polish', written, { model: plan.polish.model, createdAt });
          taskLog.info(`已写出：${path.basename(filePath)}`);
        }
        task.stepStates.polish = 'done';
        if (!task.completedSteps.includes('polish')) task.completedSteps.push('polish');
        setStage('polish', 1, '润色完成');
        await this.#persist(task);
        this.#update(task, { stepStates: { ...task.stepStates } });
      }

      // ---- 纪要 ----
      if (task.steps.includes('minutes')) {
        const minutesInput = polished?.text || rawPlain;
        const basedOn = polished ? '润色稿' : transcript ? '转写原文' : '你提供的文本';
        task.stepStates.minutes = 'running';
        setStage('minutes', 0, '正在生成纪要');
        this.#update(task, { stepStates: { ...task.stepStates } });
        const result = await runMinutes({
          cfg: plan.minutes.cfg,
          inputText: minutesInput,
          segments: inputSegments,
          sourceLabel: basedOn,
          signal: controller.signal,
          log: taskLog,
          cacheDir,
          onProgress: (f) => setStage('minutes', f, f >= 1 ? '纪要完成' : '正在生成纪要'),
        });
        const createdAt = new Date();
        const content = buildMinutesMarkdown({
          sourceName,
          modelLabel: plan.minutes.model,
          body: result.body,
          basedOn,
          createdAt,
        });
        const filePath = await resolveArtifactPath({
          deliveryDir: task.deliveryDir,
          baseName,
          suffix: ARTIFACTS.minutes.suffix,
          createdAt,
        });
        const written = await writeArtifact(filePath, content);
        this.#recordArtifact(task, 'minutes', written, { model: plan.minutes.model, createdAt });
        task.stepStates.minutes = 'done';
        if (!task.completedSteps.includes('minutes')) task.completedSteps.push('minutes');
        setStage('minutes', 1, '纪要完成');
        await this.#persist(task);
        this.#update(task, { stepStates: { ...task.stepStates } });
        taskLog.info(`已写出：${path.basename(filePath)}`);
      }

      task.status = 'succeeded';
      task.progress = 100;
      task.finishedAt = nowIso();
      task.stageMessage = '全部完成';
      task.currentStep = null;
      task.summary = {
        ...task.summary,
        chars: charCount(polished?.text || rawPlain),
        artifacts: task.artifacts.length,
        cost: task.startedAt ? formatDuration(Date.parse(task.finishedAt) - Date.parse(task.startedAt)) : '',
      };
      await this.#persist(task);
      this.#update(task, { stepStates: { ...task.stepStates } });
      taskLog.info(`任务完成，共生成 ${task.artifacts.length} 个文件`);
      this.#emit(task.id, { type: 'end', task: this.#public(task) });
    } catch (err) {
      const appError = toAppError(err);
      const canceled = isAbortError(err) || controller.signal.aborted;
      task.finishedAt = nowIso();
      task.currentStep = null;
      if (canceled) {
        task.status = 'canceled';
        task.stageMessage = '已取消';
        task.error = { code: 'CANCELED', message: '任务已取消', hint: '已生成的产物会保留' };
        for (const step of task.steps) {
          if (task.stepStates[step] === 'running') task.stepStates[step] = 'canceled';
        }
        taskLog.warn('任务已取消');
      } else {
        task.status = 'failed';
        task.stageMessage = '出错了';
        task.error = errorPayload(appError);
        for (const step of task.steps) {
          if (task.stepStates[step] === 'running') task.stepStates[step] = 'failed';
        }
        taskLog.error(`任务失败：${appError.message}${appError.hint ? `（建议：${appError.hint}）` : ''}`);
      }
      await this.#persist(task);
      this.#update(task, { stepStates: { ...task.stepStates } });
      this.#emit(task.id, { type: 'end', task: this.#public(task) });
    } finally {
      this.controllers.delete(task.id);
    }
  }

  #recordArtifact(task, step, written, meta) {
    const record = {
      step,
      title: ARTIFACTS[step].title,
      fileName: path.basename(written.path),
      path: written.path,
      bytes: written.bytes,
      chars: written.chars,
      model: meta.model || '',
      createdAt: (meta.createdAt || new Date()).toISOString(),
    };
    task.artifacts = task.artifacts.filter((a) => a.step !== step).concat(record);
  }

  async readArtifact(taskId, step) {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError('任务不存在', { code: 'TASK_NOT_FOUND', status: 404 });
    const artifact = task.artifacts.find((a) => a.step === step);
    if (!artifact) throw new AppError('还没有这个产物', { code: 'ARTIFACT_NOT_FOUND', status: 404 });
    const content = await fsp.readFile(artifact.path, 'utf8').catch(() => null);
    if (content === null) {
      throw new AppError('产物文件已经被移动或删除', { code: 'ARTIFACT_MISSING', status: 404 });
    }
    return { ...artifact, content, preview: preview(content, 200) };
  }
}
