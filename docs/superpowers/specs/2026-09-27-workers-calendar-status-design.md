# Calendar-driven Discord status on Cloudflare Workers — design

Date: 2026-09-27
Status: design approved in conversation; awaiting review of this document
Supersedes: `2026-09-22-calendar-driven-status-design.md` (Go + launchd)

## Problem

The Discord custom status bubble is set by hand several times a day — `на паре`
during classes, `в пути` while travelling, empty otherwise. The university
timetable lives in the university Google account's calendar, so the bubble can
be derived from it.

The previous design ran a Go binary on the user's Mac. The user wants it to run
on Cloudflare Workers instead, so it works with the Mac off, with no database or
storage service.

## Goals

- Derive the bubble from the university calendar with no daily interaction.
- Run in the cloud, on a timer, with no stored state of any kind.
- Respect a status the user set by hand rather than overwriting it.
- Never clear or change the bubble as a side effect of a failure.
- Keep the decision logic testable with no network access.

## Non-goals

- Storage of any kind (KV, D1, Durable Objects, external databases). Every run
  starts from nothing.
- A public HTTP endpoint. The Worker has a cron trigger only.
- Manual `set` / `clear` commands. The Discord app does that, and the override
  rule respects it.
- Event names. The calendar is shared as free/busy only, and the logic needs
  only times.
- Reading the calendar over its secret iCal URL. Replaced by the Calendar API.

## Accepted risk

The bubble is written through Discord's user settings API with the user's own
account token, which is against Discord's Terms of Service. The user was told
this and accepted it. With this design the requests come from Cloudflare's
network rather than the user's own connection. Volume stays low: one read per
run and one write per status change.

## Architecture

One Worker, `dc-status`, TypeScript, deployed with `npx wrangler deploy`. A cron
trigger fires it **every minute**; a gate inside the Worker lets a run proceed
only every `RUN_EVERY_MINUTES` minutes (default 5). Cloudflare cannot read a
schedule from a variable, so the every-minute cron plus an in-code gate is what
makes the interval a plain setting. A gated-out run exits at once and costs
nothing meaningful.

### A run

Every run that passes the gate does the following, from scratch:

1. **Load and validate config.** Any missing or malformed value stops the run.
2. **Sign in to Google** as the service account: `jose` signs a JWT with the
   account's private key and Google exchanges it for a short-lived access token.
3. **Fetch busy ranges** for `[now − 24h, now + 24h]` from the university
   calendar with the Calendar API's `freeBusy` query. Google resolves recurring
   events, cancellations, moved occurrences and overlaps before answering.
4. **Read the current Discord custom status.**
5. **Compute** the desired status for `now` and for `now − RUN_EVERY_MINUTES`.
6. **Decide** — update, do nothing, or leave a manual status alone (table
   below).
7. **Write** the new status to Discord only when the decision is to update.

Per run: two calls to Google, one read from Discord, and one Discord write only
on an actual change.

### Timer gate

Cloudflare passes the scheduled time to the Worker. The run proceeds when
`floor(scheduledTime / 60 000) mod RUN_EVERY_MINUTES == 0`. With the default 5
that is `:00, :05, :10, …`; with a value that does not divide 60 the phase
drifts across hours, which is harmless. A gated-out run logs nothing.

`now − RUN_EVERY_MINUTES` is treated as "the previous run" for the override
rule. If a run is missed — a Cloudflare error, a Google or Discord failure —
a window change in that gap is not noticed, and a manual status persists until
the *next* change. The user accepted this.

## Google Calendar access

**Authentication.** A Google Cloud service account (a robot Google identity)
with a JSON key. Each run builds an RS256 JWT — `iss` = the account's
`client_email`, `aud` = `https://oauth2.googleapis.com/token`, `scope` =
`https://www.googleapis.com/auth/calendar.readonly`, lifetime ≤ 1h — signs it
with `jose` (`importPKCS8` + `SignJWT`), and POSTs it to the token endpoint with
`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`. The returned access
token is used once and discarded. Nothing is cached; nothing expires on the
user's side.

