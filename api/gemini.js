// Vercel serverless proxy for Gemini API.
// Keys are read from environment variables (set in Vercel dashboard)
// so they never reach the browser. Rotates across multiple keys on
// 429/503 to spread quota.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0;
  const maxOutputTokens = typeof body.maxOutputTokens === 'number' ? body.maxOutputTokens : 4096;
  const model = typeof body.model === 'string' ? body.model : 'gemini-2.5-flash';

  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  const keys = [
    process.env.GEMINI_KEY_1,
    process.env.GEMINI_KEY_2,
    process.env.GEMINI_KEY_3,
  ].filter(Boolean);

  if (!keys.length) {
    return res.status(500).json({ error: 'Server misconfigured: no GEMINI_KEY_* env vars set' });
  }

  const reqBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens },
  });

  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let resp;
    try {
      resp = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reqBody }
      );
    } catch (e) {
      lastError = 'fetch failed: ' + (e && e.message);
      continue;
    }

    if (resp.status === 429 || resp.status === 503) {
      lastError = 'Gemini ' + resp.status + ' (quota/busy)';
      continue;
    }

    if (!resp.ok) {
      let errMsg = resp.statusText;
      try {
        const eb = await resp.json();
        errMsg = (eb && eb.error && eb.error.message) || errMsg;
      } catch (_) {}
      // 403 (leaked key) — skip this key and try next instead of failing immediately
      if (resp.status === 403) {
        lastError = 'Gemini 403: ' + errMsg;
        continue;
      }
      return res.status(resp.status).json({ error: 'Gemini ' + resp.status + ': ' + errMsg });
    }

    const data = await resp.json();
    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const textPart = parts.find((p) => !p.thought && p.text) || parts[parts.length - 1] || {};
    const text = (textPart.text || '').trim();
    if (text) return res.status(200).json({ text });
    lastError = 'empty response';
  }

  return res.status(503).json({ error: lastError || 'All keys exhausted' });
}
