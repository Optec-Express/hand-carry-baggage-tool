const GEMINI_MODEL = 'gemini-2.5-flash';

function toGemini(body) {
  const messages = body.messages || [];
  const needsSearch = !!body.needsSearch;

  const contents = messages.map(msg => {
    const role = msg.role === 'user' ? 'user' : 'model';
    const raw = msg.content;
    let parts;

    if (typeof raw === 'string') {
      parts = [{ text: raw }];
    } else if (Array.isArray(raw)) {
      parts = [];
      for (const item of raw) {
        if (item.type === 'text') {
          parts.push({ text: item.text });
        } else if (item.type === 'image') {
          const src = item.source || {};
          if (src.type === 'base64') {
            parts.push({
              inlineData: {
                mimeType: src.media_type || 'image/jpeg',
                data: src.data || ''
              }
            });
          }
        }
      }
    } else {
      parts = [{ text: String(raw) }];
    }

    return { role, parts };
  });

  const generationConfig = {
    maxOutputTokens: body.max_tokens || 8192,
    temperature: 0.1,
    // gemini-2.5-flash 的内部思考 token 也计入 maxOutputTokens，
    // 不关掉会把额度吃光导致 JSON 输出被 MAX_TOKENS 截断
    thinkingConfig: { thinkingBudget: 0 },
  };
  // Grounding (Google Search) can't be combined with forced JSON mime type —
  // rely on the system instruction + stripFences() to extract JSON instead.
  if (!needsSearch) generationConfig.responseMimeType = 'application/json';

  const req = {
    contents,
    generationConfig,
    systemInstruction: {
      parts: [{
        text: 'Output ONLY valid JSON with no markdown fences, no comments, ' +
              'no trailing commas, no single quotes. ' +
              'All keys and string values must use double quotes.'
      }]
    }
  };
  // url_context lets the model fetch specific official pages named in the
  // prompt (e.g. the CX excess-baggage fee page) instead of relying on
  // search snippets or memory.
  if (needsSearch) req.tools = [{ google_search: {} }, { url_context: {} }];
  return req;
}

function stripFences(text) {
  return text.trim()
    .replace(/^```(?:json|JSON)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

function fromGemini(data) {
  if (data.error) {
    const msg = data.error.message || 'Gemini API 错误';
    console.error('[Gemini ERROR]', data.error.code, msg);
    return { body: { error: { message: msg } }, status: 502 };
  }

  let text = '';
  try {
    const candidate = data.candidates[0];
    const reason = candidate.finishReason || '';
    console.log('[Gemini] finishReason=' + reason);
    if (reason === 'SAFETY') {
      text = '[内容被安全过滤器拦截，请修改描述后重试]';
    } else if (reason === 'MAX_TOKENS') {
      const raw = candidate.content.parts[0].text;
      console.warn(`[WARN] 响应被截断（MAX_TOKENS），已收到 ${raw.length} 字符`);
      text = stripFences(raw);
    } else {
      text = stripFences(candidate.content.parts[0].text);
    }
  } catch (e) {
    text = '响应解析失败: ' + e.message;
  }

  console.log('[Gemini text 前200字]', text.slice(0, 200));
  return { body: { content: [{ type: 'text', text }] }, status: 200 };
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'API Key 未配置，请在 Vercel 项目的 Environment Variables 里设置 GEMINI_API_KEY' } });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ error: { message: '请求体解析失败: ' + e.message } });
    return;
  }

  let geminiReq;
  try {
    geminiReq = toGemini(body);
  } catch (e) {
    res.status(400).json({ error: { message: '请求转换失败: ' + e.message } });
    return;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  try {
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiReq)
    });
    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      const msg = data.error?.message || `HTTP ${geminiRes.status}`;
      res.status(502).json({ error: { message: msg } });
      return;
    }

    const { body: outBody, status } = fromGemini(data);
    res.status(status).json(outBody);
  } catch (e) {
    console.error('[异常]', e);
    res.status(502).json({ error: { message: e.message } });
  }
}
