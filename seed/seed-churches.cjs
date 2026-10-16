// Upserts seed/churches.json into Firestore (project cshymnsapp) collection liveChurches.
// Usage: FIREBASE_SERVICE_ACCOUNT='<json>' node seed/seed-churches.cjs [--dry-run]
// Existing docs keep their live state (isLive/liveSince/lastAlertAt/streamUrl); only directory fields are merged.
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const DRY = process.argv.includes('--dry-run');
const STATIC = ['name', 'denomination', 'city', 'country', 'avatarUrl', 'facebookUrl', 'instagramUrl',
  'youtubeUrl', 'youtubeChannelId', 'tiktokUrl', 'mode', 'alertIntervalMin'];

async function main() {
  const churches = JSON.parse(fs.readFileSync(path.join(__dirname, 'churches.json'), 'utf8'));
  if (DRY) { console.log(`[dry-run] would upsert ${churches.length} churches`); return; }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env is required');
  const sa = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id || 'cshymnsapp' });
  if ((sa.project_id || 'cshymnsapp') !== 'cshymnsapp') throw new Error(`Refusing: service account is for ${sa.project_id}`);
  const db = admin.firestore();
  const col = db.collection('liveChurches');
  let created = 0, updated = 0;
  for (let i = 0; i < churches.length; i += 400) {
    const batch = db.batch();
    const chunk = churches.slice(i, i + 400);
    const snaps = await db.getAll(...chunk.map((c) => col.doc(c.id)));
    chunk.forEach((c, j) => {
      const data = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      STATIC.forEach((k) => { if (c[k] !== undefined) data[k] = c[k]; });
      if (!c.youtubeChannelId) data.mode = 'manual';
      if (snaps[j].exists) { updated++; } else {
        created++;
        Object.assign(data, { enabled: c.enabled !== false, isLive: false, livePlatform: c.livePlatform || 'youtube',
          createdAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      batch.set(col.doc(c.id), data, { merge: true });
    });
    await batch.commit();
  }
  const cfgRef = db.doc('liveConfig/global');
  const cfg = await cfgRef.get();
  if (!cfg.exists) {
    await cfgRef.set({ killSwitch: false, quietHours: { enabled: false, start: '22:00', end: '06:00', timezone: 'America/New_York' },
      createdAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log('liveConfig/global: created (killSwitch OFF)');
  } else console.log('liveConfig/global: exists, left unchanged');
  const count = (await col.count().get()).data().count;
  console.log(`liveChurches: ${created} created, ${updated} updated; collection now has ${count} docs`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
