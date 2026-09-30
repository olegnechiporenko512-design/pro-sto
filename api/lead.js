import { createHash } from "node:crypto";
import { waitUntil } from "@vercel/functions";
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

const MAX_BODY = 8000;

const PIXEL_ID = "1749190629525376";

function makeOrderId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${stamp}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function postSheet(url, payload) {
  const gs = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "follow",
  });
  const text = await gs.text();
  if (!gs.ok) return { ok: false, detail: `${gs.status} ${text.slice(0, 300)}` };
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.success === false) return { ok: false, detail: text.slice(0, 300) };
  } catch (_) {}
  return { ok: true, detail: "" };
}

async function sendMetaCapi(input) {
  const token = (process.env.META_CAPI_TOKEN || "").trim();
  if (!token) return;
  try {
    const userData = {
      ph: [sha256(input.phone)],
      fn: [sha256(String(input.name || "").trim().toLowerCase())],
    };
    const fbc = input.fbc || (input.fbclid ? `fb.1.${Date.now()}.${input.fbclid}` : "");
    if (input.ip) userData.client_ip_address = input.ip;
    if (input.userAgent) userData.client_user_agent = input.userAgent;
    if (input.fbp) userData.fbp = input.fbp;
    if (fbc) userData.fbc = fbc;
    const eventTime = Math.floor(Date.now() / 1000);
    const customData = { value: input.total, currency: "UAH", content_name: input.variant };
    const base = {
      event_time: eventTime,
      event_id: input.orderId,
      action_source: "website",
      event_source_url: input.page || undefined,
      user_data: userData,
      custom_data: customData,
    };
    const body = { data: [{ ...base, event_name: "Lead" }, { ...base, event_name: "Purchase" }] };
    const test = (process.env.META_TEST_EVENT_CODE || "").trim();
    if (test) body.test_event_code = test;
    const res = await fetch(`https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error("[capi] failed", res.status, (await res.text().catch(() => "")).slice(0, 400));
  } catch (error) {
    console.error("[capi] error", error && error.message ? error.message : "unknown");
  }
}

function queueDelivery(sheetUrl, payload, capi) {
  waitUntil((async () => {
    if (!sheetUrl) {
      console.error("[lead] sheet failed", "missing GOOGLE_SCRIPT_URL", JSON.stringify(payload));
    } else {
      let last = "";
      let ok = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
        try {
          const result = await postSheet(sheetUrl, payload);
          if (result.ok) { ok = true; break; }
          last = result.detail;
        } catch (error) {
          last = error && error.message ? error.message : "error";
        }
      }
      if (!ok) console.error("[lead] sheet failed", last, JSON.stringify(payload));
    }
    await sendMetaCapi(capi);
  })());
}

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
  let d = String(raw || "").replace(/\D/g, "");
  while (d.startsWith("380") || d.startsWith("80") || d.startsWith("0")) {
    if (d.startsWith("380")) d = d.slice(3);
    else if (d.startsWith("80")) d = d.slice(2);
    else d = d.slice(1);
  }
  return d.length === 9 ? "380" + d : "";
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
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

    // пастка для ботів: заповнене приховане поле — тихо приймаємо і нікуди не шлемо
    if (body.website) return res.status(200).json({ success: true });

    const name = String(body.name || '').trim().slice(0, 80);
    const phone = normalizePhone(body.phone);
    const quantity = Math.min(Math.max(parseInt(body.quantity, 10) || 1, 1), 20);

    if (name.length < 2) return res.status(400).json({ success: false, error: 'bad_name' });
    if (!/^380\d{9}$/.test(phone)) return res.status(400).json({ success: false, error: 'bad_phone' });

    const variant = String(body.variant || "").trim().slice(0, 200);
    const total = Number(body.total);
    if (!variant) return res.status(400).json({ success: false, error: "bad_variant" });
    if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ success: false, error: "bad_total" });

    const orderId = makeOrderId();
    const payload = {
      order_id: orderId,
      name,
      phone,
      quantity,
      variant,
      total,
      page: String(body.page || "").slice(0, 500),
      utm_source: String(body.utm_source || "").slice(0, 120),
      utm_medium: String(body.utm_medium || "").slice(0, 120),
      utm_campaign: String(body.utm_campaign || "").slice(0, 160),
      utm_content: String(body.utm_content || "").slice(0, 160),
      utm_term: String(body.utm_term || "").slice(0, 160),
      fbclid: String(body.fbclid || "").slice(0, 300),
      ttclid: String(body.ttclid || "").slice(0, 300),
      gclid: String(body.gclid || "").slice(0, 300),
      ip:
        (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
        req.socket?.remoteAddress ||
        "",
      ua: String(req.headers["user-agent"] || "").slice(0, 500),
    };
    if (JSON.stringify(payload).length > MAX_BODY) {
      return res.status(400).json({ success: false, error: "bad_name" });
    }

    queueDelivery(GS_URL, payload, {
      orderId,
      page: payload.page,
      name,
      phone,
      total,
      variant,
      ip: payload.ip,
      userAgent: payload.ua,
      fbp: String(body.fbp || "").slice(0, 200),
      fbc: String(body.fbc || "").slice(0, 300),
      fbclid: payload.fbclid,
    });
    return res.status(200).json({ success: true, order_id: orderId });
  } catch (err) {
    console.error('lead error', err);
    // 200 навмисно: фронт дивиться лише на поле success
    return res.status(200).json({ success: false, error: 'upstream_failed' });
  }
}
