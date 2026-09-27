# dc-status on Cloudflare Workers — design

Date: 2026-09-27
Status: design approved in conversation, awaiting written-spec review
Supersedes: `2026-09-22-calendar-driven-status-design.md` (Go + launchd)

## Outcome

The Discord custom status is set by hand several times a day — `на паре` during
classes, `в пути` when travelling, empty otherwise. The timetable already lives
on the university Google account's calendar. A Cloudflare Worker derives the
status from that calendar every few minutes, so it never has to be typed.

Success means: `npm run preview` shows a timeline that matches the real week,
and the deployed Worker then switches the status correctly through a real class
day with no manual input.

## Decisions already made

| Topic | Decision |
|---|---|
| Platform | Cloudflare Workers, TypeScript, `npx wrangler` |
| Storage | None. Every run starts from scratch |
| Calendar access | Google Calendar API `freeBusy`, via a service account |
| Calendar permission | The university allows external sharing at **free/busy** only — times, no titles |
| Google auth library | `jose` (JWT signing) |
| Manual status | Left alone until the next window change (rule A) |
| Manual controls | No public URL. `npm run preview` locally; no `set`/`clear` commands |
| Interval | `RUN_EVERY_MINUTES`, default 5, all durations configured in minutes |

The earlier Python and Go implementations are removed; they remain in git
history.

## Non-goals

- Storage of any kind (KV, D1, Durable Objects, external databases).
- Reading event titles. Free/busy access does not expose them.
- A public HTTP endpoint on the Worker.
- `set` / `clear` commands. The Discord app already does this, and rule A
  respects it.
- More than one calendar.
- Writing to the calendar.

## Architecture

One Worker, `dc-status`, with a single `scheduled` handler.

### The timer

Cloudflare cron schedules are fixed in the Worker's configuration and cannot be
driven by a runtime variable. To make the interval a setting, the cron fires
**every minute** (`* * * * *`) and the handler exits immediately unless:

```
floor(scheduledTime / 60_000) % RUN_EVERY_MINUTES === 0
```

`scheduledTime` comes from the scheduled event, not the wall clock, so the check
is stable. Using minutes since the epoch rather than minute-of-hour keeps the
spacing even for intervals that do not divide 60 (e.g. 7).