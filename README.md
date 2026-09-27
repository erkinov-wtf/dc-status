# dc-status

A small Cloudflare Worker that keeps a Discord custom status in sync with a
Google Calendar.

- Reads free/busy from a Google Calendar on a timer (no daily interaction).
- Sets the Discord custom status bubble to a class/transit label, and clears
  it otherwise — without touching online/idle/DND state.
- Respects a status you set by hand until the next window change; never
  writes anything if a step fails.

## One-time setup

1. Create a Google service account and download its JSON key. Share your
   calendar with the service account's email, with "See only free/busy"
   (or full details) access.
2. Create `.dev.vars` in the project root with:
   - `DISCORD_TOKEN` — your Discord account token.
   - `GOOGLE_SERVICE_ACCOUNT_KEY` — the service account JSON, as raw JSON or
     base64.
   - `CALENDAR_ID` — the calendar's ID (usually its owner's email address).
3. Push the same three values as Worker secrets before deploying:
   ```
   npx wrangler secret put DISCORD_TOKEN
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY
   npx wrangler secret put CALENDAR_ID
   ```

## Commands

- `npm test` — run the test suite.
- `npm run preview` — print today/tomorrow's status timeline without writing.
- `npm run check:discord` — confirm the Discord read/write calls work.
- `npm run check:google` — confirm the Google auth and free/busy calls work.
- `npm run deploy` — deploy the Worker.
- `npm run tail` — stream the deployed Worker's logs.

## Settings (`wrangler.jsonc` → `vars`, all optional)

| Var | Default | Meaning |
|---|---|---|
| `RUN_EVERY_MINUTES` | `5` | How often a run actually does work (≤ 60). |
| `TRANSIT_BEFORE_MINUTES` | `120` | How long before a class counts as transit (< 1440). |
| `TRANSIT_AFTER_MINUTES` | `120` | How long after a class counts as transit (< 1440). |
| `BREAK_MAX_MINUTES` | `120` | Gap between events still counted as one block (< 1440). |
| `TEXT_IN_CLASS` / `EMOJI_IN_CLASS` | `на паре` / `📚` | Status while in class. |
| `TEXT_TRANSIT` / `EMOJI_TRANSIT` | `в пути` / `🚗` | Status while in transit. |
| `TIMEZONE` | `Asia/Tashkent` | Used only for log/preview formatting. |

## Troubleshooting

- **401 from Discord** — the token expired or was copied wrong; re-copy it
  from a logged-in browser session and update the secret.
- **`notFound` … "is it shared"** — the calendar isn't shared with the
  service account; share it with the service account's email.
- **429** — rate limited; wait one run interval and it will retry itself.
