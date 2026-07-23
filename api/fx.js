// Fetches USD→JPY and USD→CNY exchange rates from a Kintone record so fee
// totals can be shown in 日元 / 人民币. Every Kintone specific is an env var, so
// the API token never reaches the browser and no account details are committed.
//
// Setup — add these to the Vercel project's Environment Variables:
//   KINTONE_BASE_URL      e.g. https://your-sub.kintone.com  (or https://your-sub.cybozu.cn)
//   KINTONE_FX_APP_ID     the app number that holds the rates
//   KINTONE_API_TOKEN     an API token for that app (view permission is enough)
//   KINTONE_FX_JPY_FIELD  field code storing the "1 USD = X JPY" number
//   KINTONE_FX_CNY_FIELD  field code storing the "1 USD = X CNY" number
//   KINTONE_FX_RECORD_ID  (optional) a fixed record id; if unset, the newest record is used
//
// Returns { configured:false } when the env vars aren't set (front-end then
// just shows USD), or { configured:true, usdJpy, usdCny } on success.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=600'); // cache 10 min at the edge

  const base     = (process.env.KINTONE_BASE_URL || '').replace(/\/+$/, '');
  const app      = process.env.KINTONE_FX_APP_ID;
  const token    = process.env.KINTONE_API_TOKEN;
  const jpyField = process.env.KINTONE_FX_JPY_FIELD;
  const cnyField = process.env.KINTONE_FX_CNY_FIELD;
  if (!base || !app || !token || !jpyField || !cnyField) {
    res.status(200).json({ configured: false });
    return;
  }

  const recordId = process.env.KINTONE_FX_RECORD_ID;
  try {
    let record;
    if (recordId) {
      const r = await fetch(`${base}/k/v1/record.json?app=${encodeURIComponent(app)}&id=${encodeURIComponent(recordId)}`,
        { headers: { 'X-Cybozu-API-Token': token } });
      if (!r.ok) throw new Error(`Kintone ${r.status}`);
      record = (await r.json()).record;
    } else {
      const q = encodeURIComponent('order by $id desc limit 1');
      const r = await fetch(`${base}/k/v1/records.json?app=${encodeURIComponent(app)}&query=${q}`,
        { headers: { 'X-Cybozu-API-Token': token } });
      if (!r.ok) throw new Error(`Kintone ${r.status}`);
      record = ((await r.json()).records || [])[0];
    }
    if (!record) throw new Error('no record found');

    const usdJpy = parseFloat(record[jpyField] && record[jpyField].value);
    const usdCny = parseFloat(record[cnyField] && record[cnyField].value);
    if (!(usdJpy > 0) || !(usdCny > 0)) throw new Error('rate fields missing or non-positive');

    res.status(200).json({ configured: true, usdJpy, usdCny });
  } catch (e) {
    console.error('[fx] ', e);
    res.status(200).json({ configured: true, error: e.message || 'fetch failed' });
  }
}
