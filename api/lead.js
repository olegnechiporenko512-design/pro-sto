/**
 * Vercel Serverless Function — проксі між лендингом і Google Apps Script.
 * Реальна adres .../exec лежить у змінній оточення GS_URL і в браузер не потрапляє.
 *
 * Змінні оточення (Vercel → Settings → Environment Variables):
 *   GOOGLE_SCRIPT_URL = https://script.google.com/macros/s/AKfyc.../exec
 *   ALLOWED_ORIGIN    = не обовʼязкова, поки лендинг лежить у цьому ж проєкті
 *                       (запит іде з того самого домену, CORS не застосовується)
 *
 * Перевірка: відкрийте https://ваш-проєкт.vercel.app/api/lead у браузері —
 * має відповісти {"ok":true,"scriptUrlConfigured":true}.
 */

const MAX_BODY = 4000;

function pickOrigin(req) {
  const allowed = (process.env.ALLOWED_ORIGIN || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin || '';
  if (allowed.includes('*')) return '*';
  return allowed.includes(origin) ? origin : allowed[0] || '';
}

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 9) d = '380' + d;
  else if (d.length === 10 && d[0] === '0') d = '38' + d;
  return d;
}

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // приймаємо обидві назви змінної, щоб нічого не перейменовувати на Vercel
  const GS_URL = process.env.GOOGLE_SCRIPT_URL || process.env.GS_URL;

  if (req.method === 'OPTIONS') return res.status(204).end();

  // health-check: відкрийте цей URL у браузері, щоб перевірити налаштування
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, scriptUrlConfigured: Boolean(GS_URL) });
  }

  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'method_not_allowed' });
  if (!GS_URL) return res.status(500).json({ success: false, error: 'script_url_missing' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

    // пастка для ботів: заповнене приховане поле — тихо приймаємо і нікуди не шлемо
    if (body.website) return res.status(200).json({ success: true });

    const name = String(body.name || '').trim().slice(0, 80);
    const phone = normalizePhone(body.phone);
    const quantity = Math.min(Math.max(parseInt(body.quantity, 10) || 1, 1), 20);

    if (name.length < 2) return res.status(400).json({ success: false, error: 'bad_name' });
    if (!/^380\d{9}$/.test(phone)) return res.status(400).json({ success: false, error: 'bad_phone' });

    const payload = {
      name,
      phone,
      quantity,
      variant: String(body.variant || '').slice(0, 80),
      total: Number(body.total) || null,
      page: String(body.page || '').slice(0, 300),
      utm_source: String(body.utm_source || '').slice(0, 120),
      utm_medium: String(body.utm_medium || '').slice(0, 120),
      utm_campaign: String(body.utm_campaign || '').slice(0, 160),
      utm_content: String(body.utm_content || '').slice(0, 160),
      utm_term: String(body.utm_term || '').slice(0, 160),
      fbclid: String(body.fbclid || '').slice(0, 300),
      ttclid: String(body.ttclid || '').slice(0, 300),
      gclid: String(body.gclid || '').slice(0, 300),
      ip:
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket?.remoteAddress ||
        '',
      ua: String(req.headers['user-agent'] || '').slice(0, 300)
    };

    const json = JSON.stringify(payload).slice(0, MAX_BODY);

    const gs = await fetch(GS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      redirect: 'follow'
    });

    const text = await gs.text();
    // 4xx/5xx від Google = заявка не записалась
    if (!gs.ok) {
      console.error('apps script http', gs.status, text.slice(0, 300));
      return res.status(200).json({ success: false, error: 'upstream_failed' });
    }
    // якщо Apps Script відповів JSON з success:false — теж збій
    try {
      const j = JSON.parse(text);
      if (j && j.success === false) {
        console.error('apps script reported failure', text.slice(0, 300));
        return res.status(200).json({ success: false, error: 'upstream_failed' });
      }
    } catch (_) { /* не JSON (HTML після редиректу) — це нормально */ }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('lead error', err);
    // 200 навмисно: фронт дивиться лише на поле success
    return res.status(200).json({ success: false, error: 'upstream_failed' });
  }
}