**Access.** The university calendar is shared with the service account's email
address. The university's Workspace policy allows external sharing at the
**free/busy** level only (confirmed by the user on 2026-09-27 by sharing with a
personal account). Free/busy is sufficient: the logic needs only when the user
is busy.

**Query.** `POST https://www.googleapis.com/calendar/v3/freeBusy` with
`timeMin`, `timeMax` and `items: [{ id: CALENDAR_ID }]`. The response holds
`calendars[CALENDAR_ID].busy`, a list of `{start, end}` ranges, already merged
where events overlap.

**Consequences of free/busy:**

- Events marked *Free* in Google Calendar never appear, so the user can exclude
  anything from the automation by marking it Free.
- All-day events are Free by default and so are ignored. An all-day event the
  user manually marks *Busy* would produce `на паре` for the whole day; without
  event names it cannot be filtered out. Accepted.
- Cancelled events never appear.
- Preview and logs show times only, never class names.

**The unshared-calendar trap.** When the service account cannot see the
calendar, the API still returns HTTP 200 with an `errors` array under
`calendars[CALENDAR_ID]` and no `busy` list. Reading that as "no classes" would
clear a valid `на паре`. The presence of `errors`, or the absence of the
calendar's entry, is a run failure.

## Decision logic

Implemented in `src/schedule.ts` as pure functions of `(now, busyRanges,
settings)` — no I/O, no clock access.

### Types

```ts
interface Range { start: Date; end: Date }            // one busy period

interface Decision {
  kind: "in-class" | "transit" | "clear";
  text: string;                                        // "" when clear
  emoji: string;                                       // "" when clear
  expiresAt: Date | null;                              // null when clear
}
```

### Blocks

Busy ranges are sorted by start and merged into **blocks**: a range joins the
current block if it starts less than `BREAK_MAX_MINUTES` after the block's end;
otherwise it opens a new block. Overlapping ranges always merge. A block spans
from its first range's start to its last range's end, breaks included.

Blocks exist because of breaks. Scored per class, a 15-minute break sits inside
the first class's post-window and the next class's pre-window and reads as
`в пути`, flipping the bubble several times a day. Scored per block it is simply
part of the class time.

### Rules

Evaluated against blocks, in order; the first match wins.

| # | Condition | Decision |
|---|---|---|
| 1 | `block.start <= now < block.end` | `in-class` — 📚 `на паре` |
| 2 | `block.start − TRANSIT_BEFORE <= now < block.start` | `transit` — 🚗 `в пути` |
| 3 | `block.end <= now < block.end + TRANSIT_AFTER` | `transit` — 🚗 `в пути` |
| 4 | otherwise | `clear` |

Example — classes 09:00–10:30, 10:45–12:15, 12:30–14:00, all defaults:

| Time | Bubble |
|---|---|
| 07:00–09:00 | 🚗 в пути |
| 09:00–14:00 | 📚 на паре, breaks included |
| 14:00–16:00 | 🚗 в пути |
| after 16:00 | cleared |

### Expiry

`expiresAt` is a safety net: if the Worker stops running, Discord clears the
bubble itself instead of leaving it stale. It is the next moment the decision
would actually change, found by collecting every block's `start`, `end`,
`start − TRANSIT_BEFORE` and `end + TRANSIT_AFTER` that lies after `now`,
sorting them, and returning the first at which re-running the rules yields a
different `kind`. Adjacent transit windows share a boundary at which nothing
changes; skipping it keeps a still-valid `в пути` from expiring early. A `clear`
decision has no expiry.

## Update decision

Implemented in `src/sync.ts`. Inputs: `want` = decision for `now`, `prev` =
decision for `now − RUN_EVERY_MINUTES`, `have` = the status currently on
Discord.

`have` is classified by its text, trimmed:

| `have` | Class |
|---|---|
| empty / null | **empty** |
| equals `TEXT_IN_CLASS` or `TEXT_TRANSIT` | **ours** |
| anything else | **manual** |

Then:

