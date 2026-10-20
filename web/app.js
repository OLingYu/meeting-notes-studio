/** 前端主应用：hash 路由 + 五个页面 + SSE 进度。 */

import {
  h,
  append,
  clear,
  button,
  badge,
  field,
  textInput,
  textarea,
  select,
  loading,
  emptyState,
  kvList,
  toast,
  openModal,
  confirmDialog,
  formatBytes,
  formatDate,
  formatDurationText,
  statusMeta,
  isTerminal,
  STEP_LABELS,
} from './ui.js';
import { renderMarkdown } from './markdown.js';
import { pickDirectory } from './picker.js';

const TOKEN = window.__APP_TOKEN__;
const view = document.getElementById('view');
const navEl = document.getElementById('nav');
const sidebarStatus = document.getElementById('sidebar-status');

const ASR_ONLY_KINDS = ['openai-asr', 'dashscope-asr'];
const MULTIMODAL_KINDS = ['gemini-audio', 'multimodal-chat', 'mock'];

const TRANSCRIBE_KINDS = [
  { value: 'openai-asr', label: 'OpenAI 兼容 · 语音转写接口', hint: '兼容 /audio/transcriptions 的服务，如 OpenAI whisper。逐段返回精确时间戳。' },
  { value: 'dashscope-asr', label: '阿里云百炼 · Paraformer 异步转写', hint: '支持小时级长音频，中文效果好，返回精确的句级时间戳。' },
  { value: 'gemini-audio', label: 'Google Gemini · 音频理解', hint: '多模态模型直接听音频，时间戳由模型标注（估算）。' },
  { value: 'multimodal-chat', label: 'OpenAI 兼容 · 多模态大模型', hint: '如 qwen-omni、gpt-4o-audio，时间戳由模型标注（估算）。' },
  { value: 'mock', label: '内置模拟模型（试用）', hint: '不联网、不消耗额度，用来先跑通整个流程。' },
];

const CHAT_KINDS = [
  { value: 'openai-chat', label: 'OpenAI 兼容 · 对话补全', hint: 'DeepSeek、通义兼容模式、硅基流动、LM Studio、vLLM 等都行。' },
  { value: 'gemini-chat', label: 'Google Gemini · 对话补全', hint: '走 Gemini 原生 generateContent 接口。' },
  { value: 'mock', label: '内置模拟模型（试用）', hint: '不联网、不消耗额度。' },
];

const BASE_PLACEHOLDER = {
  'openai-asr': 'https://api.openai.com/v1',
  'openai-chat': 'https://api.deepseek.com/v1',
  'gemini-audio': 'https://generativelanguage.googleapis.com/v1beta',
  'gemini-chat': 'https://generativelanguage.googleapis.com/v1beta',
  'dashscope-asr': 'https://dashscope.aliyuncs.com',
  'multimodal-chat': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

const MODEL_PLACEHOLDER = {
  'openai-asr': 'whisper-1',
  'openai-chat': 'deepseek-chat',
  'gemini-audio': 'gemini-2.5-flash',
  'gemini-chat': 'gemini-2.5-flash',
  'dashscope-asr': 'paraformer-v2',
  'multimodal-chat': 'qwen3-omni-flash',
};

const state = {
  config: null,
  slots: null,
  workspaces: [],
  lastWorkspaceId: '',
  tasks: [],
  system: null,
};

let cleanup = null;
let builder = null;
let lastRouteName = '';

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'x-app-token': TOKEN,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `请求失败（${res.status}）`);
    err.hint = data?.error?.hint || '';
    err.code = data?.error?.code || '';
    err.requestId = data?.error?.requestId || '';
    throw err;
  }
  return data;
}

async function loadConfig() {
  const data = await api('/api/config');
  state.config = data.config;
  state.slots = data.slots;
  renderSidebar();
  return data;
}

async function loadWorkspaces() {
  const data = await api('/api/workspaces');
  state.workspaces = data.workspaces;
  state.lastWorkspaceId = data.lastWorkspaceId || '';
  return data;
}

async function loadSystem() {
  state.system = await api('/api/system/info');
  return state.system;
}

function renderSidebar() {
  if (!sidebarStatus) return;
  clear(sidebarStatus);
  const slots = state.slots?.slots || [];
  if (!slots.length) {
    sidebarStatus.appendChild(h('div', {}, '正在读取配置…'));
    return;
  }
  for (const slot of slots) {
    const ok = slot.configured || slot.fallbackTo;
    sidebarStatus.appendChild(
      h('div', {}, h('span', { class: `dot ${ok ? 'ok' : 'warn'}` }), `${slot.label} ${ok ? '就绪' : '未配置'}`),
    );
  }
  if (state.slots?.mockMode) sidebarStatus.appendChild(h('div', {}, '模拟模型模式'));
}

/* ------------------------------------------------------------------ */
/* 通用组件                                                             */
/* ------------------------------------------------------------------ */

/** 让系统资源管理器打开某个路径（文件可用 reveal 定位） */
async function openPathExternal(target, reveal = false) {
  if (!target) return;
  try {
    await api('/api/open', { method: 'POST', body: { path: target, reveal: Boolean(reveal) } });
  } catch (err) {
    toast(err.message, { type: 'err', hint: err.hint });
  }
}

