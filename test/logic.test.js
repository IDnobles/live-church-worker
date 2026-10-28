import test from 'node:test';
import assert from 'node:assert/strict';
import { inQuietHours, parseRssVideoIds, shouldAlert } from '../src/logic.js';

const NOW = Date.parse('2026-10-18T15:00:00Z'); // 11:00 ET
const qhNight = { enabled: true, start: '22:00', end: '06:00', timezone: 'America/New_York' };

test('go-live alerts immediately', () => {
  assert.equal(shouldAlert({ isLive: true }, {}, NOW).reason, 'went-live');
});
test('interval respected with 30 min floor', () => {
  const c = { isLive: true, alertIntervalMin: 10, lastAlertAt: NOW - 20 * 60000 };
  assert.equal(shouldAlert(c, {}, NOW).send, false);
  assert.equal(shouldAlert({ ...c, lastAlertAt: NOW - 31 * 60000 }, {}, NOW).send, true);
});
test('kill switch blocks everything', () => {
  assert.equal(shouldAlert({ isLive: true, alertRequestedAt: NOW }, { killSwitch: true }, NOW).send, false);
});
test('quiet hours wrap midnight', () => {
  assert.equal(inQuietHours(qhNight, Date.parse('2026-10-18T03:30:00Z')), true); // 23:30 ET
  assert.equal(inQuietHours(qhNight, NOW), false);
  assert.equal(shouldAlert({ isLive: true }, { quietHours: qhNight }, Date.parse('2026-10-18T03:30:00Z')).reason, 'quiet-hours');
});
test('send-now bypasses interval but has 5 min floor', () => {
  assert.equal(shouldAlert({ isLive: true, lastAlertAt: NOW - 10 * 60000, alertRequestedAt: NOW - 60000 }, {}, NOW).reason, 'send-now');
  assert.equal(shouldAlert({ isLive: true, lastAlertAt: NOW - 2 * 60000, alertRequestedAt: NOW - 60000 }, {}, NOW).send, false);
});
test('rss parse', () => {
  assert.deepEqual(parseRssVideoIds('<yt:videoId>abc123XYZ_-</yt:videoId><yt:videoId>def456ghi</yt:videoId>'), ['abc123XYZ_-', 'def456ghi']);
});

import { extractJsonAfter, mapPool, parseLivePage } from '../src/logic.js';
import { detectYouTubeLive } from '../src/youtube.js';

const page = (pr, canon = 'abcdefghijk') =>
  `<html><link rel="canonical" href="https://www.youtube.com/watch?v=${canon}"><script>var ytInitialPlayerResponse = ${JSON.stringify(pr)};</script></html>`;
const LIVE_PR = { videoDetails: { videoId: 'abcdefghijk', title: 'Sunday Service "Live" {x}', isLive: true, channelId: 'UCx' },
  microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true, startTimestamp: '2026-10-18T14:00:00+00:00' } } } };

