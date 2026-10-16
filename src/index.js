// live-church-worker: run every 10 min (GitHub Actions cron).
// 1) Auto churches: /channel/<id>/live page (free) -> optional videos.list confirm (1 unit/50 ids); RSS fallback.
// 2) Live churches: OneSignal push to all 3 apps on go-live + every interval (>=30 min),
//    honoring liveConfig/global.killSwitch and quiet hours.
// Env (secrets only, never committed): YOUTUBE_API_KEY, FIREBASE_SERVICE_ACCOUNT (JSON),
// ONESIGNAL_{CSM,CACA,CACS}_APP_ID + ONESIGNAL_{CSM,CACA,CACS}_REST_KEY. DRY_RUN=1 = no writes/pushes.
import admin from 'firebase-admin';
import { buildMessage, ms, shouldAlert } from './logic.js';
import { detectYouTubeLive } from './youtube.js';

const DRY = process.env.DRY_RUN === '1';
const SEGMENT = process.env.ONESIGNAL_SEGMENT || 'Total Subscriptions';
const APPS = ['CSM', 'CACA', 'CACS'].map((k) => ({
  key: k,
  appId: process.env[`ONESIGNAL_${k}_APP_ID`],
  restKey: process.env[`ONESIGNAL_${k}_REST_KEY`],
})).filter((a) => a.appId && a.restKey);

const log = (...a) => console.log(new Date().toISOString(), ...a);

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  const sa = JSON.parse(raw);
  if (sa.project_id !== 'cshymnsapp') log(`warning: service account project is ${sa.project_id}, expected cshymnsapp`);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

async function pushAll(church) {
  const { title, body } = buildMessage(church);
  const results = [];
  for (const app of APPS) {
    const payload = {
      app_id: app.appId,
      included_segments: [SEGMENT],
      headings: { en: title },
      contents: { en: body },
      data: { type: 'live_church', liveChurchId: church.id },
      ...(church.avatarUrl ? { large_icon: church.avatarUrl, ios_attachments: { avatar: church.avatarUrl } } : {}),
      android_group: 'live_churches',
      thread_id: 'live_churches',
      collapse_id: `live_${church.id}`.slice(0, 64),
      ttl: 3600,
    };
    if (DRY) { results.push(`${app.key}:dry`); continue; }
    try {
      const r = await fetch('https://api.onesignal.com/notifications', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Key ${app.restKey}` },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      results.push(`${app.key}:${r.ok ? 'ok' : `err ${r.status} ${JSON.stringify(j.errors || j).slice(0, 120)}`}`);
    } catch (e) { results.push(`${app.key}:err ${e.message}`); }
  }
  return results;
}

async function main() {
  const db = initFirebase();
  const now = Date.now();
  if (!APPS.length) log('no OneSignal app credentials set: alerts will be skipped');
  const cfgSnap = await db.doc('liveConfig/global').get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  if (cfg.killSwitch) { log('kill switch ON: nothing to do'); return; }

  const snap = await db.collection('liveChurches').get();
  const churches = snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() })).filter((c) => c.enabled !== false);

  // ---- 1) YouTube auto-detect ----
  const auto = churches.filter((c) => c.mode === 'auto' && c.youtubeChannelId);
  const yt = await detectYouTubeLive([...new Set(auto.map((c) => c.youtubeChannelId))], { log });
  log('youtube:', JSON.stringify(yt.stats));
  const live = yt.live;
  const unchecked = new Set(yt.failed || []);
  if (live) {
    for (const c of auto) {
      const hit = live.get(c.youtubeChannelId);
      let patch = null;
      if (hit && (!c.isLive || c.liveVideoId !== hit.videoId)) {
        patch = {
          isLive: true, livePlatform: 'youtube', liveSource: 'auto', liveVideoId: hit.videoId,
          streamUrl: `https://www.youtube.com/watch?v=${hit.videoId}`, liveTitle: hit.title,
          liveSince: admin.firestore.Timestamp.fromMillis(hit.startedAt || now), lastAlertAt: null,
        };
      } else if (!hit && c.isLive && c.liveSource === 'auto' && !unchecked.has(c.youtubeChannelId)) {
        patch = { isLive: false, liveSince: null, liveVideoId: null };
      }
      if (patch) {
        log(`${c.name}: ${patch.isLive ? 'went LIVE' : 'ended'}`);
        Object.assign(c, patch);
        if (!DRY) await c.ref.update({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
  }

  // ---- 2) alerts ----
  for (const c of churches) {
    const d = shouldAlert({ ...c, lastAlertAt: ms(c.lastAlertAt), alertRequestedAt: ms(c.alertRequestedAt) }, cfg, now);
    if (!d.send) { if (c.isLive) log(`${c.name}: no alert (${d.reason})`); continue; }
    if (!APPS.length) { log(`${c.name}: would alert (${d.reason}) but no OneSignal creds`); continue; }
    const res = await pushAll(c);
    log(`${c.name}: alert (${d.reason}) -> ${res.join(', ')}`);
    if (!DRY) await c.ref.update({ lastAlertAt: admin.firestore.Timestamp.fromMillis(now), lastAlertResult: res.join(', ') });
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
