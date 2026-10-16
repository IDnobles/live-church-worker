// YouTube live detection. Primary: /channel/<id>/live page (free, no quota).
// Confirm: videos.list liveStreamingDetails when YOUTUBE_API_KEY is set (1 unit per 50 ids).
// Fallback: RSS + videos.list only for channels whose /live page failed (needs key).
import { mapPool, parseLivePage, parseRssVideoIds } from './logic.js';

// 24/7 music loops aren't services; never alert on them.
export const ALWAYS_ON = /24\s*\/\s*7|24-7|24hrs? (live|stream)|lofi radio/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const COOKIE = 'CONSENT=YES+cb.20240101-00-p0.en+FX+000; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg';
const HEADERS = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: COOKIE };

async function getText(url, fetchImpl, headers = HEADERS) {
  const r = await fetchImpl(url, { headers, redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${url.replace(/key=[^&]+/, 'key=***')}`);
  return r.text();
}

export async function checkLivePage(channelId, fetchImpl = fetch) {
  const html = await getText(`https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`, fetchImpl);
  return parseLivePage(html);
}

async function videosList(ids, key, fetchImpl) {
  const res = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${ids.slice(i, i + 50).join(',')}&key=${key}`;
    const json = JSON.parse(await getText(url, fetchImpl, { 'user-agent': 'live-church-worker/1.1' }));
    for (const it of json.items || []) {
      const l = it.liveStreamingDetails || {};
      res.set(it.id, {
        live: it.snippet?.liveBroadcastContent === 'live' && !!l.actualStartTime && !l.actualEndTime,
        title: it.snippet?.title || '', startedAt: l.actualStartTime ? Date.parse(l.actualStartTime) : null,
        channelId: it.snippet?.channelId,
      });
    }
  }
  return res;
}

/**
 * Returns { live: Map<channelId,{videoId,title,startedAt}>, stats }.
 * Returns null live map only if every page check failed and no fallback was possible.
 */
export async function detectYouTubeLive(channelIds, { key = process.env.YOUTUBE_API_KEY, fetchImpl = fetch,
  concurrency = 4, delayMs = 250, log = () => {} } = {}) {
  const live = new Map();
  const stats = { channels: channelIds.length, pageOk: 0, pageFailed: 0, upcoming: 0, candidates: 0, confirmed: 0, rssFallback: 0, quotaUnits: 0 };
  if (!channelIds.length) return { live, stats };
  const pages = await mapPool(channelIds, concurrency, (ch) => checkLivePage(ch, fetchImpl), delayMs);
  const failed = [];
  const cand = new Map(); // videoId -> {channelId, page}
  pages.forEach((p, i) => {
    const ch = channelIds[i];
    if (!p || p.error || p.state === 'consent' || p.state === 'unknown') {
      stats.pageFailed++; failed.push(ch);
      log('live page failed', ch, p?.error?.message || p?.state);
      return;
    }
    stats.pageOk++;
    if (p.state === 'upcoming') stats.upcoming++;
    if (p.state === 'live' && ALWAYS_ON.test(p.title || '')) { stats.alwaysOnSkipped = (stats.alwaysOnSkipped || 0) + 1; return; }
    if (p.state === 'live' && p.videoId) cand.set(p.videoId, { ch, p });
  });
  stats.candidates = cand.size;

  if (key) {
    // RSS fallback only for failed pages.
    for (const ch of failed) {
      try {
        const xml = await getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ch)}`, fetchImpl);
        parseRssVideoIds(xml, 5).forEach((v) => { if (!cand.has(v)) cand.set(v, { ch, p: null }); });
        stats.rssFallback++;
      } catch (e) { log('rss fallback failed', ch, e.message); }
    }
    const ids = [...cand.keys()];
    if (ids.length) {
      try {
        const info = await videosList(ids, key, fetchImpl);
        stats.quotaUnits = Math.ceil(ids.length / 50);
        for (const [vid, { ch, p }] of cand) {
          const v = info.get(vid);
          if (v?.live && !live.has(ch)) { live.set(ch, { videoId: vid, title: v.title || p?.title || '', startedAt: v.startedAt }); stats.confirmed++; }
        }
      } catch (e) {
        log('videos.list failed, trusting live pages', e.message);
        for (const [vid, { ch, p }] of cand) if (p && !live.has(ch)) live.set(ch, { videoId: vid, title: p.title, startedAt: p.startedAt });
      }
    }
  } else {
    for (const [vid, { ch, p }] of cand) if (p && !live.has(ch)) live.set(ch, { videoId: vid, title: p.title, startedAt: p.startedAt });
  }
  // If every page failed and there's no way to verify, signal "unknown" so we don't mark churches offline.
  if (stats.pageOk === 0 && !key) return { live: null, stats };
  return { live, stats, failed };
}
