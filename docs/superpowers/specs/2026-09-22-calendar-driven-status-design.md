# Calendar-driven Discord status — design

Date: 2026-09-22
Status: approved, ready for implementation planning

## Problem

The Discord custom status bubble is set by hand several times a day — `на паре`
when a class starts, `в пути` when travelling, empty otherwise. The university
timetable already lives in Google Calendar, so the bubble can be derived from it
instead of typed.

An earlier iteration of this repo already sets the bubble from a hardcoded
constant (`main.go`). This design replaces that constant with the calendar and
adds the scheduling around it.

## Goals

- Derive the bubble from the university Google Calendar with no daily interaction.
- Respect a status set by hand rather than stomping it.
- Never leave a stale or wrong status behind when something fails.
- Keep the window logic testable without network access.

## Non-goals

- OAuth / Google Cloud project setup. The secret iCal URL covers the need.
- Multiple calendars. One timetable calendar only.
- Rich Presence ("Playing …"). The user chose the real custom-status bubble.
- Platforms other than macOS. Scheduling assumes `launchd`.
- Writing to the calendar. Read-only.

## Accepted risk

Setting the custom status uses a user token against Discord's private API, which
is self-botting and technically against Discord's ToS. The user was informed and
accepted this. Practical risk is low for infrequent, benign personal writes. The
mitigation that matters is volume: writes happen only on an actual state change,
not on every tick.

## Architecture

A single Go binary with four subcommands. No daemon process; `launchd` invokes
the one-shot `sync` on an interval.

```
launchd (every 5 min) ──> dc sync ──> calendar cache (refreshed every 3h)
                                 └──> Discord settings API (written only on change)
```

Two independent cadences:

| Cadence | What happens | Why |
|---|---|---|
| ~5 min | Re-evaluate the window from the local cache | Cheap, local, keeps the bubble accurate to the minute |
| ~3 h | Re-fetch the iCal feed from Google | Timetables change rarely; ~8 fetches/day |

### Files

| File | Responsibility |
|---|---|
| `main.go` | CLI dispatch only |
| `config.go` | `.env` loading, defaults, home-directory resolution |
| `discord.go` | Discord settings API: read current status, write status |
| `calendar.go` | Fetch iCal, cache to disk, parse, expand recurrences into a window |
| `schedule.go` | Pure decision logic — no I/O |
| `state.go` | Last-written status and manual-override tracking |
| `schedule_test.go` | Table-driven tests for the decision logic |

`schedule.go` is deliberately pure: it takes `(now, []Event, Windows)` and
returns a decision. Every interesting edge case is therefore testable with a
fixed clock and literal event slices.

### Directory resolution

`launchd` runs jobs with an unpredictable working directory, so paths are never
relative to the CWD. The config/cache/state directory is resolved as:

1. `$DC_STATUS_HOME` if set
2. else the directory containing the executable
3. else the current directory

All of `.env`, `calendar.ics`, `cache.json` and `state.json` live there.

## Decision logic

### Types

```go
type Event struct {
    Start, End time.Time
    Summary    string
}

type Decision struct {
    Text      string
    Emoji     string
    ExpiresAt time.Time // zero means no expiry
    Reason    string    // human-readable, for preview and logs
}
```

### Blocks

Classes are first grouped into **blocks**. Sorted by start time, a class joins
the current block if it starts less than `BREAK_MAX` (default 2h) after the
block's end; otherwise it opens a new block. Overlapping classes always merge.
A block spans from its first class's start to its last class's end, breaks
included.

Blocks exist because of breaks. Scored per class, a 15-minute break between two
classes sits inside the first class's post-window and the next class's
pre-window, so it would read as `в пути` — and the bubble would flip
`на паре` → `в пути` → `на паре` several times a day. Scored per block, a break
is simply part of the block.

### Rules

Evaluated against blocks, strictly in order; the first match wins.

1. **Inside a block** — `Start <= now < End`, breaks included
   → `на паре`, 📚
2. **Within the pre-window** — `Start-2h <= now < Start`
   → `в пути`, 🚗
3. **Within the post-window** — `End <= now < End+2h`
   → `в пути`, 🚗
4. **Otherwise** → cleared

Travel therefore only appears before a day's first class and after its last,
plus around any gap of at least `BREAK_MAX`. Example, classes at 09:00–10:30,
10:45–12:15 and 12:30–14:00:

| Time | Bubble |
|---|---|
| 07:00–09:00 | 🚗 в пути |
| 09:00–14:00 | 📚 на паре (breaks included) |
| 14:00–16:00 | 🚗 в пути |
| after 16:00 | cleared |

With the default `BREAK_MAX` equal to the pre-window, a block's pre-window can
never overlap an earlier block's classes. The rule ordering still guarantees
being in class wins if the two settings are tuned apart.

### Expiry

`ExpiresAt` is a safety net: if the job stops running, Discord clears the bubble
on its own rather than leaving it stale overnight.

It is **not** simply the end of the matching window. It is the next moment at
which the decision would actually change, computed by:

1. Collecting all candidate boundary times after `now` — for every block, its
   `Start`, `End`, `Start-2h` and `End+2h`.
2. Sorting them ascending.
3. Returning the first boundary at which re-running the rules yields a different
   text/emoji than the current decision.

The third step is the important one. Two adjacent transit windows — the
post-window of one block overlapping the pre-window of the next — produce a
boundary where the decision does *not* change. Expiring there would clear a
still-valid `в пути`. Evaluating the rules at each boundary and skipping
no-change boundaries avoids that.

If no future boundary changes the decision, `ExpiresAt` is zero. That only
happens in the cleared state, which needs no expiry.

## Manual override

`state.json` records what the job last wrote. On each `sync`, the job reads the
current status from Discord and compares:

| Discord's current status | Interpretation | Action |
|---|---|---|
| Matches last-written | The job owns the bubble | Free to update |
| Empty / null | Naturally expired or cleared | Free to update |
| Non-empty and different | Set by hand | Back off |

An empty bubble deliberately does **not** count as an override. Treating it as
one would mean clearing the bubble once permanently disables the automation,
which is a trap.

When backing off, the job records the decision signature that was current at
detection time. It resumes as soon as the calendar produces a *different*
decision — i.e. at the next window change — rather than requiring manual
intervention.

## Calendar handling

### Fetch and cache

`ICAL_URL` is Google Calendar's "Secret address in iCal format". The raw
response is cached to `calendar.ics`, with `cache.json` holding the fetch
timestamp and the `ETag`. Within the 3h TTL the cache is used directly; past it,
the feed is re-fetched using `If-None-Match` so an unchanged calendar costs a
304 rather than a full body.

### Parsing

`github.com/apognu/gocal` (v0.9.1) is the primary choice: it parses iCal and
expands recurrences into an explicit time range, which is precisely the query
needed. `github.com/arran4/golang-ical` + `github.com/teambition/rrule-go` are
the fallback if gocal's RRULE coverage proves insufficient against the real
feed. This decision is revisited against the user's actual calendar during
implementation, not assumed.

Recurrence expansion is non-optional. Google's iCal export does not expand
recurring events — it emits one `VEVENT` plus an `RRULE`. A parser ignoring
RRULE sees a whole semester as a single week-one class and nothing after.
`EXDATE` (a cancelled week) and `RECURRENCE-ID` (a single class moved) must be
honoured too, or the bubble will claim `на паре` on a day with no class.

Events are expanded over `[now-24h, now+48h]` — wide enough to cover the
post-window of yesterday's last class and tomorrow's pre-window, narrow enough
to stay cheap.

### Filtering

Every event on the calendar counts as a class; the user confirmed the timetable
is a dedicated calendar. Two exclusions:

- **All-day events** are skipped. A "Semester Week 3" banner would otherwise pin
  `на паре` for 28 hours straight.
- **`STATUS:CANCELLED`** events are skipped.

### Timezones

Event times are resolved from their `TZID` rather than assumed to be local or
UTC. `time/tzdata` is imported so the zone database is embedded in the binary
and lookups work regardless of the host's tzdata.

## Failure behaviour

The governing rule: **failure never clears the bubble.** Clearing is only ever
the result of the calendar affirmatively saying there is nothing on.

| Failure | Behaviour |
|---|---|
| Fetch fails, cache exists | Use the cached feed, warn on stderr that it is stale |
| Fetch fails, no cache | Exit non-zero, do not touch Discord |
| Malformed iCal | Exit non-zero, keep the previous cache, do not touch Discord |
| Discord read fails | Exit non-zero without writing |
| Discord write fails | Exit non-zero, do not record it as written in state |
| Job stops running entirely | Discord's `expires_at` clears the bubble at the next boundary |

