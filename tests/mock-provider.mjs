/**
 * 本地假模型服务：实现 OpenAI 兼容、Gemini 原生、百炼异步转写 + OSS 上传三条协议。
 * 用于离线端到端测试，不联网、不需要密钥。
 */

import http from 'node:http';

const SAMPLE_LINES = [
  '大家好，今天开个短会，主要同步一下进度。',
  '第一块是转写工具的接入，已经跑通了。',
  '第二块是纪要模板，还需要再确认格式。',
  '下周三之前把细节发到群里。',
  '如果没有别的补充，今天就到这里。',
];

export const MOCK_POLISH = `本次会议围绕转写工具接入与纪要模板展开。\n\n转写工具已经跑通，纪要模板的格式还需要再确认一次。细节会在下周三之前同步到群里。`;

export const MOCK_MINUTES = [
  '## 会议信息',
  '- 主题：进度同步',
  '- 时间：未提及',
  '',
  '## 一句话结论',
  '转写工具已接入完成，纪要模板需要继续确认。',
  '',
  '## 核心议题与结论',
  '1. **转写工具**：已跑通，可以进入试用。',
  '2. **纪要模板**：格式待确认。',
  '',
  '## 待办事项',
  '| 事项 | 负责人 | 时间 |',
  '| --- | --- | --- |',
  '| 同步细节 | 未指定 | 下周三前 |',
  '',
  '## 风险与待确认问题',
  '- 纪要模板的最终格式尚未确定。',
].join('\n');

function timestampedTranscript() {
  const lines = [];
  let cursor = 0;
  for (const text of SAMPLE_LINES) {
    const end = cursor + 12500;
    lines.push(`[${fmt(cursor)} - ${fmt(end)}] ${text}`);
    cursor = end;
  }
  return lines.join('\n');
}

