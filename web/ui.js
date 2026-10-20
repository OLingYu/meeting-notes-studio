/** 极简 UI 工具：元素构造、Toast、模态框、格式化。无任何第三方依赖。 */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'html') el.innerHTML = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') {
      el.value = String(value);
    } else if (key === 'checked') {
      el.checked = Boolean(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function button(label, { variant = '', size = '', onClick, disabled = false, title = '' } = {}) {
  return h(
    'button',
    {
      class: ['btn', variant, size].filter(Boolean).join(' '),
      type: 'button',
      disabled,
      title,
      onclick: onClick,
    },
    label,
  );
}

export function badge(text, tone = '') {
  return h('span', { class: `badge ${tone}`.trim() }, text);
}

export function field({ label, control, hint, inline = false }) {
  const wrapper = h('div', { class: 'field' });
  if (label) wrapper.appendChild(h('label', {}, label));
  wrapper.appendChild(control);
  if (hint) wrapper.appendChild(h('div', { class: 'hint' }, hint));
  if (inline) wrapper.style.marginBottom = '8px';
  return wrapper;
}

export function textInput(props = {}) {
  return h('input', { class: 'input', type: 'text', ...props });
}

export function textarea(props = {}) {
  return h('textarea', { class: 'textarea', ...props });
}

export function select(options, value, props = {}) {
  const el = h('select', { class: 'select', ...props });
  for (const option of options) {
    el.appendChild(
      h('option', { value: option.value, selected: option.value === value }, option.label),
    );
  }
  el.value = value ?? '';
  return el;
}

export function checkbox({ label, checked = false, onChange, hint }) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onChange?.(e.target.checked) });
  const labelEl = h('label', { class: 'check' }, input, h('span', {}, label));
  if (!hint) return labelEl;
  return h('div', {}, labelEl, h('div', { class: 'hint', style: { marginLeft: '24px' } }, hint));
}

export function loading(text = '加载中…') {
  return h('div', { class: 'loading' }, h('div', { class: 'spinner' }), text);
}

export function emptyState({ title, desc, action }) {
  return h(
    'div',
    { class: 'empty' },
    h('h3', {}, title),
    desc ? h('p', {}, desc) : null,
    action || null,
  );
}

export function kvList(rows) {
  const dl = h('dl', { class: 'kv' });
  for (const [key, value] of rows) {
    if (value === null || value === undefined || value === '') continue;
    dl.appendChild(h('dt', {}, key));
    dl.appendChild(h('dd', {}, value instanceof Node ? value : String(value)));
  }
  return dl;
}

export function toast(message, { type = 'info', hint = '', timeout = 4200 } = {}) {
  const root = document.getElementById('toast-root');
  const el = h(
    'div',
    { class: `toast ${type}` },
    h('div', {}, message),
    hint ? h('div', { class: 'toast-hint' }, hint) : null,
  );
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, timeout);
}

export function openModal({ title, body, actions = [], width = 760, onClose }) {
  const root = document.getElementById('modal-root');
  const mask = h('div', { class: 'modal-mask' });
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    mask.remove();
    try { onClose?.(); } catch { /* ignore */ }
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  const modal = h(
    'div',
    { class: 'modal', style: width ? { width: typeof width === 'number' ? `${width}px` : width } : {} },
    h('div', { class: 'modal-head' }, title || ''),
    h('div', { class: 'modal-body' }, body || ''),
  );

  if (actions.length) {
    const foot = h('div', { class: 'modal-foot' });
    for (const action of actions) {
      foot.appendChild(
        button(action.label, {
          variant: action.variant || '',
          disabled: action.disabled,
          onClick: () => action.onClick?.(close, modal),
        }),
      );
    }
    modal.appendChild(foot);
  }

  mask.appendChild(modal);
  mask.addEventListener('mousedown', (event) => {
    if (event.target === mask) close();
  });
  document.addEventListener('keydown', onKey);
  root.appendChild(mask);

  return { close, el: modal, body: modal.querySelector('.modal-body') };
}

export function confirmDialog({ title = '确认', message, okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let decided = false;
    const modal = openModal({
      title,
      body: h('div', { style: { fontSize: '13.5px', lineHeight: '1.7', whiteSpace: 'pre-wrap' } }, message),
      width: 460,
      actions: [
        { label: cancelText, onClick: (close) => { decided = true; close(); resolve(false); } },
        {
          label: okText,
          variant: danger ? 'danger' : 'primary',
          onClick: (close) => { decided = true; close(); resolve(true); },
        },
      ],
      onClose: () => {
        if (!decided) resolve(false);
      },
    });
    return modal;
  });
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDurationText(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (!total) return '';
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const seconds = Math.round((total % 60000) / 1000);
  const parts = [];
  if (hours) parts.push(`${hours} 小时`);
  if (minutes) parts.push(`${minutes} 分`);
  if (seconds && !hours) parts.push(`${seconds} 秒`);
  return parts.join(' ') || '不到 1 秒';
}

export const STEP_LABELS = { transcribe: '转写', polish: '润色', minutes: '纪要' };

export function statusMeta(status) {
  switch (status) {
    case 'queued': return { label: '排队中', tone: 'info' };
    case 'running': return { label: '进行中', tone: 'info' };
    case 'succeeded': return { label: '已完成', tone: 'ok' };
    case 'failed': return { label: '失败', tone: 'err' };
    case 'canceled': return { label: '已取消', tone: 'warn' };
    case 'interrupted': return { label: '已中断', tone: 'warn' };
    default: return { label: status || '未知', tone: '' };
  }
}

export function isTerminal(status) {
  return ['succeeded', 'failed', 'canceled', 'interrupted'].includes(status);
}
