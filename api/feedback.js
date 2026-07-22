// Receives user feedback from the tool and posts it to a Slack channel via an
// Incoming Webhook. The webhook URL (which encodes the target channel) is kept
// server-side in an env var so it's never exposed to the browser.
//
// Setup: create a Slack Incoming Webhook for the desired channel
// (https://api.slack.com/messaging/webhooks) and add its URL to the Vercel
// project's Environment Variables as SLACK_FEEDBACK_WEBHOOK.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(404).json({ error: { message: 'Not Found' } }); return; }

  const webhook = process.env.SLACK_FEEDBACK_WEBHOOK;
  if (!webhook) {
    res.status(500).json({ error: { message: '反馈通道未配置，请在 Vercel 环境变量里设置 SLACK_FEEDBACK_WEBHOOK' } });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ error: { message: '请求体解析失败' } });
    return;
  }

  const message = (body.message || '').toString().trim().slice(0, 3500);
  if (!message) { res.status(400).json({ error: { message: '反馈内容不能为空' } }); return; }
  const contact = (body.contact || '').toString().trim().slice(0, 200);
  const context = (body.context || '').toString().trim().slice(0, 400);

  // Block Kit message: a header, then a clearly-labelled 提出人 / 内容 body.
  const submitter = contact || '未填写';
  const bodyText = [`*提出人：*　${submitter}`, `*内容：*　${message}`].join('\n');
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📣 手提行李工具 · 用户反馈', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: bodyText } },
  ];
  // `text` is the notification fallback; blocks render the rich message.
  const payload = { text: `用户反馈（${submitter}）：${message.slice(0, 120)}`, blocks };

  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[Slack ERROR]', r.status, t);
      res.status(502).json({ error: { message: '投递到 Slack 失败，请稍后重试' } });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[feedback 异常]', e);
    res.status(502).json({ error: { message: e.message || '网络错误' } });
  }
}
