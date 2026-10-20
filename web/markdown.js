/**
 * 安全的小型 Markdown 渲染：先转义再按行解析。
 * 支持标题、列表、引用、代码块、行内代码、粗体/斜体、分隔线、表格、http(s) 链接。
 */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text) {
  let out = escapeHtml(text);
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, body) => {
    codes.push(body);
    return `\u0000C${codes.length - 1}\u0000`;
  });
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\u0000C(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
  return out;
}

function splitTableRow(line) {
  const trimmed = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(String(line).trim());
}

export function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let listType = null;
  let inCode = false;
  let codeBuffer = [];
  let paragraph = [];

  const flushList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };
  const flushParagraph = () => {
    if (paragraph.length) {
      html += `<p>${paragraph.map((line) => inline(line)).join('<br />')}</p>`;
      paragraph = [];
    }
  };
  const flushAll = () => {
    flushList();
    flushParagraph();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (/^```/.test(line.trim())) {
      if (inCode) {
        html += `<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`;
        codeBuffer = [];
        inCode = false;
      } else {
        flushAll();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(raw);
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    // 表格
    if (/^\|/.test(line.trim()) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushAll();
      const header = splitTableRow(line);
      html += '<table><thead><tr>';
      for (const cell of header) html += `<th>${inline(cell)}</th>`;
      html += '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && /^\|/.test(lines[i].trim())) {
        const cells = splitTableRow(lines[i]);
        html += '<tr>';
        for (let c = 0; c < header.length; c += 1) html += `<td>${inline(cells[c] ?? '')}</td>`;
        html += '</tr>';
        i += 1;
      }
      html += '</tbody></table>';
      i -= 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll();
      html += '<hr />';
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushAll();
      html += `<blockquote>${inline(quote[1])}</blockquote>`;
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (listType !== 'ul') {
        flushList();
        html += '<ul>';
        listType = 'ul';
      }
      html += `<li>${inline(bullet[1])}</li>`;
      continue;
    }

    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (listType !== 'ol') {
        flushList();
        html += '<ol>';
        listType = 'ol';
      }
      html += `<li>${inline(ordered[2])}</li>`;
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (inCode) html += `<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`;
  flushAll();
  return html || '<p class="muted">（空文档）</p>';
}
