// Fetches USD→JPY and USD→CNY exchange rates from the Kintone「為替レートマスタ」
// app so fee totals can be shown in 日元 / 人民币. Every Kintone specific is an
// env var, so the API token never reaches the browser and no account details
// are committed.
//
// Rate-selection rule (matches finance's convention): use the record for the
// CURRENT month (年月 = YYYYMM); if this month hasn't been added yet, fall back
// to the most recent earlier month. Implemented as "年月 ≤ 本月, newest first".
//
// Setup — add these to the Vercel project's Environment Variables:
//   KINTONE_BASE_URL      e.g. https://your-sub.kintone.com  (or https://your-sub.cybozu.cn)
//   KINTONE_FX_APP_ID     the「為替レートマスタ」app number (from its URL: /k/<id>/)
//   KINTONE_API_TOKEN     an API token for that app (view permission is enough)
//   KINTONE_FX_JPY_FIELD  field code of the USD-JPY column (e.g. 1 USD = 160.52 JPY)
//   KINTONE_FX_CNY_FIELD  field code of the USD-CNY column (e.g. 1 USD = 6.8067 CNY)
//   KINTONE_FX_MONTH_FIELD field code of the 年月(YYYYMM) number column, used to pick the month
//   KINTONE_FX_RECORD_ID  (optional) pin one fixed record id; overrides the month rule
//
// Returns { configured:false } when the env vars aren't set (front-end then
// just shows USD), or { configured:true, usdJpy, usdCny, month } on success.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=600'); // cache 10 min at the edge

  const base       = (process.env.KINTONE_BASE_URL || '').replace(/\/+$/, '');
  const app        = process.env.KINTONE_FX_APP_ID;
  const token      = process.env.KINTONE_API_TOKEN;
  const jpyField   = process.env.KINTONE_FX_JPY_FIELD;
  const cnyField   = process.env.KINTONE_FX_CNY_FIELD;
  const monthField = process.env.KINTONE_FX_MONTH_FIELD;
  if (!base || !app || !token || !jpyField || !cnyField) {
    res.status(200).json({ configured: false });
    return;
  }

  const recordId = process.env.KINTONE_FX_RECORD_ID;
  const authHdr = { 'X-Cybozu-API-Token': token };
  try {
    let record;
    if (recordId) {
      // Pinned record wins if explicitly set.
      const r = await fetch(`${base}/k/v1/record.json?app=${encodeURIComponent(app)}&id=${encodeURIComponent(recordId)}`, { headers: authHdr });
      if (!r.ok) throw new Error(`Kintone ${r.status}`);
      record = (await r.json()).record;
    } else if (monthField) {
      // Current month in UTC+8 (East Asia), formatted YYYYMM, then pick the
      // newest record whose 年月 ≤ this month (so a not-yet-updated month falls
      // back to the previous one automatically).
      const nowEA = new Date(Date.now() + 8 * 3600 * 1000);
      const ym = nowEA.getUTCFullYear() * 100 + (nowEA.getUTCMonth() + 1);
      const q = encodeURIComponent(`${monthField} <= ${ym} order by ${monthField} desc limit 1`);
      const r = await fetch(`${base}/k/v1/records.json?app=${encodeURIComponent(app)}&query=${q}`, { headers: authHdr });
      if (!r.ok) throw new Error(`Kintone ${r.status}`);
      record = ((await r.json()).records || [])[0];
    } else {
      // No month field configured → just take the newest record by id.
      const q = encodeURIComponent('order by $id desc limit 1');
      const r = await fetch(`${base}/k/v1/records.json?app=${encodeURIComponent(app)}&query=${q}`, { headers: authHdr });
      if (!r.ok) throw new Error(`Kintone ${r.status}`);
      record = ((await r.json()).records || [])[0];
    }
    if (!record) throw new Error('no matching rate record');

    const usdJpy = parseFloat(record[jpyField] && record[jpyField].value);
    const usdCny = parseFloat(record[cnyField] && record[cnyField].value);
    if (!(usdJpy > 0) || !(usdCny > 0)) throw new Error('rate fields missing or non-positive');
    const month = monthField && record[monthField] ? record[monthField].value : null;

    res.status(200).json({ configured: true, usdJpy, usdCny, month });
  } catch (e) {
    console.error('[fx] ', e);
    res.status(200).json({ configured: true, error: e.message || 'fetch failed' });
  }
}
