const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

function toGroq(body) {
  const messages = body.messages || [];

  const groqMessages = messages.map(msg => {
    const role = msg.role === 'user' ? 'user' : 'assistant';
    const raw = msg.content;
    let content;

    if (typeof raw === 'string') {
      content = raw;
    } else if (Array.isArray(raw)) {
      content = [];
      for (const item of raw) {
        if (item.type === 'text') {
          content.push({ type: 'text', text: item.text });
        } else if (item.type === 'image') {
          const src = item.source || {};
          if (src.type === 'base64') {
            const mediaType = src.media_type || 'image/jpeg';
            content.push({
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${src.data || ''}` }
            });
          }
        }
      }
    } else {
      content = String(raw);
    }

    return { role, content };
  });

  groqMessages.unshift({
    role: 'system',
    content: 'Output ONLY valid JSON with no markdown fences, no comments, ' +
             'no trailing commas, no single quotes. ' +
             'All keys and string values must use double quotes.'
  });

  return {
    model: GROQ_MODEL,
    messages: groqMessages,
    max_tokens: body.max_tokens || 8192,
    temperature: 0.1,
    response_format: { type: 'json_object' }
  };
}

function stripFences(text) {
  return text.trim()
    .replace(/^```(?:json|JSON)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

function fromGroq(data) {
  if (data.error) {
    const msg = data.error.message || 'Groq API 错误';
    console.error('[Groq ERROR]', data.error.code, msg);
    return { body: { error: { message: msg } }, status: 502 };
  }

  let text = '';
  try {
    const choice = data.choices[0];
    const reason = choice.finish_reason || '';
    console.log('[Groq] finish_reason=' + reason);
    const raw = choice.message.content;
    if (reason === 'length') {
      console.warn(`[WARN] 响应被截断（length），已收到 ${raw.length} 字符`);
    }
    text = stripFences(raw);
  } catch (e) {
    text = '响应解析失败: ' + e.message;
  }

  console.log('[Groq text 前200字]', text.slice(0, 200));
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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'API Key 未配置，请在 Vercel 项目的 Environment Variables 里设置 GROQ_API_KEY' } });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ error: { message: '请求体解析失败: ' + e.message } });
    return;
  }

  let groqReq;
  try {
    groqReq = toGroq(body);
  } catch (e) {
    res.status(400).json({ error: { message: '请求转换失败: ' + e.message } });
    return;
  }

  try {
    const groqRes = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(groqReq)
    });
    const data = await groqRes.json();

    if (!groqRes.ok) {
      const msg = data.error?.message || `HTTP ${groqRes.status}`;
      res.status(502).json({ error: { message: msg } });
      return;
    }

    const { body: outBody, status } = fromGroq(data);
    res.status(status).json(outBody);
  } catch (e) {
    console.error('[异常]', e);
    res.status(502).json({ error: { message: e.message } });
  }
}