| `have` | Condition | Action |
|---|---|---|
| any | text and emoji already equal `want` (expiry is not compared) | none |
| empty or ours | — | write `want` |
| manual | `want.kind ≠ prev.kind` (a window changed since the last run) | write `want` |
| manual | no window change | none — leave the manual status |

Notes:

- "Write `want`" with `want.kind = clear` means clearing the bubble.
- A manual status is therefore replaced — or cleared — at the next window
  change, including the change from `transit` to `clear`. This is the rule the
  user chose ("leave it alone until the next window change").
- Typing `на паре` or `в пути` by hand makes the status count as ours. Accepted;
  it is the price of having no stored state.

## Discord API

Read: `GET https://discord.com/api/v9/users/@me/settings`, using the
`custom_status` field of the response (`text`, `emoji_name`, `expires_at`).

Write: `PATCH` the same URL with a JSON body containing only `custom_status` —
`{ text, emoji_name, expires_at }` to set, or `null` to clear. Because the body
carries nothing else, the user's online / idle / do-not-disturb / invisible
choice is never touched.

Headers: `Authorization: <token>` and `Content-Type: application/json`. If the
API rejects requests with no `User-Agent`, a plain identifying one
(`dc-status/1.0`) is added.

Two details are confirmed against the live API in the first implementation step,
before anything is built on them:

- **Emoji.** A unicode emoji is sent as the literal character in `emoji_name`
  with no `emoji_id`. Confirm the bubble renders it.
- **Expiry.** `expires_at` as an RFC 3339 timestamp. Confirm Discord accepts and
  honours it. If not, the safety net is dropped and the rest of the design is
  unaffected.

## Files

| File | Responsibility |
|---|---|
| `src/index.ts` | `scheduled` handler: timer gate, run once, log one line |
| `src/gate.ts` | The timer gate (`shouldRun`), kept separate from the handler so it is trivially testable |
| `src/config.ts` | Read env, validate, apply defaults, expose typed settings |
| `src/google.ts` | Service-account JWT, token exchange, `freeBusy` query |
| `src/discord.ts` | Read and write the custom status |
| `src/schedule.ts` | Blocks, rules, expiry — pure |
| `src/sync.ts` | Classification of `have`, the update decision, one full run |
| `scripts/preview.ts` | `npm run preview` — local, read-only |
| `test/*.test.ts` | One file per module |
| `wrangler.jsonc` | Worker name, cron, vars, `nodejs_compat` off |
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Tooling |

Each module is importable on its own. `google.ts` and `discord.ts` take a
`fetch` function as a parameter so tests inject a fake; `schedule.ts` and the
decision part of `sync.ts` take all inputs as arguments.

## Configuration

**Secrets** — `wrangler secret put` for the deployed Worker, `.dev.vars`
(git-ignored) for `npm run preview`:

| Secret | Value |
|---|---|
| `DISCORD_TOKEN` | The user's Discord token (moved from `.env`) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | The service account's JSON key, as one string |
| `CALENDAR_ID` | The university account's email address |

**Vars** — in `wrangler.jsonc`, all durations in whole minutes:

| Var | Default | Meaning |
|---|---|---|
| `RUN_EVERY_MINUTES` | `5` | Interval between real runs |
| `TRANSIT_BEFORE_MINUTES` | `120` | Pre-block transit window |
| `TRANSIT_AFTER_MINUTES` | `120` | Post-block transit window |
| `BREAK_MAX_MINUTES` | `120` | Longest gap still inside one block |
| `TEXT_IN_CLASS` | `на паре` | Bubble text during a block |
| `TEXT_TRANSIT` | `в пути` | Bubble text while travelling |
| `EMOJI_IN_CLASS` | `📚` | Emoji during a block |
| `EMOJI_TRANSIT` | `🚗` | Emoji while travelling |
| `TIMEZONE` | `Asia/Tashkent` | Display only, for preview and logs |

Validation: every `*_MINUTES` value is a positive integer; texts are non-empty;
`TIMEZONE` is a valid IANA name; the key parses as JSON with `client_email` and
`private_key`. A failed validation stops the run before any network call.