Writes are skipped when the computed decision already matches what Discord
shows, so a 5-minute cadence produces a handful of writes a day rather than 288.

### Two API details to confirm, not assume

Both are verified against the live API during step 1 of the sequencing, before
anything is built on top of them:

- **Emoji.** A unicode emoji is sent as the literal character in
  `custom_status.emoji_name`, with `emoji_id` null. Confirm the bubble actually
  renders it rather than showing the text only.
- **Expiry.** `custom_status.expires_at` is expected to accept an RFC3339
  timestamp. Confirm Discord both accepts it and honours it; if it does not, the
  expiry safety net is dropped and the `launchd` job's reliability becomes the
  only guard against a stale bubble. The rest of the design is unaffected.

## CLI

| Command | Behaviour |
|---|---|
| `dc sync` | One-shot: evaluate and update if needed. What launchd calls. |
| `dc preview` | Print the decision timeline for the next 24h. Never writes. |
| `dc set <text>` | Set the bubble by hand. Marks an override. |
| `dc clear` | Clear the bubble and any override. |

`preview` is the verification tool: it prints each segment with its time range,
text and reason, so the window logic can be checked against a real timetable
before any background job is trusted with it.

## Configuration

`.env`, in the resolved home directory:

| Key | Required | Default | Meaning |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | — | Discord user token |
| `ICAL_URL` | yes | — | Secret iCal address |
| `TRANSIT_BEFORE` | no | `2h` | Pre-class transit window |
| `TRANSIT_AFTER` | no | `2h` | Post-class transit window |
| `BREAK_MAX` | no | `2h` | Longest gap still counted as a break inside one block |
| `CACHE_TTL` | no | `3h` | Calendar re-fetch interval |
| `TEXT_IN_CLASS` | no | `на паре` | Bubble text during a class |
| `TEXT_TRANSIT` | no | `в пути` | Bubble text while travelling |
| `EMOJI_IN_CLASS` | no | `📚` | Emoji during a class |
| `EMOJI_TRANSIT` | no | `🚗` | Emoji while travelling |

Durations parse via `time.ParseDuration`.

## Testing

`schedule.go` being pure makes the decision table directly testable. Cases:

- Single class: before, at start, mid, at end, in post-window, after.
- 10–30 minute breaks between classes → `на паре` throughout, never `в пути`.
- Gap exactly `BREAK_MAX` vs just under → splits into two blocks vs one.
- Gap longer than `BREAK_MAX` → `в пути` between the two blocks.
- `BREAK_MAX` tuned shorter than `TRANSIT_BEFORE` → `на паре` still wins overlaps.
- Adjacent transit windows → expiry skips the no-change boundary.
- Simultaneous overlapping classes → one decision, latest end respected.
- Day with no events → cleared, zero expiry.
- All-day event present → ignored.
- Cancelled event present → ignored.
- Events in a non-local timezone → boundaries land at the right wall-clock time.
- Midnight-spanning event.

Boundary times are tested at exact equality, since `Start <= now < End` makes the
endpoints the cases most likely to be wrong.

Calendar parsing is tested against checked-in `.ics` fixtures including an RRULE
series with an EXDATE and a RECURRENCE-ID override. The Discord client sits
behind an interface so `sync` can be tested with a fake — verifying in
particular that a no-change decision produces no write, and that a detected
override produces no write.

## Implementation sequencing

1. Extract the existing Discord code from `main.go` into `discord.go`, add the
   settings read, put it behind an interface. No behaviour change.
2. `schedule.go` plus its tests. Pure, no network, TDD.
3. `calendar.go`: fetch, cache, parse, expand. Verify library choice against the
   real feed here.
4. `state.go` and override handling.
5. Wire up `sync` and `preview`.
6. Verify `preview` against the real timetable.
7. `launchd` plist, only once `preview` output is confirmed correct.

Step 6 is a gate, not a formality: the background job is not installed until the
window logic is confirmed correct against real data.

## Future, explicitly out of scope

- Per-event status text driven by the event title.
- Keyword rules mapping event names to different bubbles.
- A `pause` command suspending automation for a fixed duration.
