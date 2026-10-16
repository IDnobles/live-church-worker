import fs from 'fs';
import { checkLivePage } from '../src/youtube.js';
import { mapPool } from '../src/logic.js';
const ch = JSON.parse(fs.readFileSync(new URL('../seed/churches.json', import.meta.url)));
const t0 = Date.now();
const r = await mapPool(ch, 4, (c) => checkLivePage(c.youtubeChannelId), 250);
const tally = {};
r.forEach((p, i) => {
  const s = p.error ? 'error' : p.state; tally[s] = (tally[s] || 0) + 1;
  if (s === 'live' || s === 'error' || s === 'consent' || s === 'unknown') console.log(s, ch[i].name, p.videoId || p.error?.message || '', p.title || '');
  if (s === 'live' && p.channelId && p.channelId !== ch[i].youtubeChannelId) console.log('  channel mismatch', p.channelId);
});
console.log(JSON.stringify(tally), `${ch.length} channels in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