function fmt(ms) {
  const total = Math.round(ms);
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  const tenths = Math.floor((total % 1000) / 100);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${tenths}`;
}

function multipartFieldOrder(raw) {
  const names = [];
  // 只取表单字段名，不要匹配到 filename="..."
  const pattern = /(?<!file)name="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(raw.toString('latin1'))) !== null) names.push(match[1]);
  return names;
}

/** 从 multipart 里读一个文本字段（用于根据模型名模拟慢速/失败） */
function multipartFieldValue(raw, field) {
  const text = raw.toString('latin1');
  const marker = `name="${field}"`;
  const index = text.indexOf(marker);
  if (index < 0) return '';
  const after = text.slice(index + marker.length);
  const headerEnd = after.indexOf('\r\n\r\n');
  if (headerEnd < 0) return '';
  const valueStart = headerEnd + 4;
  const nextBoundary = after.indexOf('\r\n--', valueStart);
  return after.slice(valueStart, nextBoundary < 0 ? undefined : nextBoundary).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startMockProvider() {
  const stats = {
    requests: [],
    uploadFieldOrder: null,
    transcriptionFieldOrder: null,
    dashscopeHeaders: null,
    uploadedKeys: [],
    flakyFailed: 0,
  };
  let baseUrl = '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let raw = Buffer.alloc(0);
    try {
      raw = await readBody(req);
    } catch { /* ignore */ }

    stats.requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...req.headers },
      size: raw.length,
    });

    const sendJson = (status, payload, extraHeaders = {}) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
      res.end(body);
    };
    const sendEmpty = (status = 200) => {
      res.writeHead(status);
      res.end();
    };

    try {
      // ---------- OpenAI 兼容 ----------
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return sendJson(200, { object: 'list', data: [{ id: 'mock-asr' }, { id: 'mock-chat' }] });
      }

      if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
        if (!String(req.headers['content-type'] || '').includes('multipart/form-data')) {
          return sendJson(400, { error: { message: 'expected multipart/form-data' } });
        }
        stats.transcriptionFieldOrder = multipartFieldOrder(raw);
        const model = multipartFieldValue(raw, 'model');
        if (model === 'mock-slow') await sleep(3000);
        if (model === 'mock-flaky' && stats.flakyFailed === 0) {
          stats.flakyFailed += 1;
          return sendJson(503, { error: { message: 'mock provider 故意失败一次' } });
        }
        const segments = [];
        let cursor = 0;
        for (const text of SAMPLE_LINES) {
          const end = cursor + 12.5;
          segments.push({ id: segments.length, start: cursor, end, text });
          cursor = end;
        }
        return sendJson(200, {
          task: 'transcribe',
          language: 'zh',
          duration: cursor,
          text: SAMPLE_LINES.join(''),
          segments,
        });
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        let body = {};
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* ignore */ }
        const messages = body.messages || [];
        const system = messages
          .filter((m) => m.role === 'system')
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .join('\n');
        const userMessage = messages.find((m) => m.role === 'user');
        const content = userMessage?.content;
        const hasAudio = Array.isArray(content)
          && content.some((part) => part?.type === 'input_audio' || part?.type === 'audio_url');
        if (hasAudio) {
          return sendJson(200, {
            id: 'chatcmpl-audio',
            choices: [{ index: 0, message: { role: 'assistant', content: timestampedTranscript() }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
          });
        }
        const text = typeof content === 'string' ? content : '';
        let answer = '好的。';
        if (/纪要/.test(system)) answer = MOCK_MINUTES;
        else if (/润色/.test(system)) answer = MOCK_POLISH;
        return sendJson(200, {
          id: 'chatcmpl-mock',
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
          usage: { prompt_tokens: Math.ceil(text.length / 2), completion_tokens: Math.ceil(answer.length / 2), total_tokens: 0 },
        });
      }

      // ---------- Gemini ----------
      const geminiMatch = /^\/v1beta\/models\/([^/]+):generateContent$/.exec(url.pathname);
      if (req.method === 'POST' && geminiMatch) {
        if (!req.headers['x-goog-api-key']) {
          return sendJson(400, { error: { message: 'missing x-goog-api-key' } });
        }
        let body = {};
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* ignore */ }
        const parts = body.contents?.[0]?.parts || [];
        const hasAudio = parts.some((p) => p.inline_data);
        const system = body.system_instruction?.parts?.map((p) => p.text).join('\n') || '';
        let text;
        if (hasAudio) text = timestampedTranscript();
        else if (/纪要/.test(system)) text = MOCK_MINUTES;
        else if (/润色/.test(system)) text = MOCK_POLISH;
        else text = '好的。';
        return sendJson(200, {
          candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
        });
      }

      if (req.method === 'GET' && url.pathname === '/v1beta/models') {
        return sendJson(200, { models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }] });
      }

      // ---------- 百炼：上传凭证 + OSS ----------
      if (req.method === 'GET' && url.pathname === '/api/v1/uploads') {
        if (!req.headers.authorization) return sendJson(401, { message: 'missing api key' });
        if (url.searchParams.get('action') !== 'getPolicy') return sendJson(400, { message: 'bad action' });
        return sendJson(200, {
          request_id: 'req-policy',
          data: {
            policy: 'cG9saWN5',
            signature: 'sig',
            upload_dir: 'dashscope-instant/mock/2026-02-14/abc',
            upload_host: `${baseUrl}/oss-upload`,
            expire_in_seconds: '300',
            max_file_size_mb: '100',
            capacity_limit_mb: '1024',
            oss_access_key_id: 'LTAI-mock',
            x_oss_object_acl: 'private',
            x_oss_forbid_overwrite: 'true',
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/oss-upload') {
        stats.uploadFieldOrder = multipartFieldOrder(raw);
        return sendEmpty(200);
      }

      // ---------- 百炼：异步转写 ----------
      if (req.method === 'POST' && url.pathname === '/api/v1/services/audio/asr/transcription') {
        stats.dashscopeHeaders = { ...req.headers };
        let body = {};
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* ignore */ }
        stats.uploadedKeys = body.input?.file_urls || [];
        if (!stats.dashscopeHeaders['x-dashscope-ossresourceresolve']) {
          return sendJson(400, {
            code: 'invalid_parameter_error',
            message: 'The provided URL does not appear to be valid.',
          });
        }
        return sendJson(200, { output: { task_status: 'PENDING', task_id: 'mock-task-1' }, request_id: 'req-submit' });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/tasks/mock-task-1') {
        return sendJson(200, {
          request_id: 'req-poll',
          output: {
            task_id: 'mock-task-1',
            task_status: 'SUCCEEDED',
            results: [
              {
                file_url: 'oss://mock/audio.mp3',
                subtask_status: 'SUCCEEDED',
                transcription_url: `${baseUrl}/result.json`,
              },
            ],
            task_metrics: { TOTAL: 1, SUCCEEDED: 1, FAILED: 0 },
          },
        });
      }

      if (req.method === 'GET' && url.pathname === '/result.json') {
        let begin = 0;
        const sentences = SAMPLE_LINES.map((text, index) => {
          const end = begin + 12500;
          const sentence = { begin_time: begin, end_time: end, text, sentence_id: index + 1 };
          begin = end;
          return sentence;
        });
        return sendJson(200, {
          properties: {
            audio_format: 'mp3',
            channels: [0],
            original_sampling_rate: 16000,
            original_duration_in_milliseconds: begin,
          },
          transcripts: [{ channel_id: 0, text: SAMPLE_LINES.join(''), sentences }],
        });
      }

      return sendJson(404, { error: { message: `mock provider 没有实现 ${req.method} ${url.pathname}` } });
    } catch (err) {
      return sendJson(500, { error: { message: String(err?.stack || err) } });
    }
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    stats,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
