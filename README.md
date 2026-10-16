# live-church-worker

Every 10 min (GitHub Actions, free): YouTube auto-detect for `mode: "auto"` churches and
OneSignal live alerts to C&S Mobile, CAC Archive and CAC Social. Firestore: `cshymnsapp`.

- Detection: channel RSS `youtube.com/feeds/videos.xml?channel_id=…` (no quota) → `videos.list`
  (1 unit per ≤50 ids). **No `search.list`.** ~144 runs/day ≈ 150–300 units/day of 10,000 free.
- Facebook / Instagram: no free public live API → manual toggle in C&S Mobile › Live Control.
- Alerts: on go-live, then every `alertIntervalMin` (min 30) while live; quiet hours + kill switch
  in `liveConfig/global`. "Send alert now" sets `alertRequestedAt`; picked up on the next run.
- Push payload `data: { type: "live_church", liveChurchId }` → apps open the live sheet.

## Secrets (repo → Settings → Secrets → Actions)
`YOUTUBE_API_KEY`, `FIREBASE_SERVICE_ACCOUNT` (JSON for cshymnsapp), `ONESIGNAL_CSM_APP_ID`,
`ONESIGNAL_CSM_REST_KEY`, `ONESIGNAL_CACA_APP_ID`, `ONESIGNAL_CACA_REST_KEY`,
`ONESIGNAL_CACS_APP_ID`, `ONESIGNAL_CACS_REST_KEY`. Optional `ONESIGNAL_SEGMENT`
(default `Total Subscriptions`).

Public repo = unlimited free Actions minutes (private: 2,000 min/mo, ~4,300 needed at 10-min cadence → use public, or 20-min cron).

Local: `npm ci && npm test && DRY_RUN=1 FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" npm start`

## Safety
Scheduled runs are DRY_RUN unless the repo variable `DRY_RUN` is exactly `0`. All keys live in GitHub Actions secrets; nothing secret is in this repo.