function pageHead(title, subtitle, actions = []) {
  return h(
    'div',
    { class: 'page-head' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', {}, subtitle) : null),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null,
  );
}

function card(title, subtitle, children = []) {
  const el = h('div', { class: 'card' });
  if (title) el.appendChild(h('h2', {}, title));
  if (subtitle) el.appendChild(h('p', { class: 'card-sub' }, subtitle));
  append(el, children);
  return el;
}

function errorCard(err) {
  return h(
    'div',
    { class: 'card err-card' },
    h('h2', {}, '出错了'),
    h('div', {}, err?.message || String(err)),
    err?.hint ? h('div', { class: 'err-hint' }, err.hint) : null,
    err?.requestId ? h('div', { class: 'err-hint mono' }, `requestId: ${err.requestId}`) : null,
    h(
      'div',
      { class: 'row', style: { marginTop: '14px' } },
      button('返回任务列表', { onClick: () => { location.hash = '#/'; } }),
      button('重试', { onClick: () => refresh() }),
    ),
  );
}

function checkboxRow({ label, checked, disabled = false, hint, onChange }) {
  const input = h('input', {
    type: 'checkbox',
    checked,
    disabled,
    onchange: (e) => onChange?.(e.target.checked),
  });
  const row = h('label', { class: 'check' }, input, h('span', {}, label));
  if (disabled) row.style.cursor = 'not-allowed';
  const wrapper = h('div', {}, row);
  if (hint) wrapper.appendChild(h('div', { class: 'hint', style: { marginLeft: '24px' } }, hint));
  return wrapper;
}

function textField({ label, value, hint, placeholder, mono = false, type = 'text', onInput, disabled = false }) {
  const input = h('input', {
    class: `input ${mono ? 'mono' : ''}`,
    type,
    value: value ?? '',
    placeholder: placeholder || '',
    disabled,
    oninput: (e) => onInput?.(e.target.value),
  });
  return field({ label, control: input, hint });
}

function numberField({ label, value, hint, min, max, step = 1, onInput }) {
  const input = h('input', {
    class: 'input',
    type: 'number',
    value: value ?? 0,
    min,
    max,
    step,
    oninput: (e) => onInput?.(Number(e.target.value)),
  });
  return field({ label, control: input, hint });
}

function selectField({ label, options, value, hint, onChange, disabled = false }) {
  const el = select(options, value, { onchange: (e) => onChange?.(e.target.value), disabled });
  return field({ label, control: el, hint });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const routes = [
  { name: 'home', pattern: /^\/$/, build: () => viewHome() },
  { name: 'new', pattern: /^\/new$/, build: () => viewNewTask() },
  { name: 'batch', pattern: /^\/batch\/([^/]+)$/, build: (m) => viewBatch(decodeURIComponent(m[1])) },
  { name: 'task', pattern: /^\/task\/([^/]+)$/, build: (m) => viewTask(decodeURIComponent(m[1])) },
  { name: 'workspaces', pattern: /^\/workspaces$/, build: () => viewWorkspaces() },
  { name: 'settings', pattern: /^\/settings$/, build: () => viewSettings() },
];

function setActiveNav(name) {
  for (const link of navEl.querySelectorAll('a')) {
    const active = link.dataset.nav === name || (name === 'task' && link.dataset.nav === 'home') || (name === 'batch' && link.dataset.nav === 'home');
    link.classList.toggle('active', active);
  }
}

async function render() {
  const raw = location.hash.replace(/^#/, '') || '/';
  try { cleanup?.(); } catch { /* ignore */ }
  cleanup = null;

  const route = routes.find((r) => r.pattern.test(raw));
  const name = route?.name || 'missing';
  setActiveNav(name);

  if (name === 'new' && lastRouteName !== 'new') newTask = null;
  lastRouteName = name;

  builder = route
    ? () => route.build(route.pattern.exec(raw))
    : () => viewNotFound(raw);

  try {
    const node = await builder();
    clear(view);
    if (node) view.appendChild(node);
  } catch (err) {
    clear(view);
    view.appendChild(errorCard(err));
  }
  window.scrollTo(0, 0);
}

async function refresh() {
  if (!builder) return render();
  try { cleanup?.(); } catch { /* ignore */ }
  cleanup = null;
  try {
    const node = await builder();
    clear(view);
    if (node) view.appendChild(node);
  } catch (err) {
    clear(view);
    view.appendChild(errorCard(err));
  }
}

function viewNotFound(path) {
  return h(
    'div',
    { class: 'card' },
    emptyState({
      title: '页面不存在',
      desc: `没有找到路由 ${path}`,
      action: button('返回任务列表', { variant: 'primary', onClick: () => { location.hash = '#/'; } }),
    }),
  );
}

/* ------------------------------------------------------------------ */
/* 首页：任务列表                                                       */
/* ------------------------------------------------------------------ */

async function viewHome() {
  await Promise.all([
    loadConfig(),
    loadWorkspaces(),
    api('/api/tasks').then((data) => { state.tasks = data.tasks; }),
  ]);

  const root = h('div');
  root.appendChild(
    pageHead('任务', '每个任务按你勾选的流程，产出对应份数的 Markdown 文件', [
      button('新建任务', { variant: 'primary', onClick: () => { location.hash = '#/new'; } }),
    ]),
  );
  root.appendChild(readinessCard());

  const active = state.tasks.filter((t) => ['queued', 'running'].includes(t.status));
  if (active.length) {
    const maxConcurrent = Math.max(1, Math.min(5, state.config?.server?.maxConcurrent || 3));
    root.appendChild(
      h(
        'div',
        { class: 'notice', style: { alignItems: 'center' } },
        h('div', { style: { flex: '1' } }, `当前有 ${active.length} 个任务在运行或排队（并发上限 ${maxConcurrent}）。`),
        button('查看实时日志', {
          size: 'sm',
          variant: 'primary',
          onClick: () => { location.hash = `#/batch/${active.map((t) => t.id).join(',')}`; },
        }),
      ),
    );
  }

  root.appendChild(taskListCard());
  return root;
}

function readinessCard() {
  const slots = state.slots?.slots || [];
  const allOk = Boolean(state.slots?.allConfigured);
  const el = h('div', { class: 'card' });
  el.appendChild(
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        {},
        h('h2', {}, '模型配置'),
        h('p', { class: 'card-sub' }, allOk ? '三个模型都已配置，可以直接开始' : '有模型还没配置：未配置的流程无法运行'),
      ),
      allOk
        ? button('检查配置', { size: 'sm', onClick: () => { location.hash = '#/settings'; } })
        : h(
            'div',
            { class: 'row' },
            button('去设置', { size: 'sm', onClick: () => { location.hash = '#/settings'; } }),
            button('用模拟模型试用', { size: 'sm', variant: 'primary', onClick: enableMockMode }),
          ),
    ),
  );

  const grid = h('div', { class: 'slot-grid' });
  for (const slot of slots) {
    const missing = !slot.configured && !slot.fallbackTo;
    grid.appendChild(
      h(
        'div',
        { class: `slot ${missing ? 'missing' : ''}` },
        h('div', { class: 'slot-name' }, slot.label),
        h(
          'div',
          { class: 'slot-model' },
          slot.configured
            ? slot.model || '（未填模型名）'
            : slot.fallbackTo
              ? '复用转写模型（多模态回退）'
              : '未配置',
        ),
        h('div', { class: 'slot-kind' }, `${slot.kindLabel}${slot.isMultimodal ? ' · 多模态' : ''}`),
      ),
    );
  }
  el.appendChild(grid);

  if (state.slots?.mockMode) {
    el.appendChild(
      h('div', { class: 'hint', style: { marginTop: '10px' } }, '当前使用内置模拟模型：不会调用任何外部接口，也不会产生费用。'),
    );
  }
  return el;
}

async function enableMockMode() {
  try {
    await api('/api/config', {
      method: 'PUT',
      body: {
        models: {
          transcribe: { kind: 'mock', isMultimodal: true },
          polish: { kind: 'mock' },
          minutes: { kind: 'mock' },
        },
      },
    });
    // 配置被整体替换，丢弃未保存的草稿，避免把旧的真实配置又写回去
    settingsState.drafts = {};
    settingsState.test = {};
    await loadConfig();
    toast('已切换到内置模拟模型，可以直接新建任务试用', { type: 'ok' });
    refresh();
  } catch (err) {
    toast(err.message, { type: 'err', hint: err.hint });
  }
}

function taskListCard() {
  const el = h('div', { class: 'card' });
  if (!state.tasks.length) {
    el.appendChild(
      emptyState({
        title: '还没有任务',
        desc: '把音频或文本放进工作区文件夹，然后新建任务。',
        action: button('新建任务', { variant: 'primary', onClick: () => { location.hash = '#/new'; } }),
      }),
    );
    return el;
  }

  const table = h(
    'table',
    { class: 'table' },
    h(
      'thead',
      {},
      h('tr', {}, ['任务', '工作区', '流程', '状态', '产物', '创建时间', '操作'].map((t) => h('th', {}, t))),
    ),
  );
  const tbody = h('tbody');
  for (const task of state.tasks) {
    const meta = statusMeta(task.status);
    const steps = task.steps.map((s) => STEP_LABELS[s]).join(' · ');
    const artifacts = task.artifacts?.length
      ? task.artifacts.map((a) => a.title).join('、')
      : '—';
    const row = h(
      'tr',
      { class: 'clickable', onclick: () => { location.hash = `#/task/${task.id}`; } },
      h(
        'td',
        {},
        h('div', { class: 'cell-title' }, task.title),
        h('div', { class: 'cell-sub' }, task.input?.name || ''),
      ),
      h('td', {}, task.workspaceName || '—'),
      h('td', {}, steps || '—'),
      h('td', {}, badge(meta.label, meta.tone)),
      h('td', {}, artifacts),
      h(
        'td',
        {},
        h('div', {}, formatDate(task.createdAt)),
        task.finishedAt && task.startedAt
          ? h('div', { class: 'cell-sub' }, `耗时 ${formatDurationText(Date.parse(task.finishedAt) - Date.parse(task.startedAt))}`)
          : null,
      ),
      h(
        'td',
        { class: 'cell-actions' },
        button('删除', {
          size: 'sm',
          variant: 'danger',
          title: '删除这条任务记录',
          onClick: (event) => {
            event.stopPropagation();
            deleteTask(task);
          },
        }),
      ),
    );
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  el.appendChild(table);
  return el;
}

/**
 * 删除任务：默认只删记录，产物文件保留在交付区；
 * 有产物时额外提供「连产物一起删除」。
 */
async function deleteTask(task) {
  const artifacts = task.artifacts || [];
  const active = !isTerminal(task.status);

  const body = h(
    'div',
    {},
    h('div', { style: { fontSize: '13.5px', lineHeight: '1.7' } }, `确定删除任务「${task.title}」吗？`),
    h(
      'div',
      { class: 'hint', style: { marginTop: '8px' } },
      artifacts.length
        ? `这个任务生成了 ${artifacts.length} 个产物：${artifacts.map((a) => a.title).join('、')}。只删记录不会动这些文件。`
        : '这个任务还没有产物文件。',
    ),
    active
      ? h('div', { class: 'notice warn', style: { marginTop: '10px' } }, '任务还在运行，请先取消后再删除。')
      : null,
  );

  const doDelete = async (deleteArtifacts, close) => {
    try {
      const query = deleteArtifacts ? '?deleteArtifacts=1' : '';
      const result = await api(`/api/tasks/${encodeURIComponent(task.id)}${query}`, { method: 'DELETE' });
      close();
      toast(
        deleteArtifacts
          ? `任务已删除，连同 ${result.deletedArtifacts || 0} 个产物文件`
          : '任务已删除（产物文件保留在交付区）',
        { type: 'ok' },
      );
      await refresh();
    } catch (err) {
      toast(err.message, { type: 'err', hint: err.hint });
    }
  };

  openModal({
    title: '删除任务',
    width: 540,
    body,
    actions: [
      { label: '取消', onClick: (close) => close() },
      {
        label: '只删记录',
        disabled: active,
        onClick: (close) => doDelete(false, close),
      },
      ...(artifacts.length
        ? [{
            label: '连产物一起删除',
            variant: 'danger',
            disabled: active,
            onClick: (close) => doDelete(true, close),
          }]
        : []),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 新建任务                                                             */
/* ------------------------------------------------------------------ */

let newTask = null;

function resetNewTask() {
  newTask = {
    workspaceId: state.lastWorkspaceId || state.workspaces[0]?.id || '',
    steps: ['transcribe', 'polish', 'minutes'],
    inputPaths: [],
    deliveryMode: 'workspace',
    deliveryDir: '',
    title: '',
    files: null,
    filesKey: '',
    filesError: '',
    loadingFiles: false,
  };
  return newTask;
}

async function ensureFiles(st, inputKind) {
  const filter = inputKind === 'audio' ? 'audio' : 'text';
  const key = `${st.workspaceId}|${filter}`;
  if (st.filesKey === key && Array.isArray(st.files)) return;
  if (!st.workspaceId) {
    st.files = [];
    st.filesKey = key;
    return;
  }
  st.loadingFiles = true;
  try {
    const data = await api(`/api/workspaces/${encodeURIComponent(st.workspaceId)}/files?filter=${filter}`);
    st.files = data.files || [];
    st.filesError = '';
  } catch (err) {
    st.files = [];
    st.filesError = `${err.message}${err.hint ? `（${err.hint}）` : ''}`;
  } finally {
    st.filesKey = key;
    st.loadingFiles = false;
  }
}

function planProblems(steps) {
  const slots = Object.fromEntries((state.slots?.slots || []).map((s) => [s.slot, s]));
  const problems = [];
  for (const step of steps) {
    const slot = slots[step];
    if (!slot) continue;
    if (slot.configured || slot.fallbackTo) continue;
    problems.push(`${slot.label}还没配置（去「设置 → ${slot.label}」填写，或改用模拟模型）`);
  }
  return problems;
}

async function viewNewTask() {
  await Promise.all([loadConfig(), loadWorkspaces()]);
  const st = newTask || resetNewTask();

  if (st.workspaceId && !state.workspaces.some((w) => w.id === st.workspaceId)) st.workspaceId = '';
  if (!st.workspaceId && state.workspaces.length) st.workspaceId = state.workspaces[0].id;

  const inputKind = st.steps.includes('transcribe') ? 'audio' : 'text';
  if (st.inputPaths.length && Array.isArray(st.files)) {
    const available = new Set(st.files.map((f) => f.path));
    st.inputPaths = st.inputPaths.filter((p) => available.has(p));
  }
  await ensureFiles(st, inputKind);

  const selectedWorkspace = state.workspaces.find((w) => w.id === st.workspaceId) || null;
  const problems = [];
  if (!st.workspaceId) problems.push('请先选择或添加一个工作区');
  if (!st.steps.length) problems.push('至少要勾选一个流程');
  if (st.steps.length && !st.inputPaths.length) problems.push(`请至少选择一个${inputKind === 'audio' ? '音频' : '文本'}文件`);
  if (st.deliveryMode === 'custom' && !st.deliveryDir) problems.push('请选择交付文件夹');
  problems.push(...planProblems(st.steps));

  const root = h('div');
  root.appendChild(
    pageHead('新建任务', '文件必须已经在工作区文件夹里；程序会直接读取它，不需要手动上传', [
      button('返回列表', { onClick: () => { location.hash = '#/'; } }),
    ]),
  );

  /* 1. 工作区 */
  const wsCard = card('① 选择工作区', '每个任务都属于一个工作区文件夹，交付区默认就是它；添加时使用系统文件夹选择窗口。');
  if (!state.workspaces.length) {
    wsCard.appendChild(
      emptyState({
        title: '还没有工作区',
        desc: '先添加一个文件夹，把音频/文本放进去。',
        action: button('添加工作区文件夹', { variant: 'primary', onClick: addWorkspaceFromPicker }),
      }),
    );
  } else {
    const row = h('div', { class: 'row' });
    row.appendChild(
      h(
        'div',
        { class: 'grow' },
        select(
          state.workspaces.map((w) => ({ value: w.id, label: `${w.name} — ${w.path}` })),
          st.workspaceId,
          {
            onchange: (e) => {
              st.workspaceId = e.target.value;
              st.inputPaths = [];
              st.files = null;
              st.filesKey = '';
              refresh();
            },
          },
        ),
      ),
    );
    row.appendChild(button('添加工作区', { size: 'sm', onClick: addWorkspaceFromPicker }));
    row.appendChild(button('刷新文件', { size: 'sm', onClick: () => { st.filesKey = ''; refresh(); } }));
    if (st.workspaceId) {
      row.appendChild(
        button('删除工作区', {
          size: 'sm',
          variant: 'danger',
          onClick: () => removeWorkspace(st.workspaceId),
        }),
      );
    }
    row.appendChild(button('管理工作区', { size: 'sm', variant: 'ghost', onClick: () => { location.hash = '#/workspaces'; } }));
    wsCard.appendChild(row);
    if (selectedWorkspace) {
      wsCard.appendChild(
        h('div', { class: 'hint', style: { marginTop: '8px' } }, `路径：${selectedWorkspace.path}${selectedWorkspace.writable ? '' : '（没有写权限！）'}`),
      );
    }
  }
  root.appendChild(wsCard);

  /* 2. 流程 */
  const stepsCard = card('② 选择要执行的流程', '至少选一项；勾了转写就必须选音频，否则选文本。');
  const flowGrid = h('div', { class: 'flow-pick' });
  const FLOW_INFO = [
    { step: 'transcribe', title: '转写', desc: '把音频转成带时间段的原文' },
    { step: 'polish', title: '润色', desc: '把口语稿整理成通顺书面稿' },
    { step: 'minutes', title: '纪要', desc: '生成结构化会议纪要' },
  ];
  for (const info of FLOW_INFO) {
    const on = st.steps.includes(info.step);
    flowGrid.appendChild(
      h(
        'label',
        { class: `flow-card ${on ? 'on' : ''}` },
        h(
          'div',
          { class: 'fc-title' },
          h('input', {
            type: 'checkbox',
            checked: on,
            onchange: () => {
              const index = st.steps.indexOf(info.step);
              if (index >= 0) st.steps.splice(index, 1);
              else st.steps.push(info.step);
              st.steps = ['transcribe', 'polish', 'minutes'].filter((s) => st.steps.includes(s));
              st.files = null;
              st.filesKey = '';
              refresh();
            },
          }),
          info.title,
        ),
        h('div', { class: 'fc-desc' }, info.desc),
      ),
    );
  }
  stepsCard.appendChild(flowGrid);
  stepsCard.appendChild(
    h(
      'div',
      { class: 'notice', style: { marginTop: '12px', marginBottom: '0' } },
      h('div', {}, st.steps.includes('transcribe')
        ? '因为勾选了「转写」，本任务需要提供音频文件。'
        : '没有勾选「转写」，本任务需要提供文本文件（txt / md / srt / vtt）。'),
    ),
  );
  root.appendChild(stepsCard);

  /* 3. 文件（可多选，每个文件对应一个任务） */
  const selectedCount = st.inputPaths.length;
  const filesCard = card(
    `③ 选择${inputKind === 'audio' ? '音频' : '文本'}文件（可多选）`,
    st.workspaceId
      ? '只显示当前工作区里的文件（含子文件夹，最多 3 层）；勾选几个就并行创建几个任务'
      : '请先选择工作区',
  );
  if (st.loadingFiles) {
    filesCard.appendChild(loading('正在读取工作区文件…'));
  } else if (st.filesError) {
    filesCard.appendChild(h('div', { class: 'notice err' }, st.filesError));
  } else if (!st.files || !st.files.length) {
    filesCard.appendChild(
      emptyState({
        title: '工作区里没有可用的文件',
        desc: inputKind === 'audio'
          ? '把 mp3 / wav / m4a 等音频放进工作区文件夹，然后点「刷新文件」。'
          : '把 txt / md / srt / vtt 文本放进工作区文件夹，然后点「刷新文件」。',
        action: button('刷新文件', { onClick: () => { st.filesKey = ''; refresh(); } }),
      }),
    );
  } else {
    const allSelected = selectedCount > 0 && selectedCount === st.files.length;
    const toolbar = h(
      'div',
      { class: 'row', style: { marginBottom: '8px' } },
      h('span', { class: 'muted small' }, `已选 ${selectedCount} / ${st.files.length} 个`),
      h('div', { class: 'spacer' }),
      button(allSelected ? '取消全选' : '全选', {
        size: 'sm',
        onClick: () => {
          st.inputPaths = allSelected ? [] : st.files.map((f) => f.path);
          refresh();
        },
      }),
      selectedCount
        ? button('清空选择', {
            size: 'sm',
            variant: 'ghost',
            onClick: () => { st.inputPaths = []; refresh(); },
          })
        : null,
    );
    filesCard.appendChild(toolbar);

    const list = h('div', { class: 'file-list' });
    for (const file of st.files) {
      const selected = st.inputPaths.includes(file.path);
      list.appendChild(
        h(
          'div',
          {
            class: `file-item ${selected ? 'selected' : ''}`,
            onclick: () => {
              if (st.inputPaths.includes(file.path)) {
                st.inputPaths = st.inputPaths.filter((p) => p !== file.path);
              } else {
                st.inputPaths = st.inputPaths.concat(file.path);
              }
              // 重绘后保持列表滚动位置，避免勾选深处文件时跳回顶部
              const keepTop = list.scrollTop;
              const keepScrollY = window.scrollY;
              refresh().then(() => {
                const next = view.querySelector('.file-list');
                if (next) next.scrollTop = keepTop;
                window.scrollTo(0, keepScrollY);
              });
            },
          },
          h('input', { class: 'file-radio', type: 'checkbox', checked: selected, readonly: true }),
          h(
            'div',
            { style: { flex: '1', minWidth: '0' } },
            h('div', { class: 'fname' }, file.relPath || file.name),
            h('div', { class: 'fmeta' }, `${formatBytes(file.size)} · ${formatDate(file.mtime)}`),
          ),
          h('span', { class: 'file-kind' }, file.kind === 'audio' ? '音频' : '文本'),
        ),
      );
    }
    filesCard.appendChild(list);
  }
  if (selectedCount) {
    const names = st.files
      ? st.files.filter((f) => st.inputPaths.includes(f.path)).map((f) => f.relPath || f.name)
      : [];
    filesCard.appendChild(
      h(
        'div',
        { class: 'hint', style: { marginTop: '8px', whiteSpace: 'pre-line' } },
        `将创建 ${selectedCount} 个任务：\n${names.join('\n')}`,
      ),
    );
  }
  root.appendChild(filesCard);

  /* 4. 交付区与任务名 */
  const deliveryCard = card('④ 交付区与任务名', '不指定时，产物直接写进工作区文件夹。');
  const sameRadio = h('input', {
    type: 'radio',
    name: 'delivery',
    checked: st.deliveryMode === 'workspace',
    onchange: () => { st.deliveryMode = 'workspace'; refresh(); },
  });
  const customRadio = h('input', {
    type: 'radio',
    name: 'delivery',
    checked: st.deliveryMode === 'custom',
    onchange: () => { st.deliveryMode = 'custom'; refresh(); },
  });
  deliveryCard.appendChild(
    h('div', { class: 'row', style: { marginBottom: '8px' } }, h('label', { class: 'check' }, sameRadio, h('span', {}, '同工作区（默认）'))),
  );
  deliveryCard.appendChild(
    h(
      'div',
      { class: 'row', style: { marginBottom: '10px' } },
      h('label', { class: 'check' }, customRadio, h('span', {}, '指定交付文件夹')),
      st.deliveryMode === 'custom'
        ? h(
            'div',
            { class: 'row', style: { flex: '1' } },
            h('input', { class: 'input mono', readonly: true, value: st.deliveryDir, placeholder: '还没有选择文件夹', style: { flex: '1' } }),
            button('选择文件夹', {
              size: 'sm',
              onClick: async () => {
                const picked = await pickDirectory({
                  title: '选择交付文件夹',
                  initialPath: st.deliveryDir || selectedWorkspace?.path || '',
                });
                if (picked) {
                  st.deliveryDir = picked;
                  refresh();
                }
              },
            }),
          )
        : null,
    ),
  );
  deliveryCard.appendChild(
    field({
      label: '任务名（可选）',
      control: h('input', {
        class: 'input',
        value: st.title,
        placeholder: '例如：产品周会 3 月复盘',
        oninput: (e) => { st.title = e.target.value; },
      }),
      hint: '不填就用文件名 + 时间生成',
    }),
  );
  root.appendChild(deliveryCard);

  /* 5. 开始 */
  const startCard = h('div', { class: 'card' });
  if (problems.length) {
    startCard.appendChild(
      h(
        'div',
        { class: 'notice warn' },
        h('div', { style: { whiteSpace: 'pre-line' } }, problems.map((p) => `• ${p}`).join('\n')),
      ),
    );
  }

  const maxConcurrent = Math.max(1, Math.min(5, state.config?.server?.maxConcurrent || 3));
  const batchSize = st.inputPaths.length;
  const startBtn = button(batchSize > 1 ? `并行开始 ${batchSize} 个任务` : '开始处理', {
    variant: 'primary',
    disabled: problems.length > 0,
    onClick: async () => {
      const files = batchSize ? st.inputPaths.slice() : [];
      startBtn.disabled = true;
      const created = [];
      try {
        for (let i = 0; i < files.length; i += 1) {
          startBtn.textContent = `正在创建任务 ${i + 1}/${files.length}…`;
          const filePath = files[i];
          const fileName = filePath.split(/[\\/]/).pop() || '';
          const baseTitle = st.title.trim();
          const title = baseTitle
            ? (files.length > 1 ? `${baseTitle} · ${fileName}` : baseTitle)
            : '';
          const data = await api('/api/tasks', {
            method: 'POST',
            body: {
              workspaceId: st.workspaceId,
              title,
              inputPath: filePath,
              steps: st.steps,
              deliveryDir: st.deliveryMode === 'custom' ? st.deliveryDir : '',
            },
          });
          created.push(data.task.id);
        }
        newTask = null;
        location.hash = `#/batch/${created.join(',')}`;
      } catch (err) {
        startBtn.disabled = false;
        startBtn.textContent = batchSize > 1 ? `并行开始 ${batchSize} 个任务` : '开始处理';
        toast(err.message, { type: 'err', hint: err.hint, timeout: 9000 });
        if (created.length) {
          toast(`已创建 ${created.length} 个任务，先带你去实时日志页`, { type: 'warn' });
          location.hash = `#/batch/${created.join(',')}`;
        }
      }
    },
  });

  if (batchSize > 1) {
    startCard.appendChild(
      h(
        'div',
        { class: 'notice', style: { marginBottom: '10px' } },
        h(
          'div',
          {},
          `将创建 ${batchSize} 个任务；当前并发上限 ${maxConcurrent}，因此会先同时跑 ${Math.min(batchSize, maxConcurrent)} 个，其余排队（可在「设置 → 通用」调整）。`,
        ),
      ),
    );
  }

  const summary = h(
    'div',
    { class: 'muted small' },
    `流程：${st.steps.map((s) => STEP_LABELS[s]).join(' → ') || '（未选择）'} ｜ 文件：${batchSize ? `${batchSize} 个` : '（未选择）'} ｜ 交付：${st.deliveryMode === 'custom' ? st.deliveryDir || '（未选择）' : '同工作区'}`,
  );
  startCard.appendChild(h('div', { class: 'row', style: { marginBottom: '10px' } }, startBtn, h('div', { class: 'spacer' }), summary));
  root.appendChild(startCard);

  return root;
}

async function addWorkspaceFromPicker() {
  const picked = await pickDirectory({ title: '选择工作区文件夹', initialPath: '' });
  if (!picked) return;
  try {
    const data = await api('/api/workspaces', { method: 'POST', body: { path: picked } });
    await loadWorkspaces();
    if (newTask) {
      newTask.workspaceId = data.workspace.id;
      newTask.files = null;
      newTask.filesKey = '';
    }
    toast(`已添加工作区：${data.workspace.name}`, { type: 'ok' });
    refresh();
  } catch (err) {
    toast(err.message, { type: 'err', hint: err.hint });
  }
}

/** 从列表里移除工作区（不删文件夹，也不删历史任务） */
async function removeWorkspace(workspaceId) {
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const ok = await confirmDialog({
    title: '删除工作区',
    message: `确定从列表里移除工作区「${ws.name}」吗？\n\n• 只会移除登记，不会删除文件夹里的任何文件\n• 已产生的任务记录和产物会保留`,
    okText: '移除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
    await loadWorkspaces();
    if (newTask && newTask.workspaceId === workspaceId) {
      newTask.workspaceId = state.workspaces[0]?.id || '';
      newTask.inputPaths = [];
      newTask.files = null;
      newTask.filesKey = '';
    }
    toast(`已移除工作区：${ws.name}`, { type: 'ok' });
    refresh();
  } catch (err) {
    toast(err.message, { type: 'err', hint: err.hint });
  }
}

/* ------------------------------------------------------------------ */
/* 任务详情                                                             */
/* ------------------------------------------------------------------ */

function parseLogLine(line) {
  if (line && typeof line === 'object') return line;
  try {
    return JSON.parse(String(line));
  } catch {
    return { level: 'info', formatted: String(line) };
  }
}

async function viewTask(taskId) {
  const data = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
  let task = data.task;
  const logs = (data.logs || []).map(parseLogLine);

  const root = h('div');
  const actionsEl = h('div', { class: 'row' });
  const statusEl = badge(statusMeta(task.status).label, statusMeta(task.status).tone);

  const head = h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      {},
      h('h1', {}, task.title),
      h('p', {}, `${task.workspaceName} · ${task.input?.name || ''} · 创建于 ${formatDate(task.createdAt)}`),
    ),
    h('div', { class: 'page-actions' }, statusEl, actionsEl),
  );
  root.appendChild(head);

  /* 错误卡片 */
  const errorSlot = h('div');
  root.appendChild(errorSlot);

  /* 进度 */
  const progressBar = h('div', { style: { width: `${task.progress || 0}%` } });
  const progressPct = h('span', { class: 'muted small' }, `${task.progress || 0}%`);
  const stageEl = h('div', { class: 'muted small' }, task.stageMessage || '');
  const chipsEl = h('div', { class: 'steps-flow' });
  const chips = {};

  for (const step of task.steps) {
    chips[step] = h('span', { class: 'step-chip' }, STEP_LABELS[step]);
    chipsEl.appendChild(chips[step]);
  }

  const progressCard = card(null, null, [
    h('div', { class: 'row', style: { marginBottom: '8px' } }, h('div', { class: 'grow' }, stageEl), progressPct),
    h('div', { class: 'progress' }, progressBar),
    chipsEl,
    task.deliveryDir
      ? h(
          'div',
          { class: 'row', style: { marginTop: '12px' } },
          h('span', { class: 'muted small' }, '交付区：'),
          h('span', { class: 'mono' }, task.deliveryDir),
          h('div', { class: 'spacer' }),
          button('打开交付文件夹', { size: 'sm', onClick: () => openPath(task.deliveryDir, false) }),
        )
      : null,
  ]);
  root.appendChild(progressCard);

  /* 模型计划 */
  const planCard = card('本次使用的模型', null);
  const planGrid = h('div', { class: 'slot-grid' });
  for (const slot of ['transcribe', 'polish', 'minutes']) {
    const entry = task.modelPlan?.[slot];
    if (!entry) continue;
    planGrid.appendChild(
      h(
        'div',
        { class: `slot ${entry.fallback ? 'missing' : ''}` },
        h('div', { class: 'slot-name' }, STEP_LABELS[slot]),
        h('div', { class: 'slot-model' }, entry.model || '（未填模型名）'),
        h('div', { class: 'slot-kind' }, entry.fallback ? '复用转写模型（多模态回退）' : entry.label),
      ),
    );
  }
  planCard.appendChild(planGrid);
  root.appendChild(planCard);

  /* 日志 */
  const logEl = h('div', { class: 'log' });
  for (const entry of logs) {
    const text = entry.formatted || entry.message || '';
    const cls = entry.level === 'warn' ? 'lv-warn' : entry.level === 'error' ? 'lv-error' : '';
    logEl.appendChild(h('div', { class: cls }, text));
  }
  const logCard = card('运行日志', '这里能看到每一次外部调用与降级提示', [logEl]);
  root.appendChild(logCard);

  /* 产物 */
  const artifactsCard = card('产物', '产物写在你选择的交付区，文件名带时间戳，不会覆盖旧文件');
  const artifactsBody = h('div');
  artifactsCard.appendChild(artifactsBody);
  root.appendChild(artifactsCard);

  const openPath = async (target, reveal) => {
    try {
      await api('/api/open', { method: 'POST', body: { path: target, reveal } });
    } catch (err) {
      toast(err.message, { type: 'err', hint: err.hint });
    }
  };

  function renderActions(current) {
    clear(actionsEl);
    actionsEl.appendChild(button('返回列表', { size: 'sm', onClick: () => { location.hash = '#/'; } }));
    if (isTerminal(current.status)) {
      if (['failed', 'interrupted', 'canceled'].includes(current.status)) {
        actionsEl.appendChild(
          button('重新运行', {
            size: 'sm',
            variant: 'primary',
            onClick: async () => {
              try {
                await api(`/api/tasks/${encodeURIComponent(current.id)}/retry`, { method: 'POST' });
                await refresh();
              } catch (err) {
                toast(err.message, { type: 'err', hint: err.hint });
              }
            },
          }),
        );
      }
    } else {
      actionsEl.appendChild(
        button('取消任务', {
          size: 'sm',
          variant: 'danger',
          onClick: async () => {
            const ok = await confirmDialog({ title: '取消任务', message: '确定要取消这个任务吗？已经生成的产物会保留。', okText: '取消任务', danger: true });
            if (!ok) return;
            try {
              await api(`/api/tasks/${encodeURIComponent(current.id)}/cancel`, { method: 'POST' });
            } catch (err) {
              toast(err.message, { type: 'err', hint: err.hint });
            }
          },
        }),
      );
    }
  }

  function renderError(current) {
    clear(errorSlot);
    if (!current.error) return;
    if (current.error.code === 'CANCELED') return;
    errorSlot.appendChild(
      h(
        'div',
        { class: 'card err-card' },
        h('h2', {}, '这一步失败了'),
        h('div', { style: { whiteSpace: 'pre-line' } }, current.error.message),
        current.error.hint ? h('div', { class: 'err-hint' }, `建议：${current.error.hint}`) : null,
        current.error.requestId ? h('div', { class: 'err-hint mono' }, `requestId: ${current.error.requestId}`) : null,
      ),
    );
  }

  function paint(current) {
    const meta = statusMeta(current.status);
    statusEl.textContent = meta.label;
    statusEl.className = `badge ${meta.tone}`.trim();
    progressBar.style.width = `${current.progress || 0}%`;
    progressPct.textContent = `${current.progress || 0}%`;
    stageEl.textContent = current.stageMessage || '';
    for (const step of current.steps) {
      const el = chips[step];
      if (!el) continue;
      const stateName = current.stepStates?.[step] || 'pending';
      let cls = 'step-chip';
      if (stateName === 'done') cls += ' done';
      else if (stateName === 'failed') cls += ' failed';
      else if (stateName === 'canceled') cls += ' skipped';
      else if (current.status === 'running' && current.currentStep === step) cls += ' active';
      else if (stateName === 'running') cls += ' active';
      el.className = cls;
    }
    renderActions(current);
    renderError(current);
  }

  async function paintArtifacts(current) {
    clear(artifactsBody);
    const artifacts = current.artifacts || [];
    if (!artifacts.length) {
      artifactsBody.appendChild(
        h('div', { class: 'muted small' }, '产物会在对应步骤完成后出现在这里；如果任务还在跑，稍等一下。'),
      );
      return;
    }
    const order = ['transcribe', 'polish', 'minutes'];
    const sorted = artifacts.slice().sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
    const bodyEl = h('div', { class: 'markdown' });
    const tabsEl = h('div', { class: 'tabs' });
    const infoEl = h('div', { class: 'row', style: { marginBottom: '10px' } });
    let active = sorted[0].step;

    const load = async (step) => {
      active = step;
      for (const tab of tabsEl.children) tab.classList.toggle('active', tab.dataset.step === step);
      bodyEl.innerHTML = '<div class="loading">正在读取产物…</div>';
      clear(infoEl);
      try {
        const data = await api(`/api/tasks/${encodeURIComponent(current.id)}/artifacts/${step}`);
        bodyEl.innerHTML = renderMarkdown(data.artifact.content);
        infoEl.appendChild(h('span', { class: 'mono muted' }, data.artifact.fileName));
        infoEl.appendChild(h('div', { class: 'spacer' }));
        infoEl.appendChild(button('打开所在位置', { size: 'sm', onClick: () => openPath(data.artifact.path, true) }));
      } catch (err) {
        bodyEl.textContent = err.message;
      }
    };

    for (const artifact of sorted) {
      const tab = h(
        'button',
        {
          class: 'tab',
          type: 'button',
          dataset: { step: artifact.step },
          onclick: () => load(artifact.step),
        },
        artifact.title,
      );
      tabsEl.appendChild(tab);
    }
    artifactsBody.appendChild(tabsEl);
    artifactsBody.appendChild(infoEl);
    artifactsBody.appendChild(bodyEl);
    await load(active);
  }

  paint(task);
  await paintArtifacts(task);

  if (!isTerminal(task.status)) {
    const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events?token=${encodeURIComponent(TOKEN)}`);
    cleanup = () => {
      try { es.close(); } catch { /* ignore */ }
    };

    es.addEventListener('task', (event) => {
      try {
        task = JSON.parse(event.data).task;
        paint(task);
      } catch { /* ignore */ }
    });

    es.addEventListener('log', (event) => {
      try {
        const entry = JSON.parse(event.data);
        const text = entry.formatted || entry.message || '';
        const cls = entry.level === 'warn' ? 'lv-warn' : entry.level === 'error' ? 'lv-error' : '';
        const nearBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;
        logEl.appendChild(h('div', { class: cls }, text));
        while (logEl.childElementCount > 600) logEl.firstElementChild.remove();
        if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
      } catch { /* ignore */ }
    });

    es.addEventListener('end', (event) => {
      try {
        task = JSON.parse(event.data).task;
        paint(task);
      } catch { /* ignore */ }
      setTimeout(() => {
        try { es.close(); } catch { /* ignore */ }
        refresh();
      }, 500);
    });
  }

  return root;
}

/* ------------------------------------------------------------------ */
/* 批量运行：多个任务同时看进度与日志                                    */
/* ------------------------------------------------------------------ */

async function viewBatch(idsCsv) {
  const ids = String(idsCsv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) return viewNotFound('/batch');

  const fetched = await Promise.all(
    ids.map(async (id) => {
      try {
        const data = await api(`/api/tasks/${encodeURIComponent(id)}`);
        return { task: data.task, logs: (data.logs || []).map(parseLogLine) };
      } catch {
        return null;
      }
    }),
  );
  const items = fetched.filter(Boolean);
  const missing = fetched.length - items.length;
  if (!items.length) {
    return errorCard(new Error('这些任务都不存在了（可能已被清理），回列表看看'));
  }
  if (missing > 0) toast(`有 ${missing} 个任务读取失败，已跳过`, { type: 'warn' });

  const root = h('div');

  const statusSummary = h('span', { class: 'muted small' });
  const headActions = h('div', { class: 'row' });

  root.appendChild(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, `并行任务（${items.length} 个）`),
        h('p', {}, '下面是每个任务各自的进度与日志，可同时查看；完成后点「打开详情」看产物'),
      ),
      h('div', { class: 'page-actions' }, statusSummary, headActions),
    ),
  );

  const grid = h('div', { class: 'batch-grid' });
  root.appendChild(grid);

  const cards = [];

  function countActive() {
    return cards.filter((c) => !isTerminal(c.get().status)).length;
  }

  function updateHead() {
    const active = countActive();
    const total = cards.length;
    statusSummary.textContent = active ? `运行中 ${active} / ${total}` : `全部结束（${total}）`;
    clear(headActions);
    headActions.appendChild(button('返回列表', { size: 'sm', onClick: () => { location.hash = '#/'; } }));
    if (active) {
      headActions.appendChild(
        button('全部取消', {
          size: 'sm',
          variant: 'danger',
          onClick: async () => {
            const ok = await confirmDialog({
              title: '取消全部任务',
              message: `确定取消这 ${active} 个还在运行的任务吗？已经生成的产物会保留。`,
              okText: '全部取消',
              danger: true,
            });
            if (!ok) return;
            await Promise.all(
              cards
                .filter((c) => !isTerminal(c.get().status))
                .map((c) => api(`/api/tasks/${encodeURIComponent(c.get().id)}/cancel`, { method: 'POST' }).catch(() => {})),
            );
          },
        }),
      );
    }
    if (!active && cards.length) {
      const deliveryDirs = [...new Set(cards.map((c) => c.get().deliveryDir).filter(Boolean))];
      if (deliveryDirs.length === 1) {
        headActions.appendChild(button('打开交付文件夹', { size: 'sm', onClick: () => openPathExternal(deliveryDirs[0], false) }));
      }
      headActions.appendChild(button('回到列表', { size: 'sm', variant: 'primary', onClick: () => { location.hash = '#/'; } }));
    }
  }

  const pending = new Set();
  const cleanupFns = [];

  function onOneTerminal() {
    updateHead();
    if (countActive() === 0) {
      setTimeout(() => { if (!pending.size) refresh(); }, 600);
    }
  }

  for (const item of items) {
    let task = item.task;

    const titleEl = h('div', { class: 'bc-title' }, task.title);
    const subEl = h('div', { class: 'muted small' }, `${task.workspaceName || ''} · ${task.input?.name || ''}`);
    const statusEl = badge(statusMeta(task.status).label, statusMeta(task.status).tone);
    const barEl = h('div', { style: { width: `${task.progress || 0}%` } });
    const stageEl = h('div', { class: 'muted small' }, task.stageMessage || '');
    const pctEl = h('div', { class: 'muted small' }, `${task.progress || 0}%`);
    const logEl = h('div', { class: 'log compact' });
    const actionsEl = h('div', { class: 'row bc-actions' });
    const artifactEl = h('div', { class: 'muted small bc-artifacts' });

    for (const entry of item.logs) {
      const cls = entry.level === 'warn' ? 'lv-warn' : entry.level === 'error' ? 'lv-error' : '';
      logEl.appendChild(h('div', { class: cls }, entry.formatted || entry.message || ''));
    }
    logEl.scrollTop = logEl.scrollHeight;

    const cardEl = h(
      'div',
      { class: 'card batch-card' },
      h('div', { class: 'bc-head' }, h('div', { class: 'grow' }, titleEl, subEl), statusEl),
      h('div', { class: 'progress', style: { marginTop: '10px' } }, barEl),
      h('div', { class: 'row', style: { marginTop: '6px' } }, stageEl, h('div', { class: 'spacer' }), pctEl),
      logEl,
      artifactEl,
      actionsEl,
    );
    grid.appendChild(cardEl);

    const card = {
      id: task.id,
      get: () => task,
      el: cardEl,
    };
    cards.push(card);

    const appendLog = (entry) => {
      const text = entry.formatted || entry.message || '';
      if (!text) return;
      const cls = entry.level === 'warn' ? 'lv-warn' : entry.level === 'error' ? 'lv-error' : '';
      const nearBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
      logEl.appendChild(h('div', { class: cls }, text));
      while (logEl.childElementCount > 400) logEl.firstElementChild.remove();
      if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
    };

    const paint = () => {
      const meta = statusMeta(task.status);
      statusEl.textContent = meta.label;
      statusEl.className = `badge ${meta.tone}`.trim();
      barEl.style.width = `${task.progress || 0}%`;
      pctEl.textContent = `${task.progress || 0}%`;
      stageEl.textContent = task.stageMessage || '';
      titleEl.textContent = task.title;
      subEl.textContent = `${task.workspaceName || ''} · ${task.input?.name || ''}`;

      clear(actionsEl);
      actionsEl.appendChild(
        button('打开详情', {
          size: 'sm',
          onClick: () => { location.hash = `#/task/${task.id}`; },
        }),
      );
      if (!isTerminal(task.status)) {
        actionsEl.appendChild(
          button('取消', {
            size: 'sm',
            variant: 'danger',
            onClick: async () => {
              try {
                await api(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST' });
              } catch (err) {
                toast(err.message, { type: 'err', hint: err.hint });
              }
            },
          }),
        );
      } else if (['failed', 'interrupted', 'canceled'].includes(task.status)) {
        actionsEl.appendChild(
          button('重新运行', {
            size: 'sm',
            variant: 'primary',
            onClick: async () => {
              try {
                await api(`/api/tasks/${encodeURIComponent(task.id)}/retry`, { method: 'POST' });
                refresh();
              } catch (err) {
                toast(err.message, { type: 'err', hint: err.hint });
              }
            },
          }),
        );
      }

      clear(artifactEl);
      if (task.artifacts?.length) {
        artifactEl.appendChild(h('span', {}, `产物：${task.artifacts.map((a) => a.title).join('、')}`));
        artifactEl.appendChild(
          button('打开所在位置', {
            size: 'sm',
            variant: 'ghost',
            onClick: () => openPathExternal(task.deliveryDir || task.artifacts[0].path, false),
          }),
        );
      } else if (task.error && task.status === 'failed') {
        artifactEl.appendChild(h('div', { class: 'lv-error' }, task.error.message));
      }
    };

    paint();

    if (!isTerminal(task.status)) {
      pending.add(task.id);
      const es = new EventSource(`/api/tasks/${encodeURIComponent(task.id)}/events?token=${encodeURIComponent(TOKEN)}`);
      cleanupFns.push(() => { try { es.close(); } catch { /* ignore */ } });

      es.addEventListener('task', (event) => {
        try {
          task = JSON.parse(event.data).task;
          paint();
          updateHead();
        } catch { /* ignore */ }
      });
      es.addEventListener('log', (event) => {
        try { appendLog(JSON.parse(event.data)); } catch { /* ignore */ }
      });
      es.addEventListener('end', (event) => {
        try {
          task = JSON.parse(event.data).task;
        } catch { /* ignore */ }
        pending.delete(task.id);
        paint();
        onOneTerminal();
        try { es.close(); } catch { /* ignore */ }
      });
    }
  }

  updateHead();

  cleanup = () => {
    for (const fn of cleanupFns) fn();
  };

  return root;
}

/* ------------------------------------------------------------------ */
/* 工作区                                                               */
/* ------------------------------------------------------------------ */

async function viewWorkspaces() {
  await loadWorkspaces();
  const root = h('div');
  root.appendChild(
    pageHead('工作区', '工作区就是程序直接读取的文件夹；添加时弹出系统文件夹选择窗口', [
      button('添加工作区', { variant: 'primary', onClick: addWorkspaceFromPicker }),
    ]),
  );

  const el = h('div', { class: 'card' });
  if (!state.workspaces.length) {
    el.appendChild(
      emptyState({
        title: '还没有工作区',
        desc: '添加一个文件夹，把会议录音或文本放进去，就能新建任务了。',
        action: button('添加工作区', { variant: 'primary', onClick: addWorkspaceFromPicker }),
      }),
    );
    root.appendChild(el);
    return root;
  }

  const table = h(
    'table',
    { class: 'table' },
    h('thead', {}, h('tr', {}, ['名称', '文件夹路径', '默认交付区', '状态', '操作'].map((t) => h('th', {}, t)))),
  );
  const tbody = h('tbody');
  for (const ws of state.workspaces) {
    tbody.appendChild(
      h(
        'tr',
        {},
        h('td', { class: 'cell-title' }, ws.name),
        h('td', { class: 'mono' }, ws.path),
        h('td', { class: 'mono' }, ws.defaultDeliveryPath || '同工作区'),
        h(
          'td',
          {},
          ws.exists ? badge(ws.writable ? '可用' : '不可写', ws.writable ? 'ok' : 'warn') : badge('文件夹不存在', 'err'),
        ),
        h(
          'td',
          {},
          h(
            'div',
            { class: 'row' },
            button('编辑', { size: 'sm', onClick: () => editWorkspace(ws) }),
            button('删除', {
              size: 'sm',
              variant: 'danger',
              onClick: () => removeWorkspace(ws.id),
            }),
          ),
        ),
      ),
    );
  }
  table.appendChild(tbody);
  el.appendChild(table);
  root.appendChild(el);
  return root;
}

function editWorkspace(ws) {
  const nameInput = h('input', { class: 'input', value: ws.name });
  const pathInput = h('input', { class: 'input mono', readonly: true, value: ws.path });
  const deliveryInput = h('input', { class: 'input mono', readonly: true, value: ws.defaultDeliveryPath || '' });

  const modal = openModal({
    title: `编辑工作区：${ws.name}`,
    body: h(
      'div',
      {},
      field({ label: '名称', control: nameInput }),
      field({ label: '文件夹路径', control: pathInput, hint: '工作区路径暂不支持直接修改，需要的话请重新添加' }),
      field({
        label: '默认交付区',
        control: h(
          'div',
          { class: 'row' },
          h('div', { class: 'grow' }, deliveryInput),
          button('选择', {
            size: 'sm',
            onClick: async () => {
              const picked = await pickDirectory({ title: '选择默认交付文件夹', initialPath: ws.defaultDeliveryPath || ws.path });
              if (picked) deliveryInput.value = picked;
            },
          }),
          button('清空', {
            size: 'sm',
            onClick: () => { deliveryInput.value = ''; },
          }),
        ),
        hint: '留空表示默认交付回工作区',
      }),
    ),
    width: 620,
    actions: [
      { label: '取消', onClick: (close) => close() },
      {
        label: '保存',
        variant: 'primary',
        onClick: async (close) => {
          try {
            await api(`/api/workspaces/${encodeURIComponent(ws.id)}`, {
              method: 'PATCH',
              body: { name: nameInput.value.trim(), defaultDeliveryPath: deliveryInput.value.trim() },
            });
            close();
            await loadWorkspaces();
            toast('已保存', { type: 'ok' });
            refresh();
          } catch (err) {
            toast(err.message, { type: 'err', hint: err.hint });
          }
        },
      },
    ],
  });
  return modal;
}

/* ------------------------------------------------------------------ */
/* 设置                                                                 */
/* ------------------------------------------------------------------ */

const settingsState = { tab: 'transcribe', drafts: {}, test: {} };

function getDraft(slot) {
  if (!settingsState.drafts[slot]) {
    settingsState.drafts[slot] = structuredClone(state.config.models[slot]);
  }
  return settingsState.drafts[slot];
}

async function saveSlot(slot) {
  const draft = getDraft(slot);
  try {
    await api('/api/config', { method: 'PUT', body: { models: { [slot]: draft } } });
    delete settingsState.drafts[slot];
    await loadConfig();
    toast('已保存', { type: 'ok' });
    refresh();
  } catch (err) {
    toast(err.message, { type: 'err', hint: err.hint });
  }
}

async function testSlot(slot) {
  const draft = getDraft(slot);
  settingsState.test[slot] = { pending: true };
  renderTestResult(slot);
  try {
    const result = await api('/api/config/test', { method: 'POST', body: { slot, config: draft } });
    settingsState.test[slot] = result;
  } catch (err) {
    settingsState.test[slot] = { ok: false, message: err.message, hint: err.hint };
  }
  renderTestResult(slot);
}

function renderTestResult(slot) {
  const target = document.getElementById(`test-result-${slot}`);
  if (!target) return;
  clear(target);
  const result = settingsState.test[slot];
  if (!result) return;
  if (result.pending) {
    target.appendChild(loading('正在测试连接…'));
    return;
  }
  const tone = result.ok ? 'notice' : 'notice warn';
  target.appendChild(
    h(
      'div',
      { class: tone },
      h(
        'div',
        {},
        h('b', {}, result.ok ? (result.warning ? '可达（有提示）' : '连接成功') : '连接失败'),
        result.latencyMs ? h('span', { class: 'muted small' }, ` · ${result.latencyMs}ms`) : null,
        h('div', { style: { marginTop: '4px' } }, result.message || ''),
        result.hint ? h('div', { class: 'small', style: { marginTop: '4px' } }, `建议：${result.hint}`) : null,
        result.requestId ? h('div', { class: 'mono small', style: { marginTop: '4px' } }, `requestId: ${result.requestId}`) : null,
      ),
    ),
  );
}

function kindHint(kinds, value) {
  return kinds.find((k) => k.value === value)?.hint || '';
}

function apiKeyField(draft, label = 'API Key') {
  const input = h('input', {
    class: 'input mono',
    type: 'password',
    value: draft.apiKey || '',
    placeholder: 'sk-...',
    oninput: (e) => { draft.apiKey = e.target.value; },
  });
  const toggle = button('显示', {
    size: 'sm',
    onClick: () => {
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      toggle.textContent = hidden ? '隐藏' : '显示';
    },
  });
  return field({
    label,
    control: h('div', { class: 'row' }, h('div', { class: 'grow' }, input), toggle),
    hint: '密钥只保存在本机 data/config.json；显示为掩码时表示已保存，不改动即保持原值',
  });
}

function kindSelectField({ draft, kinds, onChange }) {
  const wrapper = h('div');
  const hintEl = h('div', { class: 'hint' }, kindHint(kinds, draft.kind));
  wrapper.appendChild(
    field({
      label: '接入方式',
      control: select(
        kinds.map((k) => ({ value: k.value, label: k.label })),
        draft.kind,
        {
          onchange: (e) => {
            draft.kind = e.target.value;
            if (ASR_ONLY_KINDS.includes(draft.kind)) draft.isMultimodal = false;
            onChange?.();
            refresh();
          },
        },
      ),
      hint: null,
    }),
  );
  wrapper.appendChild(hintEl);
  return wrapper;
}

function connectionFields(draft) {
  if (draft.kind === 'mock') {
    return [h('div', { class: 'notice' }, '内置模拟模型不需要接口地址与密钥，用于先跑通流程、检查产物格式。')];
  }
  return [
    textField({
      label: '接口地址（Base URL）',
      value: draft.baseUrl,
      placeholder: BASE_PLACEHOLDER[draft.kind] || '',
      mono: true,
      hint: 'OpenAI 兼容一般填到 /v1 为止；只填域名会自动补 /v1',
      onInput: (v) => { draft.baseUrl = v; },
    }),
    apiKeyField(draft),
    textField({
      label: '模型名',
      value: draft.model,
      placeholder: MODEL_PLACEHOLDER[draft.kind] || '',
      mono: true,
      onInput: (v) => { draft.model = v; },
    }),
  ];
}

function advancedFields(draft) {
  return h(
    'div',
    { class: 'field-row' },
    numberField({
      label: '单次请求超时（秒）',
      value: draft.timeoutSec,
      min: 30,
      max: 3600,
      onInput: (v) => { draft.timeoutSec = v; },
      hint: '长音频转写建议 900 以上',
    }),
    numberField({
      label: '失败重试次数',
      value: draft.maxRetries,
      min: 0,
      max: 5,
      onInput: (v) => { draft.maxRetries = v; },
    }),
  );
}

function transcribePanel() {
  const draft = getDraft('transcribe');
  const isAsrOnly = ASR_ONLY_KINDS.includes(draft.kind);
  const panel = h('div');

  panel.appendChild(kindSelectField({ draft, kinds: TRANSCRIBE_KINDS }));
  panel.appendChild(
    checkboxRow({
      label: '这是多模态大模型，可以兼任润色与纪要',
      checked: Boolean(draft.isMultimodal) && !isAsrOnly,
      disabled: isAsrOnly,
      hint: isAsrOnly
        ? '专用转写接口只能做转写：润色与纪要需要另外配置模型'
        : '勾选后，润色/纪要模型留空时会自动用它，不用再单独配置',
      onChange: (v) => { draft.isMultimodal = v; },
    }),
  );

  append(panel, connectionFields(draft));

  const languageField = draft.kind === 'dashscope-asr'
    ? textField({
        label: '语言提示（language_hints）',
        value: draft.languageHints,
        placeholder: 'zh,en',
        hint: '逗号分隔，可选 zh / en / ja / yue / ko / de / fr / ru',
        onInput: (v) => { draft.languageHints = v; },
      })
    : textField({
        label: '语言（可选）',
        value: draft.language,
        placeholder: 'zh',
        hint: '留空自动识别；填 zh / en 等可提高准确率（部分接口支持）',
        onInput: (v) => { draft.language = v; },
      });
  panel.appendChild(languageField);

  if (draft.kind !== 'mock') {
    panel.appendChild(
      field({
        label: '热词 / 上下文提示（可选）',
        control: textarea({
          placeholder: '可选：会议主题、参会人名、专有名词，帮助提升识别准确率',
          value: draft.prompt || '',
          oninput: (e) => { draft.prompt = e.target.value; },
        }),
        hint: '会作为 prompt 传给支持该参数的接口',
      }),
    );
  }

  if (draft.kind === 'multimodal-chat') {
    panel.appendChild(
      selectField({
        label: '音频传输方式',
        options: [
          { value: 'base64', label: '内联 base64（≤15MB）' },
          { value: 'oss', label: '百炼临时存储 oss://（支持大文件）' },
        ],
        value: draft.audioTransport,
        hint: '选 oss 时会把音频上传到百炼临时空间（48 小时有效），适合长录音',
        onChange: (v) => { draft.audioTransport = v; refresh(); },
      }),
    );
    if (draft.audioTransport === 'oss') {
      panel.appendChild(
        selectField({
          label: '百炼地域',
          options: [
            { value: 'cn-beijing', label: '中国内地（dashscope.aliyuncs.com）' },
            { value: 'ap-southeast-1', label: '国际站（dashscope-intl.aliyuncs.com）' },
          ],
          value: draft.dashscopeRegion,
          onChange: (v) => { draft.dashscopeRegion = v; },
        }),
      );
    }
  }

  panel.appendChild(advancedFields(draft));

  panel.appendChild(
    h(
      'div',
      { class: 'row', style: { marginTop: '6px' } },
      button('保存转写模型', { variant: 'primary', onClick: () => saveSlot('transcribe') }),
      button('测试连接', { onClick: () => testSlot('transcribe') }),
    ),
  );
  panel.appendChild(h('div', { id: 'test-result-transcribe', style: { marginTop: '12px' } }));
  if (settingsState.test.transcribe) setTimeout(() => renderTestResult('transcribe'), 0);

  return panel;
}

function polishPanel() {
  const draft = getDraft('polish');
  const panel = h('div');
  panel.appendChild(kindSelectField({ draft, kinds: CHAT_KINDS }));
  append(panel, connectionFields(draft));

  panel.appendChild(
    h(
      'div',
      { class: 'field-row' },
      numberField({
        label: '温度 (0–2)',
        value: draft.temperature,
        min: 0,
        max: 2,
        step: 0.1,
        onInput: (v) => { draft.temperature = v; },
        hint: '越低越稳定，建议 0.2–0.4',
      }),
      numberField({
        label: '每块字数',
        value: draft.chunkChars,
        min: 500,
        max: 20000,
        step: 500,
        onInput: (v) => { draft.chunkChars = v; },
        hint: '长转写稿会按这个长度分块润色',
      }),
    ),
  );

  panel.appendChild(h('div', { class: 'field' }, h('label', {}, '润色要求')));
  panel.appendChild(
    checkboxRow({
      label: '口语转书面表达',
      checked: Boolean(draft.styleFormal),
      onChange: (v) => { draft.styleFormal = v; },
    }),
  );
  panel.appendChild(
    checkboxRow({
      label: '保留专有名词、数字与时间',
      checked: Boolean(draft.styleKeepTerms),
      onChange: (v) => { draft.styleKeepTerms = v; },
    }),
  );
  panel.appendChild(
    checkboxRow({
      label: '去掉语气词与口癖',
      checked: Boolean(draft.styleRemoveFillers),
      onChange: (v) => { draft.styleRemoveFillers = v; },
    }),
  );

  if (draft.kind !== 'mock') {
    panel.appendChild(
      field({
        label: '额外要求（可选）',
        control: textarea({
          placeholder: '例如：保持第一人称；把结论加粗；不要出现“我们”',
          value: draft.systemPromptExtra || '',
          oninput: (e) => { draft.systemPromptExtra = e.target.value; },
        }),
      }),
    );
  }

  panel.appendChild(advancedFields(draft));
  panel.appendChild(
    h(
      'div',
      { class: 'row', style: { marginTop: '6px' } },
      button('保存润色模型', { variant: 'primary', onClick: () => saveSlot('polish') }),
      button('测试连接', { onClick: () => testSlot('polish') }),
    ),
  );
  panel.appendChild(h('div', { id: 'test-result-polish', style: { marginTop: '12px' } }));
  if (settingsState.test.polish) setTimeout(() => renderTestResult('polish'), 0);
  return panel;
}

function minutesPanel() {
  const draft = getDraft('minutes');
  const panel = h('div');
  panel.appendChild(kindSelectField({ draft, kinds: CHAT_KINDS }));
  append(panel, connectionFields(draft));

  panel.appendChild(
    h(
      'div',
      { class: 'field-row' },
      numberField({
        label: '温度 (0–2)',
        value: draft.temperature,
        min: 0,
        max: 2,
        step: 0.1,
        onInput: (v) => { draft.temperature = v; },
        hint: '纪要建议 0.1–0.3',
      }),
      numberField({
        label: '每块字数',
        value: draft.chunkChars,
        min: 500,
        max: 20000,
        step: 500,
        onInput: (v) => { draft.chunkChars = v; },
        hint: '超长会议会先分块提要点再汇总',
      }),
      selectField({
        label: '输出语言',
        options: [
          { value: 'zh', label: '中文' },
          { value: 'en', label: '英文' },
        ],
        value: draft.outputLanguage,
        onChange: (v) => { draft.outputLanguage = v; },
      }),
    ),
  );

  panel.appendChild(
    selectField({
      label: '纪要结构',
      options: [
        { value: 'default', label: '默认模板（信息 / 结论 / 议题 / 待办 / 风险）' },
        { value: 'custom', label: '自定义提示词' },
      ],
      value: draft.template,
      onChange: (v) => { draft.template = v; refresh(); },
    }),
  );

  if (draft.template === 'custom') {
    panel.appendChild(
      field({
        label: '自定义纪要模板',
        control: textarea({
          placeholder: '写清楚你想要的纪要结构，例如：\n## 会议结论\n## 讨论要点\n## 下一步',
          value: draft.customPrompt || '',
          oninput: (e) => { draft.customPrompt = e.target.value; },
          style: { minHeight: '140px' },
        }),
        hint: '这段内容会直接作为纪要结构要求交给模型',
      }),
    );
  }

  panel.appendChild(
    checkboxRow({
      label: '在纪要中引用时间点',
      checked: Boolean(draft.includeTimestamps),
      hint: '开启后会把时间戳一起给模型，纪要里可能出现「（约 00:12:30）」这样的引用',
      onChange: (v) => { draft.includeTimestamps = v; },
    }),
  );

  panel.appendChild(advancedFields(draft));
  panel.appendChild(
    h(
      'div',
      { class: 'row', style: { marginTop: '6px' } },
      button('保存纪要模型', { variant: 'primary', onClick: () => saveSlot('minutes') }),
      button('测试连接', { onClick: () => testSlot('minutes') }),
    ),
  );
  panel.appendChild(h('div', { id: 'test-result-minutes', style: { marginTop: '12px' } }));
  if (settingsState.test.minutes) setTimeout(() => renderTestResult('minutes'), 0);
  return panel;
}

function generalPanel() {
  const panel = h('div');
  if (!state.system) {
    panel.appendChild(loading('正在读取系统信息…'));
    return panel;
  }
  const server = state.config.server;

  const concurrency = h('input', { class: 'input', type: 'number', min: 1, max: 5, value: server.maxConcurrent, id: 'general-concurrency' });
  const portInput = h('input', { class: 'input', type: 'number', min: 1, max: 65535, value: state.system.port, id: 'general-port' });
  const autoOpen = h('input', { type: 'checkbox', checked: Boolean(server.autoOpenBrowser), id: 'general-autoopen' });

  panel.appendChild(
    h(
      'div',
      { class: 'field-row' },
      field({ label: '同时运行的任务数', control: concurrency, hint: '多选文件会按这个数量并行跑（1–5）。并行越多越快，但会同时占用多份模型额度' }),
      field({ label: '端口', control: portInput, hint: '修改后需要重启程序才生效' }),
    ),
  );
  panel.appendChild(
    field({
      label: '启动时自动打开浏览器',
      control: h('label', { class: 'check' }, autoOpen, h('span', {}, '开启')),
    }),
  );

  panel.appendChild(
    h(
      'div',
      { class: 'row', style: { marginTop: '6px' } },
      button('保存通用设置', {
        variant: 'primary',
        onClick: async () => {
          try {
            await api('/api/config', {
              method: 'PUT',
              body: {
                server: {
                  maxConcurrent: Number(concurrency.value),
                  port: Number(portInput.value),
                  autoOpenBrowser: autoOpen.checked,
                },
              },
            });
            await loadConfig();
            await loadSystem();
            toast('通用设置已保存（端口改动需重启生效）', { type: 'ok' });
            refresh();
          } catch (err) {
            toast(err.message, { type: 'err', hint: err.hint });
          }
        },
      }),
      button('一键切换模拟模型', { onClick: enableMockMode }),
    ),
  );

  panel.appendChild(h('div', { style: { height: '14px' } }));
  panel.appendChild(
    kvList([
      ['数据目录', state.system.dataDir],
      ['配置文件', state.system.configFile],
      ['当前端口', String(state.system.port)],
      ['Node', state.system.node],
      ['系统', state.system.platform],
      ['ffmpeg', state.system.ffmpeg.available ? `可用（${state.system.ffmpeg.version}）` : '未检测到'],
      ['ffmpeg 说明', state.system.ffmpeg.hint],
      ['文件夹选择', state.system.nativeDialog?.available
        ? `系统原生（${state.system.nativeDialog.label}）`
        : `内置浏览器（${state.system.nativeDialog?.reason || '原生对话框不可用'}）`],
    ]),
  );
  return panel;
}

async function viewSettings() {
  await loadConfig();
  await loadSystem();
  const root = h('div');
  root.appendChild(pageHead('设置', '三个模型都用你自己的账号；配置只保存在本机', []));

  const TABS = [
    { key: 'transcribe', label: '转写模型' },
    { key: 'polish', label: '润色模型' },
    { key: 'minutes', label: '纪要模型' },
    { key: 'general', label: '通用' },
  ];

  const tabsEl = h('div', { class: 'tabs' });
  for (const tab of TABS) {
    tabsEl.appendChild(
      h(
        'button',
        {
          class: `tab ${settingsState.tab === tab.key ? 'active' : ''}`,
          type: 'button',
          onclick: () => {
            settingsState.tab = tab.key;
            refresh();
          },
        },
        tab.label,
      ),
    );
  }
  root.appendChild(tabsEl);

  const el = h('div', { class: 'card' });
  if (settingsState.tab === 'general') {
    el.appendChild(generalPanel());
  } else if (settingsState.tab === 'transcribe') {
    el.appendChild(
      h('div', { class: 'notice' }, '转写模型可以是「专用语音转写接口」，也可以是「多模态大模型」。选后者并勾选多模态时，润色与纪要可以留空。'),
    );
    el.appendChild(transcribePanel());
  } else if (settingsState.tab === 'polish') {
    el.appendChild(polishPanel());
  } else {
    el.appendChild(minutesPanel());
  }
  root.appendChild(el);
  return root;
}

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

async function init() {
  try {
    await Promise.all([loadConfig(), loadWorkspaces()]);
  } catch (err) {
    console.error(err);
  }
  await render();
}

window.addEventListener('hashchange', () => { render(); });
init();
