/** 三套中文提示词。输出格式约束写得比较硬，减少模型发挥空间。 */

function styleLines(cfg) {
  const lines = [];
  if (cfg.styleFormal) lines.push('- 把口语整理成通顺的书面表达，但不要改变原意');
  else lines.push('- 保持口语风格，只修正明显的错别字与断句');
  if (cfg.styleKeepTerms) lines.push('- 专有名词、产品名、人名、数字、金额、时间必须原样保留');
  if (cfg.styleRemoveFillers) lines.push('- 去掉“嗯、啊、那个、就是说”等语气词与重复口癖');
  lines.push('- 不要新增原文没有的信息，不要做总结，不要加标题层级之外的结构');
  return lines.join('\n');
}

export function transcribeInstruction(cfg) {
  return [
    '请把这段会议录音逐行转写成文字，并标注时间段。要求：',
    '1. 每一行都必须使用这个格式：[00:00:05.3 - 00:00:11.8] 这段时间里说的话',
    '2. 时间格式固定为「时:分:秒.十分之一秒」，两位补零；时间点按音频实际位置标注，尽量贴近',
    '3. 只输出转写内容本身：不要开场白、不要总结、不要翻译、不要解释、不要输出列表符号',
    '4. 听不清的内容写 [听不清]，不确定的专有名词可以写 [疑似:xxx]，绝不编造',
    '5. 保留说话人的原始表达，不要润色、不要合并相邻句子',
    cfg.language && cfg.language !== 'auto' ? `6. 音频主要语言是 ${cfg.language}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function polishSystem(cfg) {
  return [
    '你是一位专业的中文会议记录编辑，任务是润色语音转写稿。',
    '',
    '要求：',
    styleLines(cfg),
    '- 保持原文段落顺序与信息完整，一段原文对应一段结果',
    '- 直接输出润色后的正文，不要写“以下是润色结果”之类的说明',
    '- 如果输入开头与上一段结尾内容重复（分块重叠导致），请忽略重复部分，不要重复输出',
    cfg.systemPromptExtra ? `\n补充要求：\n${cfg.systemPromptExtra}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function polishUser({ text, index, total, prevTail }) {
  const parts = [];
  if (total > 1) parts.push(`这是整篇转写稿的第 ${index + 1}/${total} 段，请只润色这一段。`);
  if (prevTail) parts.push(`上一段结尾（仅供衔接，不要重复输出）：「${prevTail}」`);
  parts.push('【原文开始】', text, '【原文结束】');
  parts.push('请直接输出润色后的这一段正文。');
  return parts.join('\n');
}

const DEFAULT_MINUTES_TEMPLATE = `## 会议信息
- 主题 / 时间 / 参会方（音频里没有的就写“未提及”）

## 一句话结论
用一句话说明这次会议最重要的结论。

## 核心议题与结论
按议题分条，每条写清楚「讨论了什么 → 结论是什么」，有分歧要写出来。

## 待办事项
用表格列出：事项 | 负责人 | 时间。负责人或时间未提及时写“未指定”。

## 风险与待确认问题
列出未解决的问题、依赖项、需要拍板的事项。没有就写“暂无”。

## 附录
可选：关键时间点、数据、名词解释。没有就整节省略。`;

export function minutesSystem(cfg) {
  const template = cfg.template === 'custom' && cfg.customPrompt.trim()
    ? cfg.customPrompt.trim()
    : DEFAULT_MINUTES_TEMPLATE;
  return [
    '你是一位资深会议纪要撰写者，负责把会议内容整理成可直接发给团队的中文会议纪要。',
    '',
    '要求：',
    '- 只依据输入内容撰写，不要编造参会人、数据与结论',
    '- 语言精炼、结论前置，避免流水账式复述',
    `- 输出语言：${cfg.outputLanguage === 'en' ? '英文' : '中文'}`,
    '- 用 Markdown 输出，不要写多余的解释性开头结尾',
    '',
    '纪要结构必须严格按下面的模板：',
    template,
  ].join('\n');
}

export function minutesNotesSystem(cfg) {
  return [
    '你是会议内容分析助手。请从给定的一段会议记录里提取结构化要点，供后续汇总成正式会议纪要。',
    '',
    '输出要求：',
    '- 用 Markdown 无序列表，每条一行，以「-」开头',
    '- 每条要点尽量带上关键数字、时间、人名、负责人',
    '- 分为三小类并加小标题：### 事实与结论 / ### 待办与承诺 / ### 风险与疑问',
    '- 不要润色文风，不要写总结段，不要遗漏该段里的待办事项',
    cfg.includeTimestamps ? '- 如果原文行首有时间标记，请在相关条目后面用（约 00:12:30）这样的格式标注时间点' : '',
    `- 输出语言：${cfg.outputLanguage === 'en' ? '英文' : '中文'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function minutesNotesUser({ text, index, total }) {
  return [
    total > 1 ? `这是会议记录的第 ${index + 1}/${total} 段。` : '这是完整的会议记录。',
    '【原文开始】',
    text,
    '【原文结束】',
    '请输出这一段的结构化要点。',
  ].join('\n');
}

export function minutesFinalUser({ notes, sourceLabel, segmentCount }) {
  const parts = [];
  parts.push(`以下是本次会议${segmentCount ? `（共 ${segmentCount} 个时间段的转写）` : ''}的全部要点，来源：${sourceLabel}。`);
  if (notes) {
    parts.push('【要点开始】', notes, '【要点结束】');
    parts.push('请把这些要点整理成一份完整、去重、有逻辑的会议纪要，严格按系统提示里的结构输出。');
  } else {
    parts.push('请直接根据这些要点生成会议纪要。');
  }
  return parts.join('\n');
}