## Failure behaviour

**Governing rule: a failure never clears or changes the bubble.** Only the
calendar affirmatively saying the user is free does that.

| Failure | Behaviour |
|---|---|
| Config invalid or a secret missing | Log, stop |
| Google token exchange fails (bad key, API not enabled) | Log, stop |
| `freeBusy` HTTP error | Log, stop |
| `freeBusy` 200 with `errors` for the calendar, or no entry for it | Log, stop |
| Discord read fails (401, 403, 429, network) | Log, stop |
| Discord write fails | Log; the next run retries naturally |
| Worker stops running | `expires_at` clears the bubble at the next boundary |

Discord's 429 responses are treated as a failed run, not retried within the run.
Cloudflare's shared egress addresses occasionally meet Discord rate limits; the
consequence is a status update delayed by one interval.

## Logging

One line per real run via `console.log`, visible with `npx wrangler tail` and in
the Cloudflare dashboard, shaped like:

```
09:00 Asia/Tashkent | want: 📚 на паре until 14:00 | have: 🚗 в пути | updated
```

The last field is one of `updated`, `unchanged`, `manual, left alone`, or the
failure reason. Gated-out runs log nothing. Secrets are never logged.

## Preview

`npm run preview` runs `scripts/preview.ts` locally with `tsx`, reading secrets
from `.dev.vars`. It performs steps 2–6 of a run and prints:

- the busy ranges Google returned for the next 24h, in `TIMEZONE`;
- the decision timeline as segments (`07:00–09:00 🚗 в пути`, …);
- the current Discord status;
- the action a real run would take right now.

It never writes to Discord. It is the verification gate before deployment.

## Testing

`vitest`, Node environment, no real network. `jose` and `fetch` behave the same
in Node 26 and in Workers, so the Workers test pool is not needed.

- **`schedule`** — every boundary of a single class at exact equality (the
  `<=` / `<` endpoints); 10–30 min breaks stay `in-class`; gaps just under,
  exactly at and over `BREAK_MAX`; overlapping ranges; empty day → `clear`, no
  expiry; adjacent transit windows → expiry skips the no-change boundary; a
  block crossing midnight; `BREAK_MAX` shorter than `TRANSIT_BEFORE` still gives
  rule 1 priority.
- **`sync` decision** — all four rows of the update table, for each of `want`
  ∈ {in-class, transit, clear}, including the manual-status-cleared-at-window-
  change case.
- **`sync` run** — every failure row produces no write; a no-change run makes
  exactly one Discord call (the read).
- **`google`** — JWT claims and header; token exchange request shape; error
  response; `freeBusy` request body; the unshared-calendar trap.
- **`discord`** — read parsing (set, empty, null); write body for set and for
  clear; 401 / 429 handling.
- **`index`** — the timer gate for intervals 1, 5 and 7.

## Sequencing and checkpoints

1. Scaffold: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest`,
   `.gitignore`, `.dev.vars` with the Discord token moved from `.env`.
2. `discord.ts` with tests, then a one-off live check: set 🚗 `в пути` with a
   10-minute expiry, read it back, look at the app. **Checkpoint: emoji renders
   and the expiry is honoured.**
3. `schedule.ts`, test-first.
4. User sets up Google: a free Cloud project, enable the Calendar API, create a
   service account and JSON key, share the university calendar with its email
   (free/busy). `google.ts` with tests, then a live `freeBusy` call.
   **Checkpoint: the robot sees the user's busy times.**
5. `sync.ts`, test-first.
6. `scripts/preview.ts`. **Checkpoint: the user confirms the printed week
   matches the real timetable.**
7. `index.ts` with the gate; `wrangler secret put` × 3; `npx wrangler deploy`;
   watch `wrangler tail` through a class day.

Checkpoints 2, 4 and 6 are gates, not formalities. The deployed timer is not
enabled until 6 passes.

## Out of scope, for later

- Per-event status text (impossible under free/busy sharing anyway).
- A protected `/preview` HTTP endpoint for checking from a phone.
- A pause command.