test('extractJsonAfter handles braces inside strings', () => {
  assert.equal(extractJsonAfter('x = {"a":"}{","b":{"c":1}};', 'x = ').b.c, 1);
});
test('live page -> live', () => {
  const r = parseLivePage(page(LIVE_PR));
  assert.equal(r.state, 'live'); assert.equal(r.videoId, 'abcdefghijk');
  assert.equal(r.startedAt, Date.parse('2026-10-18T14:00:00Z'));
});
test('upcoming scheduled stream is not live', () => {
  const pr = { videoDetails: { videoId: 'abcdefghijk', isLive: true, isUpcoming: true },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false, startTimestamp: '2026-10-19T14:00:00Z' } } } };
  assert.equal(parseLivePage(page(pr)).state, 'upcoming');
});
test('ended stream / channel home is not live', () => {
  const pr = { videoDetails: { videoId: 'abcdefghijk' }, microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false, startTimestamp: 'a', endTimestamp: 'b' } } } };
  assert.equal(parseLivePage(page(pr)).state, 'none');
  assert.equal(parseLivePage('<link rel="canonical" href="https://www.youtube.com/channel/UCx">').state, 'none');
});
test('consent page detected', () => {
  assert.equal(parseLivePage('<form action="https://consent.youtube.com/save">').state, 'consent');
});
test('mapPool respects concurrency', async () => {
  let active = 0, peak = 0;
  await mapPool([1, 2, 3, 4, 5, 6], 2, async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; });
  assert.equal(peak, 2);
});
const fakeFetch = (routes) => async (url) => {
  const hit = Object.entries(routes).find(([k]) => url.includes(k));
  if (!hit) return { ok: false, status: 404, text: async () => '' };
  return { ok: true, status: 200, text: async () => (typeof hit[1] === 'function' ? hit[1]() : hit[1]) };
};
test('detect without key trusts live page', async () => {
  const f = fakeFetch({ '/channel/UCa/live': page(LIVE_PR), '/channel/UCb/live': page({ videoDetails: { videoId: 'zzzzzzzzzzz' } }, 'zzzzzzzzzzz') });
  const { live, stats } = await detectYouTubeLive(['UCa', 'UCb'], { key: '', fetchImpl: f, delayMs: 0 });
  assert.equal(live.size, 1); assert.equal(live.get('UCa').videoId, 'abcdefghijk'); assert.equal(stats.pageOk, 2);
});
test('key set: videos.list confirms or rejects; RSS fallback for failed pages', async () => {
  const api = JSON.stringify({ items: [
    { id: 'abcdefghijk', snippet: { liveBroadcastContent: 'none', title: 't' }, liveStreamingDetails: { actualStartTime: 'x', actualEndTime: 'y' } },
    { id: 'rssvideo123', snippet: { liveBroadcastContent: 'live', title: 'From RSS' }, liveStreamingDetails: { actualStartTime: '2026-10-18T14:00:00Z' } }] });
  const f = fakeFetch({ '/channel/UCa/live': page(LIVE_PR), 'feeds/videos.xml?channel_id=UCc': '<yt:videoId>rssvideo123</yt:videoId>', 'googleapis.com': api });
  const { live, stats, failed } = await detectYouTubeLive(['UCa', 'UCc'], { key: 'k', fetchImpl: f, delayMs: 0 });
  assert.equal(live.has('UCa'), false); // API says it ended
  assert.equal(live.get('UCc').title, 'From RSS');
  assert.deepEqual(failed, ['UCc']); assert.equal(stats.quotaUnits, 1);
});
test('all pages failing without key -> unknown (null)', async () => {
  const { live } = await detectYouTubeLive(['UCa'], { key: '', fetchImpl: fakeFetch({}), delayMs: 0 });
  assert.equal(live, null);
});
test('24/7 loop streams are ignored', async () => {
  const pr = { ...LIVE_PR, videoDetails: { ...LIVE_PR.videoDetails, title: 'Hymns [24/7 Livestream]' } };
  const { live } = await detectYouTubeLive(['UCa'], { key: '', fetchImpl: fakeFetch({ '/channel/UCa/live': page(pr) }), delayMs: 0 });
  assert.equal(live.size, 0);
});

import { oneSignalResult, segmentFor } from '../src/logic.js';

test('oneSignalResult: 200 with empty id + errors is a failure', () => {
  const r = oneSignalResult(200, { id: '', errors: ['All included players are not subscribed'], warnings: ['Mobile push delivery was suppressed because your organization is over its free monthly active users limit.'] });
  assert.equal(r.ok, false);
  assert.match(r.text, /^err 200 All included players/);
  assert.match(r.text, /monthly active users/);
});

test('oneSignalResult: real id is ok; warnings surfaced', () => {
  assert.equal(oneSignalResult(200, { id: 'abc' }).text, 'ok');
  const w = oneSignalResult(200, { id: 'abc', warnings: ['something'] });
  assert.equal(w.ok, true);
  assert.match(w.text, /warn: something/);
  assert.equal(oneSignalResult(400, { errors: ['bad'] }).ok, false);
});

test('segmentFor: per-app defaults and overrides', () => {
  assert.equal(segmentFor('CSM', {}), 'Total Subscriptions');
  assert.equal(segmentFor('CACA', {}), 'Subscribed Users');
  assert.equal(segmentFor('CACS', {}), 'Subscribed Users');
  assert.equal(segmentFor('CACA', { ONESIGNAL_SEGMENT: 'X' }), 'X');
  assert.equal(segmentFor('CACA', { ONESIGNAL_SEGMENT: 'X', ONESIGNAL_CACA_SEGMENT: 'Y' }), 'Y');
});
