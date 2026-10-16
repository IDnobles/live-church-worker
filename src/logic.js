// Pure decision logic (unit-tested; no network).
export const MIN_INTERVAL_MIN = 30;
export const SEND_NOW_FLOOR_MIN = 5;

export const ms = (v) => {
  if (!v) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  if (v.seconds != null) return v.seconds * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/** Minutes since midnight in an IANA timezone. */
export function minutesInZone(now, timeZone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

export function inQuietHours(qh, now) {
  if (!qh || !qh.enabled) return false;
  const re = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const a = re.exec(qh.start || ''); const b = re.exec(qh.end || '');
  if (!a || !b) return false;
  const s = +a[1] * 60 + +a[2]; const e = +b[1] * 60 + +b[2];
  const t = minutesInZone(now, qh.timezone || 'America/New_York');
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e; // window may wrap midnight
}

/**
 * Decide whether to push for a live church now.
 * Returns { send: boolean, reason }.
 */
export function shouldAlert(church, cfg, now) {
  if (!church.isLive || church.enabled === false) return { send: false, reason: 'not-live' };
  if (cfg && cfg.killSwitch) return { send: false, reason: 'kill-switch' };
  const last = ms(church.lastAlertAt);
  const requested = ms(church.alertRequestedAt);
  // Admin "send alert now": ignores interval + quiet hours, but not the kill switch,
  // and never more than once per SEND_NOW_FLOOR_MIN (protects against double taps).
  if (requested && (!last || requested > last)) {
    if (last && now - last < SEND_NOW_FLOOR_MIN * 60000) return { send: false, reason: 'send-now-floor' };
    return { send: true, reason: 'send-now' };
  }
  if (inQuietHours(cfg && cfg.quietHours, now)) return { send: false, reason: 'quiet-hours' };
  if (!last) return { send: true, reason: 'went-live' };
  const interval = Math.max(MIN_INTERVAL_MIN, Number(church.alertIntervalMin) || 60);
  if (now - last >= interval * 60000) return { send: true, reason: 'interval' };
  return { send: false, reason: 'interval-wait' };
}

export function parseRssVideoIds(xml, max = 5) {
  const ids = [];
  const re = /<yt:videoId>([\w-]{6,})<\/yt:videoId>/g;
  let m;
  while ((m = re.exec(xml)) && ids.length < max) ids.push(m[1]);
  return ids;
}

export function buildMessage(church) {
  const where = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' }[church.livePlatform] || 'live';
  const title = `🔴 ${church.name} is LIVE`;
  const body = church.liveTitle
    ? `${church.liveTitle} · Watch now on ${where}`
    : `Join the service now on ${where}. Tap to watch 🙏`;
  return { title, body };
}

/** Extract a JSON object assigned as `<marker> = {...}` from HTML (brace-matched, string-aware). */
export function extractJsonAfter(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/**
 * Parse https://www.youtube.com/channel/<id>/live HTML.
 * Returns { state: 'live'|'upcoming'|'none'|'consent'|'unknown', videoId, title, startedAt, channelId }.
 * Live only when canonical is a watch URL AND player says isLive (not upcoming) or microformat isLiveNow.
 */
export function parseLivePage(html) {
  if (!html) return { state: 'unknown' };
  if (/consent\.youtube\.com|<form[^>]+action="https:\/\/consent\./.test(html)) return { state: 'consent' };
  const canon = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
  if (!canon) return { state: 'none' };
  const pr = extractJsonAfter(html, 'ytInitialPlayerResponse = ') || extractJsonAfter(html, 'ytInitialPlayerResponse=');
  const vd = pr?.videoDetails || {};
  const lbd = pr?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails || {};
  const videoId = vd.videoId || canon[1];
  const base = { videoId, title: vd.title || '', channelId: vd.channelId || '' };
  const liveNow = lbd.isLiveNow === true || (vd.isLive === true && vd.isUpcoming !== true);
  if (liveNow && !lbd.endTimestamp) {
    const startedAt = lbd.startTimestamp ? Date.parse(lbd.startTimestamp) : null;
    return { state: 'live', ...base, startedAt };
  }
  if (vd.isUpcoming === true || (lbd.startTimestamp && !lbd.isLiveNow && !lbd.endTimestamp)) return { state: 'upcoming', ...base };
  if (!pr && /"isLiveNow":true/.test(html)) return { state: 'live', ...base, startedAt: null };
  return { state: 'none', ...base };
}

/** Run async fn over items with limited concurrency and a small delay between starts. */
export async function mapPool(items, limit, fn, delayMs = 0) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
