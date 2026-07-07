// Proxy to the Anthropic Messages API. The frontend already speaks the
// Anthropic wire format (messages / image blocks / max_tokens), so this is a
// thin passthrough: inject the API key, pin the model, attach the web search
// and web fetch server tools when a route lookup needs live data, and reduce
// the response to the single text blob the frontend reads.
// Fixed per-task models — accuracy-sensitive lookups pay for Opus, mechanical
// extraction runs on cheap models. The frontend names the task; anything
// unrecognized falls back to the lookup model. Never trust a client-sent
// model string.
const TASK_MODELS = {
  lookup: 'claude-sonnet-5',   // airline-rule lookup with web search — CX fees are code-overridden, so near-Opus quality at 40% less is enough; bump back to claude-opus-4-8 if non-CX numbers drift
  parse:  'claude-haiku-4-5',  // pasted text/Excel → JSON, pure formatting
  ocr:    'claude-sonnet-5',   // screenshot table extraction — needs solid vision
};
const MAX_CONTINUATIONS = 3; // pause_turn resumes for long server-tool loops

const SYSTEM = 'You are a baggage-policy lookup assistant. When asked for data, ' +
  'output ONLY valid JSON with no markdown fences, no comments, no trailing ' +
  'commas, no single quotes. All keys and string values must use double quotes.';

function stripFences(text) {
  return text.trim()
    .replace(/^```(?:json|JSON)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, anthropic-version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(404).json({ error: { message: 'Not Found' } });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'API Key 未配置，请在 Vercel 项目的 Environment Variables 里设置 ANTHROPIC_API_KEY' } });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ error: { message: '请求体解析失败: ' + e.message } });
    return;
  }

  const model = TASK_MODELS[body.task] || TASK_MODELS.lookup;
  const anthropicReq = {
    model,
    max_tokens: body.max_tokens || 4000,
    system: SYSTEM,
    messages: body.messages || [],
  };
  if (body.needsSearch) {
    // Cost controls: searches bill $10/1K, and every fetched page re-enters
    // the context on each server-tool iteration — cap both hard.
    anthropicReq.tools = [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 2 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2, max_content_tokens: 10000 },
    ];
  }

  try {
    let data;
    // Server tools run in a server-side loop that can pause (stop_reason
    // "pause_turn"); resending the conversation resumes it where it left off.
    for (let attempt = 0; ; attempt++) {
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(anthropicReq),
      });
      data = await apiRes.json();

      if (!apiRes.ok) {
        const msg = data.error?.message || `HTTP ${apiRes.status}`;
        console.error('[Claude ERROR]', apiRes.status, msg);
        res.status(apiRes.status).json({ error: { message: msg } });
        return;
      }

      if (data.stop_reason === 'pause_turn' && attempt < MAX_CONTINUATIONS) {
        console.log('[Claude] pause_turn, resuming server-tool loop, attempt', attempt + 1);
        anthropicReq.messages = [
          ...anthropicReq.messages,
          { role: 'assistant', content: data.content },
        ];
        continue;
      }
      break;
    }

    console.log(`[Claude] model=${model} stop_reason=${data.stop_reason}`);
    if (data.stop_reason === 'refusal') {
      res.status(502).json({ error: { message: 'AI 拒绝了此请求（安全策略），请修改内容后重试' } });
      return;
    }

    // With server tools the content array interleaves server_tool_use /
    // tool_result blocks with text — join every text block, never read [0].
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    if (!text) {
      console.error('[Claude] empty text, stop_reason=' + data.stop_reason, JSON.stringify(data).slice(0, 500));
      res.status(502).json({ error: { message: `AI 返回空内容（stop_reason=${data.stop_reason || '无'}），请重试` } });
      return;
    }

    console.log('[Claude text 前200字]', text.slice(0, 200));
    res.status(200).json({ content: [{ type: 'text', text: stripFences(text) }] });
  } catch (e) {
    console.error('[异常]', e);
    res.status(502).json({ error: { message: e.message } });
  }
}
