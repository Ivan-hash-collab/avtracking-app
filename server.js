import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import morgan from "morgan";

const {
  PORT = 10000,
  ALLOW_ORIGIN = "https://app.avtracking.ru",
  AVITO_USER_ID,
  AVITO_CLIENT_ID,
  AVITO_CLIENT_SECRET
} = process.env;

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOW_ORIGIN }));
app.use(morgan("tiny"));

/** ---------- OAuth: кэшируем access_token ---------- */
let accessToken = null;
let tokenExp = 0;

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (accessToken && now < tokenExp - 60) return accessToken;

  const r = await fetch("https://api.avito.ru/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: AVITO_CLIENT_ID,
      client_secret: AVITO_CLIENT_SECRET
    })
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`OAuth error ${r.status}: ${txt}`);
  }
  const j = await r.json();
  accessToken = j.access_token;
  tokenExp = Math.floor(Date.now() / 1000) + (j.expires_in || 3600);
  return accessToken;
}

/** ---------- Утилиты ---------- */
function sum(arr, k) { return arr.reduce((s,x)=>s+(x[k]||0),0) }
function groupByPeriod(rows, period="day") {
  const map = new Map();
  for (const r of rows) {
    const d = new Date(r.date + "T00:00:00Z");
    let key;
    if (period === "week") {
      const tmp = new Date(d);
      const wd = (tmp.getUTCDay() + 6) % 7; // Mon=0
      tmp.setUTCDate(tmp.getUTCDate() - wd);
      key = tmp.toISOString().slice(0,10);
    } else if (period === "month") {
      key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-01`;
    } else key = d.toISOString().slice(0,10);

    if (!map.has(key)) map.set(key, { date:key, views:0, clicks:0, contacts:0, calls:0, sales:0 });
    const acc = map.get(key);
    acc.views    += r.views    || 0;
    acc.clicks   += r.clicks   || 0;
    acc.contacts += r.contacts || 0;
    acc.calls    += r.calls    || 0;
    acc.sales    += r.sales    || 0;
  }
  return [...map.values()].sort((a,b)=>a.date.localeCompare(b.date));
}

/** ---------- Адаптер ответов Avito → формат фронта ----------
 * У Avito структура статистики может отличаться в зависимости от метода.
 * Мы делаем адаптер под сценарий: /stats/v1/accounts/{user_id}/items
 * и (опционально) /core/v1/accounts/{user_id}/calls/stats/
 * Если поля будут называться иначе — ты увидишь это в /debug и поправим маппинг.
 */
function adaptItemsStats(raw) {
  // Ищем массив с датами. Часто это что-то вроде raw.result[0].stats / dates
  const rows = [];

  function push(date, patch) {
    rows.push({ date, views:0, clicks:null, contacts:0, calls:0, sales:0, ...patch });
  }

  // Пример гибкого прохода по возможным структурам
  const buckets = [];
  if (Array.isArray(raw?.result)) buckets.push(...raw.result);
  if (Array.isArray(raw?.data))   buckets.push(...raw.data);

  for (const b of buckets) {
    const dates = b?.stats || b?.dates || b?.statistics || [];
    for (const d of dates) {
      const date = d.date || d.day || d.dt;
      if (!date) continue;
      push(date, {
        views:    d.views ?? d.uniqViews ?? d.totalViews ?? 0,
        contacts: d.contacts ?? d.uniqContacts ?? d.totalContacts ?? 0,
        // Клики часто недоступны отдельно — оставим null
      });
    }
  }
  return rows;
}

function adaptCallsStats(raw) {
  const rows = [];
  const items = raw?.result || raw?.data || [];
  for (const it of items) {
    const date = it.date || it.day || it.dt;
    if (!date) continue;
    rows.push({ date, calls: it.calls ?? it.success_calls ?? it.total ?? 0 });
  }
  return rows;
}

/** ---------- Тех.эндпоинты для отладки RAW ---------- */
app.get("/debug/items", async (req, res) => {
  try {
    const token = await getAccessToken();
    const { itemId, dateFrom, dateTo } = req.query;
    const r = await fetch(`https://api.avito.ru/stats/v1/accounts/${AVITO_USER_ID}/items`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        date_from: dateFrom, date_to: dateTo,
        item_ids: [ Number(itemId) ]
        // при необходимости добавим "fields": [...]
      })
    });
    const j = await r.json();
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/debug/calls", async (req, res) => {
  try {
    const token = await getAccessToken();
    const { dateFrom, dateTo } = req.query;
    const r = await fetch(`https://api.avito.ru/core/v1/accounts/${AVITO_USER_ID}/calls/stats/`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ date_from: dateFrom, date_to: dateTo })
    });
    const j = await r.json();
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** ---------- Основной эндпоинт для фронта ---------- */
app.get("/stats", async (req, res) => {
  try {
    const { itemId, dateFrom, dateTo, grouping = "day" } = req.query;
    const token = await getAccessToken();

    // 1) items stats
    const r1 = await fetch(`https://api.avito.ru/stats/v1/accounts/${AVITO_USER_ID}/items`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ date_from: dateFrom, date_to: dateTo, item_ids: [ Number(itemId) ] })
    });
    const j1 = await r1.json();
    let rows = adaptItemsStats(j1);

    // 2) calls stats (необязательно)
    try {
      const r2 = await fetch(`https://api.avito.ru/core/v1/accounts/${AVITO_USER_ID}/calls/stats/`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ date_from: dateFrom, date_to: dateTo })
      });
      if (r2.ok) {
        const j2 = await r2.json();
        const calls = adaptCallsStats(j2);
        // мердж по дате
        const map = new Map(rows.map(r=>[r.date, r]));
        for (const c of calls) {
          const t = map.get(c.date) || { date: c.date };
          t.calls = (t.calls||0) + (c.calls||0);
          map.set(c.date, t);
        }
        rows = [...map.values()].sort((a,b)=>a.date.localeCompare(b.date));
      }
    } catch {}

    // группировка
    const grouped = groupByPeriod(rows, grouping);
    res.json({ itemId, series: grouped });

  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** ---------- Health ---------- */
app.get("/health", (_req,res)=>res.send("ok"));

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
