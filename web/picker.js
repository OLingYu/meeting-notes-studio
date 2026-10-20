/**
 * 选择文件夹。
 * 默认走系统原生方案（后端弹出系统对话框）；原生不可用/出错时自动回退到内置目录浏览器。
 */

import { h, clear, button, openModal, toast } from './ui.js';

const TOKEN = window.__APP_TOKEN__;
const NATIVE_FALLBACK_CODES = new Set([
  'NATIVE_DIALOG_UNAVAILABLE',
  'NATIVE_DIALOG_FAILED',
  'SPAWN_FAILED',
  'DIALOG_TIMEOUT',
]);

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
    throw err;
  }
  return data;
}

/** 弹出系统原生文件夹选择窗口；返回选中的路径或 null（取消） */
export async function pickDirectoryNative({ title = '选择文件夹', initialPath = '' } = {}) {
  const data = await api('/api/fs/pick-directory', {
    method: 'POST',
    body: { title, initialPath },
  });
  return data.canceled ? null : data.path;
}

/**
 * 统一入口：优先系统原生对话框，失败时回退内置浏览器。
 * @returns {Promise<string|null>} 选中的绝对路径；取消返回 null
 */
export async function pickDirectory({ title = '选择文件夹', initialPath = '', confirmText = '选择这个文件夹' } = {}) {
  try {
    toast('已打开系统文件夹选择窗口', {
      hint: '如果没看到窗口，请看一下任务栏；选好后会自动回到这里',
      timeout: 5000,
    });
    return await pickDirectoryNative({ title, initialPath });
  } catch (err) {
    if (err.code === 'DIALOG_BUSY') {
      toast(err.message, { type: 'warn', hint: err.hint });
      return null;
    }
    if (err.code === 'ABORTED') return null;
    if (NATIVE_FALLBACK_CODES.has(err.code)) {
      toast('系统文件夹对话框不可用，已切换到内置目录浏览器', {
        type: 'warn',
        hint: err.message,
        timeout: 6000,
      });
      return browseDirectory({ title, initialPath, confirmText });
    }
    toast(err.message, { type: 'err', hint: err.hint });
    return null;
  }
}

/** 内置目录浏览器（备用方案，也是原生对话框不可用时的兜底） */
export function browseDirectory({ title = '选择文件夹', initialPath = '', confirmText = '选择这个文件夹' } = {}) {
  return new Promise((resolve) => {
    let current = initialPath || '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const driveSelect = h('select', { class: 'select', style: { width: '120px', flex: '0 0 auto' } });
    const pathInput = h('input', { class: 'input mono', readonly: true, value: current, style: { flex: '1' } });
    const upBtn = button('上一级', { size: 'sm' });
    const listEl = h('div', { class: 'dir-list' });
    const hintEl = h('div', { class: 'hint', style: { marginTop: '6px' } });

    const body = h(
      'div',
      {},
      h('div', { class: 'row', style: { marginBottom: '10px' } }, driveSelect, pathInput, upBtn),
      listEl,
      hintEl,
    );

    const modal = openModal({
      title,
      body,
      width: 720,
      actions: [
        { label: '新建文件夹', onClick: () => onCreateFolder() },
        { label: '取消', onClick: (close) => { finish(null); close(); } },
        {
          label: confirmText,
          variant: 'primary',
          onClick: (close) => {
            if (!current) return;
            finish(current);
            close();
          },
        },
      ],
      onClose: () => finish(null),
    });

    async function loadDrives() {
      try {
        const data = await api('/api/fs/drives');
        clear(driveSelect);
        for (const drive of data.drives) {
          driveSelect.appendChild(h('option', { value: drive.path }, drive.name));
        }
        if (data.home) {
          driveSelect.appendChild(h('option', { value: data.home }, `家目录 (${data.home})`));
        }
        if (!current) {
          driveSelect.value = data.drives[0]?.path || '';
        }
      } catch (err) {
        hintEl.textContent = `读取盘符失败：${err.message}`;
      }
    }

    async function loadPath(target) {
      try {
        hintEl.textContent = '读取中…';
        const query = target ? `?path=${encodeURIComponent(target)}&dirOnly=1` : '';
        const data = await api(`/api/fs/list${query}`);
        current = data.path || '';
        pathInput.value = current;
        upBtn.disabled = !data.parent;
        clear(listEl);
        const items = data.dirs || [];
        if (!items.length) {
          listEl.appendChild(h('div', { style: { padding: '16px', color: 'var(--muted)', fontSize: '12.5px' } }, '这个位置没有子文件夹'));
        }
        for (const dir of items) {
          listEl.appendChild(
            h(
              'div',
              { class: 'dir-item', onclick: () => loadPath(dir.path) },
              h('span', { style: { color: '#8a94a6' } }, '📁'),
              h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis' } }, dir.name),
            ),
          );
        }
        hintEl.textContent = current ? `当前：${current}` : '请选择一个盘符';
        if (data.parent !== undefined) upBtn.onclick = () => loadPath(data.parent || '');
      } catch (err) {
        hintEl.textContent = err.message;
        toast(err.message, { type: 'err', hint: err.hint });
      }
    }

    async function onCreateFolder() {
      if (!current) {
        toast('先进入一个文件夹再新建子文件夹', { type: 'err' });
        return;
      }
      const nameInput = h('input', { class: 'input', placeholder: '文件夹名称', autofocus: true });
      const folderModal = openModal({
        title: '新建文件夹',
        body: h('div', {}, h('div', { class: 'hint', style: { marginBottom: '8px' } }, `将在 ${current} 下创建`), nameInput),
        width: 480,
        actions: [
          { label: '取消', onClick: (close) => close() },
          {
            label: '创建',
            variant: 'primary',
            onClick: async (close) => {
              const name = nameInput.value.trim();
              if (!name) return;
              try {
                const created = await api('/api/fs/mkdir', { method: 'POST', body: { path: current, name } });
                close();
                folderModal.close();
                await loadPath(created.path);
              } catch (err) {
                toast(err.message, { type: 'err', hint: err.hint });
              }
            },
          },
        ],
      });
      setTimeout(() => nameInput.focus(), 50);
    }

    driveSelect.addEventListener('change', () => loadPath(driveSelect.value));
    upBtn.onclick = () => loadPath('');

    (async () => {
      await loadDrives();
      await loadPath(current);
    })();
  });
}
