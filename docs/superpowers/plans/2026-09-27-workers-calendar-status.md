# Workers Calendar Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stateless Cloudflare Worker that, on a timer, reads the user's university calendar (free/busy, via a Google service account), reads the current Discord custom status, and writes `📚 на паре` / `🚗 в пути` / clear only when it needs to change.

**Architecture:** One Worker fired by an every-minute cron with an in-code gate (`RUN_EVERY_MINUTES`). Each run starts from nothing: Google token → `freeBusy` for now ± 24h → Discord read → pure decision (`schedule.ts`) → update decision (`sync.ts`) → optional Discord write. `google.ts` and `discord.ts` take `fetch` as a parameter so every test injects a fake; `schedule.ts` and the decision half of `sync.ts` are pure functions of their arguments.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers via wrangler 4, `jose` 6 (RS256 JWT for the service account), vitest 5 (Node environment, no network), `tsx` for the local preview script, Node 26.

**Spec:** `docs/superpowers/specs/2026-09-27-workers-calendar-status-design.md`

## Global Constraints

- No storage of any kind: no KV, D1, Durable Objects, or external database. Every run starts from nothing.
- No HTTP endpoint. The Worker exports only a `scheduled` handler.
- Cron is `* * * * *`; the run proceeds only when `floor(scheduledTime / 60 000) mod RUN_EVERY_MINUTES == 0`.
- All duration settings are **whole minutes**: `RUN_EVERY_MINUTES` (5), `TRANSIT_BEFORE_MINUTES` (120), `TRANSIT_AFTER_MINUTES` (120), `BREAK_MAX_MINUTES` (120).
- Default labels: `TEXT_IN_CLASS` = `на паре`, `TEXT_TRANSIT` = `в пути`, `EMOJI_IN_CLASS` = `📚`, `EMOJI_TRANSIT` = `🚗`, `TIMEZONE` = `Asia/Tashkent` (display only).
- Google: service account, scope `https://www.googleapis.com/auth/calendar.readonly`, `freeBusy` over `[now − 24h, now + 24h]`. A 200 with `errors` for the calendar, or no entry for it, is a failure.
- Discord: `GET`/`PATCH https://discord.com/api/v9/users/@me/settings`, body carries **only** `custom_status`. Headers: `Authorization`, `Content-Type: application/json`, `User-Agent: dc-status/1.0`.
- **A failure never clears or changes the bubble.** Every error path stops before the write.
- Secrets (`DISCORD_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_KEY`, `CALENDAR_ID`) live in `wrangler secret` / `.dev.vars` and are never logged or committed.
- Package versions to install: `jose@^6.2`, `wrangler@^4.142`, `typescript@^5.9`, `vitest@^5.0`, `tsx@^4.23`, `@types/node@^26`.
- Live checkpoints at Tasks 2, 4 and 7 are gates: do not proceed past them without the stated confirmation.

## Review Focus

Inputs the spec implies but no requirement names outright. Each has its test in the owning task.

1. **Google returns a zero-length or inverted busy range** (`end <= start`) — expected: ignored, never a crash or a phantom block. → Task 3, `mergeBlocks` test.
2. **`RUN_EVERY_MINUTES` is `0`, `abc` or `5.5`** — expected: a clear config error before any network call, never a modulo-by-zero that runs every minute. → Task 5 tests.
3. **The service-account secret is not JSON, or lacks `private_key`** (typical after a bad paste into `.dev.vars`) — expected: an error naming the field, not a cryptic `jose` failure. → Task 5 tests.
4. **Cloudflare fires the cron a few seconds after the minute** (`scheduledTime` = 09:05:03) — expected: the gate still treats it as minute 09:05 and runs. → Task 1 gate test.
5. **`TIMEZONE` is misspelled** — expected: a config error, not a runtime throw inside `Intl.DateTimeFormat` while formatting the log line after a successful write. → Task 5 test.

---

### Task 1: Scaffold the project and the timer gate

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`, `.dev.vars`
- Create: `src/gate.ts`
- Test: `test/gate.test.ts`

**Interfaces:**
- Produces: `shouldRun(scheduledTimeMs: number, runEveryMinutes: number): boolean` — Task 8 calls it from the `scheduled` handler.

- [ ] **Step 1: Initialise npm and install dependencies**

Run from the repo root:

```bash
npm init -y >/dev/null
npm install jose@^6.2
npm install -D wrangler@^4.142 typescript@^5.9 vitest@^5.0 tsx@^4.23 @types/node@^26
```

Expected: `package.json`, `package-lock.json` and `node_modules/` appear. `node_modules/` is already git-ignored.

- [ ] **Step 2: Write `package.json` scripts and module type**

Replace the generated `package.json` with (keep the `dependencies` / `devDependencies` blocks npm wrote):

```json
{
  "name": "dc-status",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "preview": "tsx scripts/preview.ts",
    "check:discord": "tsx scripts/check-discord.ts",
    "check:google": "tsx scripts/check-google.ts",
    "dev": "wrangler dev --test-scheduled",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "scripts", "test"]
}
```

`@types/node` supplies `fetch`, `Response`, `atob` and `process`, which is all the code needs in both Node and Workers. The one Workers-only type, `ScheduledController`, is declared locally in Task 8, so `@cloudflare/workers-types` is not needed.

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Write `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "dc-status",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "triggers": { "crons": ["* * * * *"] },
  "observability": { "enabled": true },
  "vars": {
    "RUN_EVERY_MINUTES": "5",
    "TRANSIT_BEFORE_MINUTES": "120",
    "TRANSIT_AFTER_MINUTES": "120",
    "BREAK_MAX_MINUTES": "120",
    "TEXT_IN_CLASS": "на паре",
    "TEXT_TRANSIT": "в пути",
    "EMOJI_IN_CLASS": "📚",
    "EMOJI_TRANSIT": "🚗",
    "TIMEZONE": "Asia/Tashkent"
  }
}
```

If a later `wrangler deploy` says the `compatibility_date` is newer than the installed runtime supports, lower it to the date wrangler names in that message.

- [ ] **Step 6: Create `.dev.vars` from the existing `.env`**

```bash
cp .env .dev.vars
git check-ignore .dev.vars   # must print .dev.vars
```

`.dev.vars` now holds `DISCORD_TOKEN=…`. Task 4 adds the two Google secrets.

- [ ] **Step 7: Write the failing gate test**

`test/gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldRun } from "../src/gate";

const MIN = 60_000;

describe("shouldRun", () => {
  it("runs on minutes divisible by the interval", () => {
    expect(shouldRun(100 * MIN, 5)).toBe(true);
    expect(shouldRun(105 * MIN, 5)).toBe(true);
  });

  it("skips minutes not divisible by the interval", () => {
    expect(shouldRun(101 * MIN, 5)).toBe(false);
    expect(shouldRun(104 * MIN, 5)).toBe(false);
  });

  it("treats a few seconds past the minute as that minute", () => {
    expect(shouldRun(105 * MIN + 3_400, 5)).toBe(true);
    expect(shouldRun(106 * MIN + 3_400, 5)).toBe(false);
  });

  it("runs every minute when the interval is 1", () => {
    for (let m = 0; m < 10; m++) expect(shouldRun(m * MIN, 1)).toBe(true);
  });

  it("works for an interval that does not divide 60", () => {
    expect(shouldRun(63 * MIN, 7)).toBe(true);
    expect(shouldRun(64 * MIN, 7)).toBe(false);
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/gate'` (or similar resolution error).

- [ ] **Step 9: Write `src/gate.ts`**

```ts
/** True when the scheduled minute is a multiple of the run interval. */
export function shouldRun(scheduledTimeMs: number, runEveryMinutes: number): boolean {
  return Math.floor(scheduledTimeMs / 60_000) % runEveryMinutes === 0;
}
```

- [ ] **Step 10: Run the tests and the type check**

Run: `npm test && npm run typecheck`
Expected: 5 tests pass; `tsc` prints nothing.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts wrangler.jsonc src/gate.ts test/gate.test.ts
git commit -m "Scaffold Workers project with timer gate"
```

---

### Task 2: Discord client and live emoji/expiry checkpoint

**Files:**
- Create: `src/discord.ts`, `scripts/check-discord.ts`
- Test: `test/discord.test.ts`

**Interfaces:**
- Produces:
  - `type FetchFn = (input: string, init?: RequestInit) => Promise<Response>`
  - `interface CustomStatus { text: string; emoji: string; expiresAt: Date | null }`
  - `class DiscordError extends Error { status?: number }`
  - `readStatus(token: string, fetchFn: FetchFn): Promise<CustomStatus | null>`
  - `writeStatus(token: string, status: CustomStatus | null, fetchFn: FetchFn): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`test/discord.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DiscordError, readStatus, writeStatus, type FetchFn } from "../src/discord";

const URL = "https://discord.com/api/v9/users/@me/settings";

function fakeFetch(status: number, body?: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return { fn, calls };
}

describe("readStatus", () => {
  it("parses a set status", async () => {
    const { fn, calls } = fakeFetch(200, {
      custom_status: { text: "на паре", emoji_name: "📚", emoji_id: null, expires_at: "2026-09-28T09:00:00.000Z" },
    });
    const status = await readStatus("tok", fn);
    expect(status).toEqual({ text: "на паре", emoji: "📚", expiresAt: new Date("2026-09-28T09:00:00.000Z") });
    expect(calls[0].url).toBe(URL);
    expect(calls[0].init?.method).toBe("GET");
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("tok");
  });

  it("returns null when custom_status is null", async () => {
    const { fn } = fakeFetch(200, { custom_status: null });
    expect(await readStatus("tok", fn)).toBeNull();
  });

  it("returns empty fields when text and emoji are null", async () => {
    const { fn } = fakeFetch(200, { custom_status: { text: null, emoji_name: null, expires_at: null } });
    expect(await readStatus("tok", fn)).toEqual({ text: "", emoji: "", expiresAt: null });
  });

  it.each([401, 403, 429, 500])("throws DiscordError with status %i", async (code) => {
    const { fn } = fakeFetch(code, { message: "nope" });
    await expect(readStatus("tok", fn)).rejects.toMatchObject({ name: "DiscordError", status: code });
  });
});

describe("writeStatus", () => {
  it("PATCHes only custom_status when setting", async () => {
    const { fn, calls } = fakeFetch(200, {});
    await writeStatus("tok", { text: "в пути", emoji: "🚗", expiresAt: new Date("2026-09-28T09:00:00.000Z") }, fn);
    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      custom_status: { text: "в пути", emoji_name: "🚗", emoji_id: null, expires_at: "2026-09-28T09:00:00.000Z" },
    });
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("Authorization")).toBe("tok");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("User-Agent")).toBe("dc-status/1.0");
  });

  it("sends custom_status: null when clearing", async () => {
    const { fn, calls } = fakeFetch(200, {});
    await writeStatus("tok", null, fn);
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ custom_status: null });
  });

  it("sends emoji_name null when the emoji is empty", async () => {
    const { fn, calls } = fakeFetch(200, {});
    await writeStatus("tok", { text: "x", emoji: "", expiresAt: null }, fn);
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      custom_status: { text: "x", emoji_name: null, emoji_id: null, expires_at: null },
    });
  });

  it("throws DiscordError on a failed write", async () => {
    const { fn } = fakeFetch(500);
    await expect(writeStatus("tok", null, fn)).rejects.toBeInstanceOf(DiscordError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/discord.test.ts`
Expected: FAIL — cannot find module `../src/discord`.

- [ ] **Step 3: Write `src/discord.ts`**

```ts
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface CustomStatus {
  text: string;
  emoji: string;
  expiresAt: Date | null;
}

export class DiscordError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "DiscordError";
  }
}

const SETTINGS_URL = "https://discord.com/api/v9/users/@me/settings";

function headers(token: string): Record<string, string> {
  return {
    Authorization: token,
    "Content-Type": "application/json",
    "User-Agent": "dc-status/1.0",
  };
}

interface RawCustomStatus {
  text?: string | null;
  emoji_name?: string | null;
  expires_at?: string | null;
}

/** Reads the current custom status; null when none is set. */
export async function readStatus(token: string, fetchFn: FetchFn): Promise<CustomStatus | null> {
  const res = await fetchFn(SETTINGS_URL, { method: "GET", headers: headers(token) });
  if (!res.ok) throw new DiscordError(`Discord read failed: HTTP ${res.status}`, res.status);
  const body = (await res.json()) as { custom_status?: RawCustomStatus | null };
  const raw = body.custom_status;
  if (!raw) return null;
  return {
    text: raw.text ?? "",
    emoji: raw.emoji_name ?? "",
    expiresAt: raw.expires_at ? new Date(raw.expires_at) : null,
  };
}

/** Writes the custom status (null clears it). Touches nothing else in settings. */
export async function writeStatus(token: string, status: CustomStatus | null, fetchFn: FetchFn): Promise<void> {
  const custom_status = status
    ? {
        text: status.text,
        emoji_name: status.emoji || null,
        emoji_id: null,
        expires_at: status.expiresAt ? status.expiresAt.toISOString() : null,
      }
    : null;
  const res = await fetchFn(SETTINGS_URL, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify({ custom_status }),
  });
  if (!res.ok) throw new DiscordError(`Discord write failed: HTTP ${res.status}`, res.status);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- test/discord.test.ts && npm run typecheck`
Expected: 11 tests pass; no type errors.

- [ ] **Step 5: Write the live check script**

`scripts/check-discord.ts`:

```ts
import { readStatus, writeStatus } from "../src/discord";

process.loadEnvFile(".dev.vars");
const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN missing from .dev.vars");

const expiresAt = new Date(Date.now() + 10 * 60_000);
await writeStatus(token, { text: "в пути", emoji: "🚗", expiresAt }, fetch);
const back = await readStatus(token, fetch);

console.log("read back:", back);
console.log(`Open Discord: the bubble should show 🚗 в пути.`);
console.log(`It should disappear by itself at ${expiresAt.toLocaleTimeString()} (10 minutes from now).`);
```

- [ ] **Step 6: Run the live check — CHECKPOINT**

Run: `npm run check:discord`
Expected output: `read back: { text: 'в пути', emoji: '🚗', expiresAt: 2026-…Z }`.

Then the user confirms **both** in the Discord app:
1. The bubble shows the 🚗 emoji next to `в пути` (emoji renders via `emoji_name`).
2. Ten minutes later the bubble is empty (Discord honoured `expires_at`).

If 1 fails, stop and report — emoji handling needs a different field. If 2 fails, stop and report — the spec says the expiry safety net is then dropped (`expiresAt` sent as `null`); that is a spec change the user must approve before Task 3.

- [ ] **Step 7: Commit**

```bash
git add src/discord.ts scripts/check-discord.ts test/discord.test.ts
git commit -m "Add Discord custom status client"
```

---

### Task 3: Decision logic (`schedule.ts`)

**Files:**
- Create: `src/schedule.ts`
- Test: `test/schedule.test.ts`

**Interfaces:**
- Produces:
  - `interface Range { start: Date; end: Date }`
  - `interface Windows { transitBeforeMs: number; transitAfterMs: number; breakMaxMs: number }`
  - `interface Labels { textInClass: string; textTransit: string; emojiInClass: string; emojiTransit: string }`
  - `type Kind = "in-class" | "transit" | "clear"`
  - `interface Decision { kind: Kind; text: string; emoji: string; expiresAt: Date | null }`
  - `interface Segment { start: Date; end: Date; decision: Decision }`
  - `mergeBlocks(ranges: Range[], breakMaxMs: number): Range[]`
  - `decideKind(now: Date, blocks: Range[], w: Windows): Kind`
  - `nextChangeAt(now: Date, blocks: Range[], w: Windows): Date | null`
  - `decide(now: Date, ranges: Range[], w: Windows, labels: Labels): Decision`
  - `timeline(from: Date, to: Date, ranges: Range[], w: Windows, labels: Labels): Segment[]`

- [ ] **Step 1: Write the failing tests**

`test/schedule.test.ts`. All times are Tashkent wall-clock (`+05:00`) on 2026-09-28 unless a day offset is given.

```ts
import { describe, expect, it } from "vitest";
import {
  decide,
  decideKind,
  mergeBlocks,
  nextChangeAt,
  timeline,
  type Labels,
  type Range,
  type Windows,
} from "../src/schedule";

const H = 60 * 60 * 1000;
const W: Windows = { transitBeforeMs: 2 * H, transitAfterMs: 2 * H, breakMaxMs: 2 * H };
const L: Labels = { textInClass: "на паре", textTransit: "в пути", emojiInClass: "📚", emojiTransit: "🚗" };

/** at("09:00") → 2026-09-28 09:00 Tashkent; at("01:00", 1) → the next day. */
function at(hhmm: string, dayOffset = 0): Date {
  const d = new Date(`2026-09-28T${hhmm}:00+05:00`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d;
}
function range(from: string, to: string, dayOffsetTo = 0): Range {
  return { start: at(from), end: at(to, dayOffsetTo) };
}

const threeClasses: Range[] = [range("09:00", "10:30"), range("10:45", "12:15"), range("12:30", "14:00")];

describe("mergeBlocks", () => {
  it("joins classes separated by short breaks into one block", () => {
    expect(mergeBlocks(threeClasses, W.breakMaxMs)).toEqual([range("09:00", "14:00")]);
  });

  it("splits at a gap exactly equal to breakMax", () => {
    const ranges = [range("09:00", "10:30"), range("12:30", "14:00")];
    expect(mergeBlocks(ranges, W.breakMaxMs)).toEqual(ranges);
  });

  it("keeps one block at a gap just under breakMax", () => {
    const ranges = [range("09:00", "10:30"), range("12:29", "14:00")];
    expect(mergeBlocks(ranges, W.breakMaxMs)).toEqual([range("09:00", "14:00")]);
  });

  it("merges overlapping ranges and sorts unsorted input", () => {
    const ranges = [range("10:00", "12:00"), range("09:00", "11:00")];
    expect(mergeBlocks(ranges, W.breakMaxMs)).toEqual([range("09:00", "12:00")]);
  });

  it("ignores zero-length and inverted ranges", () => {
    const ranges = [range("09:00", "09:00"), range("11:00", "10:00"), range("13:00", "14:00")];
    expect(mergeBlocks(ranges, W.breakMaxMs)).toEqual([range("13:00", "14:00")]);
  });

  it("does not mutate its input", () => {
    const ranges = [range("10:45", "12:15"), range("09:00", "10:30")];
    const copy = ranges.map((r) => ({ start: new Date(r.start), end: new Date(r.end) }));
    mergeBlocks(ranges, W.breakMaxMs);
    expect(ranges).toEqual(copy);
  });
});

describe("decideKind — single class 09:00–10:30", () => {
  const blocks = mergeBlocks([range("09:00", "10:30")], W.breakMaxMs);
  it.each([
    ["06:59", "clear"],
    ["07:00", "transit"],
    ["08:59", "transit"],
    ["09:00", "in-class"],
    ["10:29", "in-class"],
    ["10:30", "transit"],
    ["12:29", "transit"],
    ["12:30", "clear"],
  ])("at %s → %s", (time, kind) => {
    expect(decideKind(at(time), blocks, W)).toBe(kind);
  });
});

describe("decideKind — breaks and gaps", () => {
  it("stays in-class through 10–30 minute breaks", () => {
    const blocks = mergeBlocks(threeClasses, W.breakMaxMs);
    expect(decideKind(at("10:35"), blocks, W)).toBe("in-class");
    expect(decideKind(at("12:20"), blocks, W)).toBe("in-class");
  });

  it("reads a gap longer than breakMax as transit", () => {
    const blocks = mergeBlocks([range("09:00", "10:30"), range("13:00", "14:30")], W.breakMaxMs);
    expect(decideKind(at("11:00"), blocks, W)).toBe("transit");
    expect(decideKind(at("12:00"), blocks, W)).toBe("transit");
  });

  it("gives rule 1 priority when breakMax is shorter than transitBefore", () => {
    const w: Windows = { ...W, breakMaxMs: 30 * 60 * 1000 };
    const blocks = mergeBlocks([range("09:00", "10:00"), range("11:00", "12:00")], w.breakMaxMs);
    expect(blocks).toHaveLength(2);
    expect(decideKind(at("09:30"), blocks, w)).toBe("in-class");
  });

  it("handles a block crossing midnight", () => {
    const blocks = mergeBlocks([range("23:00", "01:00", 1)], W.breakMaxMs);
    expect(decideKind(at("00:30", 1), blocks, W)).toBe("in-class");
    expect(decideKind(at("02:30", 1), blocks, W)).toBe("transit");
  });
});

describe("nextChangeAt", () => {
  it("skips a boundary where the kind does not change", () => {
    // post-window of the first block (ends 12:30) overlaps the pre-window of the second (starts 11:00)
    const blocks = mergeBlocks([range("09:00", "10:30"), range("13:00", "14:30")], W.breakMaxMs);
    expect(nextChangeAt(at("10:45"), blocks, W)).toEqual(at("13:00"));
  });

  it("returns null when nothing changes again", () => {
    const blocks = mergeBlocks([range("09:00", "10:30")], W.breakMaxMs);
    expect(nextChangeAt(at("12:30"), blocks, W)).toBeNull();
  });
});

describe("decide", () => {
  it("returns clear with no expiry on an empty day", () => {
    expect(decide(at("09:00"), [], W, L)).toEqual({ kind: "clear", text: "", emoji: "", expiresAt: null });
  });

  it("in-class expires at the end of the whole block", () => {
    expect(decide(at("10:35"), threeClasses, W, L)).toEqual({
      kind: "in-class",
      text: "на паре",
      emoji: "📚",
      expiresAt: at("14:00"),
    });
  });

  it("pre-window transit expires when the block starts", () => {
    expect(decide(at("07:30"), threeClasses, W, L)).toEqual({
      kind: "transit",
      text: "в пути",
      emoji: "🚗",
      expiresAt: at("09:00"),
    });
  });

  it("post-window transit expires two hours after the block", () => {
    expect(decide(at("15:00"), threeClasses, W, L).expiresAt).toEqual(at("16:00"));
  });
});

describe("timeline", () => {
  it("lists the segments of a class day", () => {
    const segs = timeline(at("06:00"), at("18:00"), threeClasses, W, L);
    expect(segs.map((s) => [s.start, s.end, s.decision.kind])).toEqual([
      [at("06:00"), at("07:00"), "clear"],
      [at("07:00"), at("09:00"), "transit"],
      [at("09:00"), at("14:00"), "in-class"],
      [at("14:00"), at("16:00"), "transit"],
      [at("16:00"), at("18:00"), "clear"],
    ]);
  });

  it("is a single clear segment on an empty day", () => {
    const segs = timeline(at("06:00"), at("18:00"), [], W, L);
    expect(segs).toHaveLength(1);
    expect(segs[0].decision.kind).toBe("clear");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/schedule.test.ts`
Expected: FAIL — cannot find module `../src/schedule`.

- [ ] **Step 3: Write `src/schedule.ts`**

```ts
export interface Range {
  start: Date;
  end: Date;
}

export interface Windows {
  transitBeforeMs: number;
  transitAfterMs: number;
  breakMaxMs: number;
}

export interface Labels {
  textInClass: string;
  textTransit: string;
  emojiInClass: string;
  emojiTransit: string;
}

export type Kind = "in-class" | "transit" | "clear";

export interface Decision {
  kind: Kind;
  text: string;
  emoji: string;
  expiresAt: Date | null;
}

export interface Segment {
  start: Date;
  end: Date;
  decision: Decision;
}

/**
 * Groups busy ranges into blocks: a range joins the current block when it
 * starts less than breakMaxMs after the block's end. Breaks inside a block
 * count as class time. Zero-length and inverted ranges are ignored.
 */
export function mergeBlocks(ranges: Range[], breakMaxMs: number): Range[] {
  const sorted = ranges
    .filter((r) => r.end.getTime() > r.start.getTime())
    .map((r) => ({ start: new Date(r.start), end: new Date(r.end) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const blocks: Range[] = [];
  for (const r of sorted) {
    const last = blocks.at(-1);
    if (last && r.start.getTime() - last.end.getTime() < breakMaxMs) {
      if (r.end > last.end) last.end = r.end;
    } else {
      blocks.push(r);
    }
  }
  return blocks;
}

/** Rules 1–4 from the spec, first match wins. */
export function decideKind(now: Date, blocks: Range[], w: Windows): Kind {
  const t = now.getTime();
  if (blocks.some((b) => b.start.getTime() <= t && t < b.end.getTime())) return "in-class";
  if (blocks.some((b) => b.start.getTime() - w.transitBeforeMs <= t && t < b.start.getTime())) return "transit";
  if (blocks.some((b) => b.end.getTime() <= t && t < b.end.getTime() + w.transitAfterMs)) return "transit";
  return "clear";
}

/** The next moment the kind actually changes, or null if it never does. */
export function nextChangeAt(now: Date, blocks: Range[], w: Windows): Date | null {
  const t = now.getTime();
  const current = decideKind(now, blocks, w);
  const candidates = blocks
    .flatMap((b) => [
      b.start.getTime() - w.transitBeforeMs,
      b.start.getTime(),
      b.end.getTime(),
      b.end.getTime() + w.transitAfterMs,
    ])
    .filter((c) => c > t)
    .sort((a, b) => a - b);
  for (const c of candidates) {
    if (decideKind(new Date(c), blocks, w) !== current) return new Date(c);
  }
  return null;
}

export function decide(now: Date, ranges: Range[], w: Windows, labels: Labels): Decision {
  const blocks = mergeBlocks(ranges, w.breakMaxMs);
  const kind = decideKind(now, blocks, w);
  if (kind === "clear") return { kind, text: "", emoji: "", expiresAt: null };
  const expiresAt = nextChangeAt(now, blocks, w);
  return kind === "in-class"
    ? { kind, text: labels.textInClass, emoji: labels.emojiInClass, expiresAt }
    : { kind, text: labels.textTransit, emoji: labels.emojiTransit, expiresAt };
}

/** Consecutive segments from `from` to `to`, one per stretch of unchanged kind. */
export function timeline(from: Date, to: Date, ranges: Range[], w: Windows, labels: Labels): Segment[] {
  const blocks = mergeBlocks(ranges, w.breakMaxMs);
  const segments: Segment[] = [];
  let cursor = from;
  while (cursor < to) {
    const next = nextChangeAt(cursor, blocks, w);
    const end = next && next < to ? next : to;
    segments.push({ start: cursor, end, decision: decide(cursor, ranges, w, labels) });
    cursor = end;
  }
  return segments;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- test/schedule.test.ts && npm run typecheck`
Expected: 26 tests pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/schedule.ts test/schedule.test.ts
git commit -m "Add block-based status decision logic"
```

---

### Task 4: Google client, user's Google setup, and live free/busy checkpoint

**Files:**
- Create: `src/google.ts`, `scripts/check-google.ts`
- Modify: `.dev.vars` (add `GOOGLE_SERVICE_ACCOUNT_KEY`, `CALENDAR_ID`)
- Test: `test/google.test.ts`

**Interfaces:**
- Consumes: `FetchFn` from `src/discord.ts`; `Range` from `src/schedule.ts`.
- Produces:
  - `interface ServiceAccountKey { client_email: string; private_key: string }`
  - `class GoogleError extends Error`
  - `getAccessToken(key: ServiceAccountKey, fetchFn: FetchFn, now?: Date): Promise<string>`
  - `fetchBusy(accessToken: string, calendarId: string, timeMin: Date, timeMax: Date, fetchFn: FetchFn): Promise<Range[]>`

- [ ] **Step 1: Write the failing tests**

`test/google.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { exportPKCS8, generateKeyPair, jwtVerify, type CryptoKey } from "jose";
import type { FetchFn } from "../src/discord";
import { fetchBusy, getAccessToken, GoogleError, type ServiceAccountKey } from "../src/google";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const CAL = "someone@university.edu";

function fakeFetch(status: number, body?: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return { fn, calls };
}

let key: ServiceAccountKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  publicKey = pair.publicKey;
  key = { client_email: "robot@project.iam.gserviceaccount.com", private_key: await exportPKCS8(pair.privateKey) };
});

describe("getAccessToken", () => {
  it("posts a signed JWT assertion and returns the access token", async () => {
    const { fn, calls } = fakeFetch(200, { access_token: "ya29.abc", expires_in: 3599 });
    const now = new Date("2026-09-28T04:00:00.000Z");

    const token = await getAccessToken(key, fn, now);

    expect(token).toBe("ya29.abc");
    expect(calls[0].url).toBe(TOKEN_URL);
    expect(calls[0].init?.method).toBe("POST");
    const params = new URLSearchParams(calls[0].init?.body as string);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const { payload, protectedHeader } = await jwtVerify(params.get("assertion")!, publicKey, {
      issuer: key.client_email,
      audience: TOKEN_URL,
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.scope).toBe("https://www.googleapis.com/auth/calendar.readonly");
    expect(payload.iat).toBe(Math.floor(now.getTime() / 1000));
    expect(payload.exp).toBe(payload.iat! + 3600);
  });

  it("throws GoogleError when the exchange fails", async () => {
    const { fn } = fakeFetch(400, { error: "invalid_grant" });
    await expect(getAccessToken(key, fn)).rejects.toBeInstanceOf(GoogleError);
  });

  it("throws GoogleError when the response has no access_token", async () => {
    const { fn } = fakeFetch(200, {});
    await expect(getAccessToken(key, fn)).rejects.toBeInstanceOf(GoogleError);
  });
});

describe("fetchBusy", () => {
  const timeMin = new Date("2026-09-27T04:00:00.000Z");
  const timeMax = new Date("2026-09-29T04:00:00.000Z");

  it("requests the window and parses busy ranges", async () => {
    const { fn, calls } = fakeFetch(200, {
      calendars: {
        [CAL]: {
          busy: [
            { start: "2026-09-28T04:00:00Z", end: "2026-09-28T05:30:00Z" },
            { start: "2026-09-28T05:45:00Z", end: "2026-09-28T07:15:00Z" },
          ],
        },
      },
    });

    const busy = await fetchBusy("ya29.abc", CAL, timeMin, timeMax, fn);

    expect(busy).toEqual([
      { start: new Date("2026-09-28T04:00:00Z"), end: new Date("2026-09-28T05:30:00Z") },
      { start: new Date("2026-09-28T05:45:00Z"), end: new Date("2026-09-28T07:15:00Z") },
    ]);
    expect(calls[0].url).toBe(FREEBUSY_URL);
    expect(calls[0].init?.method).toBe("POST");
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer ya29.abc");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: CAL }],
    });
  });

  it("returns an empty list when the calendar has no busy time", async () => {
    const { fn } = fakeFetch(200, { calendars: { [CAL]: { busy: [] } } });
    expect(await fetchBusy("t", CAL, timeMin, timeMax, fn)).toEqual([]);
  });

  it("treats a 200 with errors for the calendar as a failure (unshared calendar)", async () => {
    const { fn } = fakeFetch(200, {
      calendars: { [CAL]: { errors: [{ domain: "global", reason: "notFound" }], busy: [] } },
    });
    await expect(fetchBusy("t", CAL, timeMin, timeMax, fn)).rejects.toThrow(/notFound.*shared/);
  });

  it("treats a missing calendar entry as a failure", async () => {
    const { fn } = fakeFetch(200, { calendars: {} });
    await expect(fetchBusy("t", CAL, timeMin, timeMax, fn)).rejects.toBeInstanceOf(GoogleError);
  });

  it("throws GoogleError on an HTTP error", async () => {
    const { fn } = fakeFetch(403, { error: { message: "forbidden" } });
    await expect(fetchBusy("t", CAL, timeMin, timeMax, fn)).rejects.toBeInstanceOf(GoogleError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/google.test.ts`
Expected: FAIL — cannot find module `../src/google`.

- [ ] **Step 3: Write `src/google.ts`**

```ts
import { importPKCS8, SignJWT } from "jose";
import type { FetchFn } from "./discord";
import type { Range } from "./schedule";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export class GoogleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleError";
  }
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";

/** Exchanges a service-account JWT for a short-lived access token. */
export async function getAccessToken(key: ServiceAccountKey, fetchFn: FetchFn, now = new Date()): Promise<string> {
  const privateKey = await importPKCS8(key.private_key, "RS256");
  const iat = Math.floor(now.getTime() / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(key.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(privateKey);

  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) throw new GoogleError(`Google token exchange failed: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new GoogleError("Google token response had no access_token");
  return body.access_token;
}

interface FreeBusyResponse {
  calendars?: Record<
    string,
    {
      busy?: { start: string; end: string }[];
      errors?: { domain: string; reason: string }[];
    }
  >;
}

/** Busy ranges for one calendar between timeMin and timeMax. */
export async function fetchBusy(
  accessToken: string,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
  fetchFn: FetchFn,
): Promise<Range[]> {
  const res = await fetchFn(FREEBUSY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: calendarId }],
    }),
  });
  if (!res.ok) throw new GoogleError(`Google freeBusy failed: HTTP ${res.status}`);

  const body = (await res.json()) as FreeBusyResponse;
  const calendar = body.calendars?.[calendarId];
  if (!calendar) throw new GoogleError(`Google freeBusy response has no entry for ${calendarId}`);
  if (calendar.errors?.length) {
    const reasons = calendar.errors.map((e) => e.reason).join(", ");
    throw new GoogleError(`Google reports ${reasons} for the calendar — is it shared with the service account?`);
  }
  return (calendar.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- test/google.test.ts && npm run typecheck`
Expected: 8 tests pass; no type errors.

- [ ] **Step 5: Commit the client**

```bash
git add src/google.ts test/google.test.ts
git commit -m "Add Google service-account free/busy client"
```

- [ ] **Step 6: USER — create the Google service account**

The user does this in a browser (about 5 minutes):

1. Open https://console.cloud.google.com with the **personal** Google account (`erkinovit@gmail.com`). Click the project dropdown at the top → **New project** → name `dc-status` → **Create**, then select it.
2. Left menu → **APIs & Services → Library** → search `Google Calendar API` → **Enable**.
3. Left menu → **IAM & Admin → Service Accounts** → **Create service account** → name `dc-status` → **Create and continue** → **Done** (no roles are needed).
4. Click the new account → **Keys** tab → **Add key → Create new key → JSON → Create**. A `.json` file downloads. Move it out of the repo, e.g. to `~/dc-status-key.json`. Never commit it.
5. Open the file and copy the `client_email` value (looks like `dc-status@dc-status-xxxxx.iam.gserviceaccount.com`).
6. Open Google Calendar with the **university** account → hover the timetable calendar (the one named after you) → **⋮ → Settings and sharing** → **Share with specific people or groups → Add people** → paste the `client_email` → permission **See only free/busy (hide details)** → **Send**.
7. Remove the earlier test share with the personal Gmail if it is still there.

- [ ] **Step 7: Add the two Google secrets to `.dev.vars`**

Base64 keeps the multi-line JSON on one line with no quoting problems (`loadConfig` in Task 5 accepts both raw JSON and base64):

```bash
printf 'GOOGLE_SERVICE_ACCOUNT_KEY=%s\n' "$(base64 < ~/dc-status-key.json | tr -d '\n')" >> .dev.vars
printf 'CALENDAR_ID=%s\n' "<the university email address, e.g. name@university.edu>" >> .dev.vars
cut -d= -f1 .dev.vars   # prints DISCORD_TOKEN, GOOGLE_SERVICE_ACCOUNT_KEY, CALENDAR_ID
```

- [ ] **Step 8: Write the live check script**

`scripts/check-google.ts` (reads only; writes nothing anywhere):

```ts
import { fetchBusy, getAccessToken } from "../src/google";

process.loadEnvFile(".dev.vars");
const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const calendarId = process.env.CALENDAR_ID;
if (!rawKey || !calendarId) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY or CALENDAR_ID missing from .dev.vars");

const key = JSON.parse(Buffer.from(rawKey, "base64").toString("utf8"));
const token = await getAccessToken(key, fetch);

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const busy = await fetchBusy(token, calendarId, new Date(now - DAY), new Date(now + 6 * DAY), fetch);

const fmt = (d: Date) => d.toLocaleString("en-GB", { timeZone: "Asia/Tashkent" });
console.log(`${busy.length} busy ranges from yesterday through the next 6 days:`);
for (const r of busy) console.log(`  ${fmt(r.start)} → ${fmt(r.end)}`);
```

- [ ] **Step 9: Live free/busy check — CHECKPOINT**

Run: `npm run check:google`
Expected: a list of busy ranges the user recognises as this week's classes.

- `Google reports notFound … is it shared` → step 6.6 not done, or the wrong calendar was shared.
- `token exchange failed: HTTP 400/401` → the key file is wrong or the API is not enabled (step 6.2).
- `0 busy ranges` on a week with classes → the sharing is free/busy but the events are marked *Free*; the user checks one event's "Show me as" setting.

The user confirms the ranges match the real week before Task 5.

- [ ] **Step 10: Commit the check script**

```bash
git add scripts/check-google.ts
git commit -m "Add live free/busy check script"
```

---

### Task 5: Configuration (`config.ts`)

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `Windows`, `Labels` from `src/schedule.ts`; `ServiceAccountKey` from `src/google.ts`.
- Produces:
  - `interface Env { DISCORD_TOKEN?, GOOGLE_SERVICE_ACCOUNT_KEY?, CALENDAR_ID?, RUN_EVERY_MINUTES?, TRANSIT_BEFORE_MINUTES?, TRANSIT_AFTER_MINUTES?, BREAK_MAX_MINUTES?, TEXT_IN_CLASS?, TEXT_TRANSIT?, EMOJI_IN_CLASS?, EMOJI_TRANSIT?, TIMEZONE? }` — all `string | undefined`
  - `interface Config { discordToken: string; serviceAccount: ServiceAccountKey; calendarId: string; runEveryMinutes: number; windows: Windows; labels: Labels; timezone: string }`
  - `class ConfigError extends Error`
  - `loadConfig(env: Env): Config`

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type Env } from "../src/config";

const KEY = { client_email: "robot@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" };
const base: Env = {
  DISCORD_TOKEN: "tok",
  GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY),
  CALENDAR_ID: "me@university.edu",
};

describe("loadConfig", () => {
  it("applies defaults when only secrets are set", () => {
    const c = loadConfig(base);
    expect(c.discordToken).toBe("tok");
    expect(c.serviceAccount).toEqual(KEY);
    expect(c.calendarId).toBe("me@university.edu");
    expect(c.runEveryMinutes).toBe(5);
    expect(c.windows).toEqual({ transitBeforeMs: 7_200_000, transitAfterMs: 7_200_000, breakMaxMs: 7_200_000 });
    expect(c.labels).toEqual({ textInClass: "на паре", textTransit: "в пути", emojiInClass: "📚", emojiTransit: "🚗" });
    expect(c.timezone).toBe("Asia/Tashkent");
  });

  it("reads overrides", () => {
    const c = loadConfig({
      ...base,
      RUN_EVERY_MINUTES: "10",
      TRANSIT_BEFORE_MINUTES: "90",
      TRANSIT_AFTER_MINUTES: "30",
      BREAK_MAX_MINUTES: "45",
      TEXT_IN_CLASS: "на лекции",
      EMOJI_TRANSIT: "🚌",
      TIMEZONE: "Europe/Berlin",
    });
    expect(c.runEveryMinutes).toBe(10);
    expect(c.windows).toEqual({ transitBeforeMs: 5_400_000, transitAfterMs: 1_800_000, breakMaxMs: 2_700_000 });
    expect(c.labels.textInClass).toBe("на лекции");
    expect(c.labels.emojiTransit).toBe("🚌");
    expect(c.timezone).toBe("Europe/Berlin");
  });

  it("accepts a base64-encoded key", () => {
    const c = loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY: Buffer.from(JSON.stringify(KEY)).toString("base64") });
    expect(c.serviceAccount).toEqual(KEY);
  });

  it.each(["DISCORD_TOKEN", "GOOGLE_SERVICE_ACCOUNT_KEY", "CALENDAR_ID"] as const)("rejects a missing %s", (name) => {
    expect(() => loadConfig({ ...base, [name]: "" })).toThrow(new RegExp(`${name} is missing`));
    expect(() => loadConfig({ ...base, [name]: undefined })).toThrow(ConfigError);
  });

  it.each(["0", "abc", "5.5", "-5"])("rejects RUN_EVERY_MINUTES=%s", (v) => {
    expect(() => loadConfig({ ...base, RUN_EVERY_MINUTES: v })).toThrow(/RUN_EVERY_MINUTES/);
  });

  it("rejects a non-numeric window", () => {
    expect(() => loadConfig({ ...base, BREAK_MAX_MINUTES: "2h" })).toThrow(/BREAK_MAX_MINUTES/);
  });

  it("rejects a key that is not JSON", () => {
    expect(() => loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY: "not json" })).toThrow(/GOOGLE_SERVICE_ACCOUNT_KEY/);
  });

  it("rejects a key without private_key", () => {
    expect(() => loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify({ client_email: "x" }) })).toThrow(/private_key/);
  });

  it("rejects a key without client_email", () => {
    expect(() => loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify({ private_key: KEY.private_key }) })).toThrow(/client_email/);
  });

  it("rejects an empty label", () => {
    expect(() => loadConfig({ ...base, TEXT_TRANSIT: "  " })).toThrow(/TEXT_TRANSIT/);
  });

  it("rejects an invalid time zone", () => {
    expect(() => loadConfig({ ...base, TIMEZONE: "Asia/Tashkentt" })).toThrow(/TIMEZONE/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/config.test.ts`
Expected: FAIL — cannot find module `../src/config`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
import type { ServiceAccountKey } from "./google";
import type { Labels, Windows } from "./schedule";

export interface Env {
  DISCORD_TOKEN?: string;
  GOOGLE_SERVICE_ACCOUNT_KEY?: string;
  CALENDAR_ID?: string;
  RUN_EVERY_MINUTES?: string;
  TRANSIT_BEFORE_MINUTES?: string;
  TRANSIT_AFTER_MINUTES?: string;
  BREAK_MAX_MINUTES?: string;
  TEXT_IN_CLASS?: string;
  TEXT_TRANSIT?: string;
  EMOJI_IN_CLASS?: string;
  EMOJI_TRANSIT?: string;
  TIMEZONE?: string;
}

export interface Config {
  discordToken: string;
  serviceAccount: ServiceAccountKey;
  calendarId: string;
  runEveryMinutes: number;
  windows: Windows;
  labels: Labels;
  timezone: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(env: Env, name: keyof Env): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is missing`);
  return value;
}

function minutes(env: Env, name: keyof Env, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number of minutes, got "${raw}"`);
  const n = Number(raw);
  if (n <= 0) throw new ConfigError(`${name} must be greater than 0`);
  return n;
}

function label(env: Env, name: keyof Env, fallback: string): string {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw.trim() === "") throw new ConfigError(`${name} must not be empty`);
  return raw.trim();
}

function parseServiceAccount(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(atob(raw));
    } catch {
      throw new ConfigError("GOOGLE_SERVICE_ACCOUNT_KEY is neither JSON nor base64-encoded JSON");
    }
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (typeof key.client_email !== "string" || key.client_email === "") {
    throw new ConfigError("GOOGLE_SERVICE_ACCOUNT_KEY has no client_email");
  }
  if (typeof key.private_key !== "string" || !key.private_key.includes("BEGIN PRIVATE KEY")) {
    throw new ConfigError("GOOGLE_SERVICE_ACCOUNT_KEY has no valid private_key");
  }
  return { client_email: key.client_email, private_key: key.private_key };
}

function timezone(raw: string | undefined): string {
  const tz = raw?.trim() || "Asia/Tashkent";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    throw new ConfigError(`TIMEZONE "${tz}" is not a valid IANA time zone`);
  }
  return tz;
}

/** Validates env and applies defaults. Throws ConfigError before any network call. */
export function loadConfig(env: Env): Config {
  const MIN = 60_000;
  return {
    discordToken: required(env, "DISCORD_TOKEN"),
    serviceAccount: parseServiceAccount(required(env, "GOOGLE_SERVICE_ACCOUNT_KEY")),
    calendarId: required(env, "CALENDAR_ID"),
    runEveryMinutes: minutes(env, "RUN_EVERY_MINUTES", 5),
    windows: {
      transitBeforeMs: minutes(env, "TRANSIT_BEFORE_MINUTES", 120) * MIN,
      transitAfterMs: minutes(env, "TRANSIT_AFTER_MINUTES", 120) * MIN,
      breakMaxMs: minutes(env, "BREAK_MAX_MINUTES", 120) * MIN,
    },
    labels: {
      textInClass: label(env, "TEXT_IN_CLASS", "на паре"),
      textTransit: label(env, "TEXT_TRANSIT", "в пути"),
      emojiInClass: label(env, "EMOJI_IN_CLASS", "📚"),
      emojiTransit: label(env, "EMOJI_TRANSIT", "🚗"),
    },
    timezone: timezone(env.TIMEZONE),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- test/config.test.ts && npm run typecheck`
Expected: 16 tests pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "Add validated configuration loader"
```

---

### Task 6: Update decision and one full run (`sync.ts`)

**Files:**
- Create: `src/sync.ts`
- Test: `test/sync.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 5); `readStatus`, `writeStatus`, `CustomStatus`, `FetchFn` (Task 2); `getAccessToken`, `fetchBusy` (Task 4); `decide`, `Decision`, `Labels`, `Range` (Task 3).
- Produces:
  - `type HaveClass = "empty" | "ours" | "manual"`
  - `type Action = { type: "write"; status: CustomStatus | null } | { type: "none"; reason: "unchanged" | "manual" }`
  - `interface RunResult { now: Date; busy: Range[]; want: Decision; prev: Decision; have: CustomStatus | null; action: Action }`
  - `toStatus(d: Decision): CustomStatus | null`
  - `classify(have: CustomStatus | null, labels: Labels): HaveClass`
  - `statusEquals(a: CustomStatus | null, b: CustomStatus | null): boolean`
  - `planAction(want: Decision, prev: Decision, have: CustomStatus | null, labels: Labels): Action`
  - `runOnce(config: Config, fetchFn: FetchFn, now: Date, opts?: { dryRun?: boolean }): Promise<RunResult>`
  - `formatTime(d: Date, timezone: string): string`
  - `formatStatus(s: CustomStatus | null): string`
  - `formatDecision(d: Decision, timezone: string): string`
  - `formatRunLine(r: RunResult, timezone: string): string`

- [ ] **Step 1: Write the failing tests**

`test/sync.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import type { Config } from "../src/config";
import type { CustomStatus, FetchFn } from "../src/discord";
import type { Decision, Labels } from "../src/schedule";
import { classify, formatRunLine, planAction, runOnce, statusEquals, toStatus } from "../src/sync";

const L: Labels = { textInClass: "на паре", textTransit: "в пути", emojiInClass: "📚", emojiTransit: "🚗" };
const H = 3_600_000;

const inClass: Decision = { kind: "in-class", text: "на паре", emoji: "📚", expiresAt: new Date("2026-09-28T09:00:00Z") };
const transit: Decision = { kind: "transit", text: "в пути", emoji: "🚗", expiresAt: new Date("2026-09-28T11:00:00Z") };
const clear: Decision = { kind: "clear", text: "", emoji: "", expiresAt: null };

const ours: CustomStatus = { text: "в пути", emoji: "🚗", expiresAt: null };
const manual: CustomStatus = { text: "болею", emoji: "", expiresAt: null };

describe("classify", () => {
  it.each([
    [null, "empty"],
    [{ text: "", emoji: "", expiresAt: null }, "empty"],
    [{ text: "  ", emoji: "📚", expiresAt: null }, "empty"],
    [{ text: "на паре", emoji: "📚", expiresAt: null }, "ours"],
    [{ text: " в пути ", emoji: "", expiresAt: null }, "ours"],
    [{ text: "болею", emoji: "🤒", expiresAt: null }, "manual"],
  ] as const)("%j → %s", (have, expected) => {
    expect(classify(have, L)).toBe(expected);
  });
});

describe("statusEquals", () => {
  it("compares text and emoji, not expiry", () => {
    expect(statusEquals({ text: "в пути", emoji: "🚗", expiresAt: new Date(1) }, { text: "в пути", emoji: "🚗", expiresAt: null })).toBe(true);
    expect(statusEquals({ text: "в пути", emoji: "🚗", expiresAt: null }, { text: "в пути", emoji: "", expiresAt: null })).toBe(false);
    expect(statusEquals(null, { text: "", emoji: "", expiresAt: null })).toBe(true);
    expect(statusEquals(null, manual)).toBe(false);
  });
});

describe("planAction", () => {
  it("does nothing when Discord already shows the wanted status", () => {
    expect(planAction(inClass, transit, { text: "на паре", emoji: "📚", expiresAt: null }, L)).toEqual({ type: "none", reason: "unchanged" });
    expect(planAction(clear, transit, null, L)).toEqual({ type: "none", reason: "unchanged" });
  });

  it("writes when the bubble is empty", () => {
    expect(planAction(inClass, inClass, null, L)).toEqual({ type: "write", status: toStatus(inClass) });
  });

  it("writes over its own previous status", () => {
    expect(planAction(inClass, transit, ours, L)).toEqual({ type: "write", status: toStatus(inClass) });
    expect(planAction(clear, transit, ours, L)).toEqual({ type: "write", status: null });
  });

  it("leaves a manual status alone when no window changed", () => {
    expect(planAction(inClass, inClass, manual, L)).toEqual({ type: "none", reason: "manual" });
    expect(planAction(clear, clear, manual, L)).toEqual({ type: "none", reason: "manual" });
  });

  it("replaces a manual status at a window change", () => {
    expect(planAction(inClass, transit, manual, L)).toEqual({ type: "write", status: toStatus(inClass) });
  });

  it("clears a manual status when the window changes to clear", () => {
    expect(planAction(clear, transit, manual, L)).toEqual({ type: "write", status: null });
  });

  it("applies the same rows when transit is wanted", () => {
    expect(planAction(transit, clear, null, L)).toEqual({ type: "write", status: toStatus(transit) });
    expect(planAction(transit, inClass, manual, L)).toEqual({ type: "write", status: toStatus(transit) });
    expect(planAction(transit, transit, manual, L)).toEqual({ type: "none", reason: "manual" });
    expect(planAction(transit, transit, ours, L)).toEqual({ type: "none", reason: "unchanged" });
  });
});

// --- runOnce against a routed fake fetch ---------------------------------

type Route = (init?: RequestInit) => { status: number; body?: unknown };

function router(routes: Record<string, Route>) {
  const calls: { key: string; body?: string }[] = [];
  const fn: FetchFn = async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push({ key, body: init?.body as string | undefined });
    const route = routes[key];
    if (!route) throw new Error(`unexpected request ${key}`);
    const { status, body } = route(init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  const count = (prefix: string) => calls.filter((c) => c.key.startsWith(prefix)).length;
  return { fn, calls, count };
}

const TOKEN = "POST https://oauth2.googleapis.com/token";
const FREEBUSY = "POST https://www.googleapis.com/calendar/v3/freeBusy";
const DC_GET = "GET https://discord.com/api/v9/users/@me/settings";
const DC_PATCH = "PATCH https://discord.com/api/v9/users/@me/settings";
const CAL = "me@university.edu";

let config: Config;
// now = 09:30 Tashkent on a day with a class 09:00–10:30 (04:00–05:30Z)
const now = new Date("2026-09-28T04:30:00Z");
const busyToday = [{ start: "2026-09-28T04:00:00Z", end: "2026-09-28T05:30:00Z" }];

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  config = {
    discordToken: "tok",
    serviceAccount: { client_email: "robot@p.iam.gserviceaccount.com", private_key: await exportPKCS8(pair.privateKey) },
    calendarId: CAL,
    runEveryMinutes: 5,
    windows: { transitBeforeMs: 2 * H, transitAfterMs: 2 * H, breakMaxMs: 2 * H },
    labels: L,
    timezone: "Asia/Tashkent",
  };
});

function happyRoutes(have: unknown, busy = busyToday): Record<string, Route> {
  return {
    [TOKEN]: () => ({ status: 200, body: { access_token: "ya29" } }),
    [FREEBUSY]: () => ({ status: 200, body: { calendars: { [CAL]: { busy } } } }),
    [DC_GET]: () => ({ status: 200, body: { custom_status: have } }),
    [DC_PATCH]: () => ({ status: 200, body: {} }),
  };
}

describe("runOnce", () => {
  it("writes на паре when the bubble is empty during a class", async () => {
    const r = router(happyRoutes(null));
    const result = await runOnce(config, r.fn, now);
    expect(result.action).toEqual({ type: "write", status: { text: "на паре", emoji: "📚", expiresAt: new Date("2026-09-28T05:30:00Z") } });
    expect(r.count(DC_PATCH)).toBe(1);
    expect(JSON.parse(r.calls.find((c) => c.key === DC_PATCH)!.body!)).toEqual({
      custom_status: { text: "на паре", emoji_name: "📚", emoji_id: null, expires_at: "2026-09-28T05:30:00.000Z" },
    });
  });

  it("makes exactly one Discord call when nothing changes", async () => {
    const r = router(happyRoutes({ text: "на паре", emoji_name: "📚", expires_at: null }));
    const result = await runOnce(config, r.fn, now);
    expect(result.action).toEqual({ type: "none", reason: "unchanged" });
    expect(r.count(DC_GET)).toBe(1);
    expect(r.count(DC_PATCH)).toBe(0);
  });

  it("queries free/busy for now ± 24h", async () => {
    const r = router(happyRoutes(null));
    await runOnce(config, r.fn, now);
    expect(JSON.parse(r.calls.find((c) => c.key === FREEBUSY)!.body!)).toEqual({
      timeMin: "2026-09-27T04:30:00.000Z",
      timeMax: "2026-09-29T04:30:00.000Z",
      items: [{ id: CAL }],
    });
  });

  it("does not write in dry-run mode", async () => {
    const r = router(happyRoutes(null));
    const result = await runOnce(config, r.fn, now, { dryRun: true });
    expect(result.action.type).toBe("write");
    expect(r.count(DC_PATCH)).toBe(0);
  });

  it("leaves a manual status alone mid-window", async () => {
    const r = router(happyRoutes({ text: "болею", emoji_name: null, expires_at: null }));
    const result = await runOnce(config, r.fn, now);
    expect(result.action).toEqual({ type: "none", reason: "manual" });
    expect(r.count(DC_PATCH)).toBe(0);
  });

  it("replaces a manual status right after a window change", async () => {
    // 09:02: prev (08:57) was transit, now is in-class
    const r = router(happyRoutes({ text: "болею", emoji_name: null, expires_at: null }));
    const result = await runOnce(config, r.fn, new Date("2026-09-28T04:02:00Z"));
    expect(result.action.type).toBe("write");
    expect(r.count(DC_PATCH)).toBe(1);
  });

  it.each([
    ["token exchange fails", { [TOKEN]: () => ({ status: 400, body: {} }) }],
    ["freeBusy HTTP error", { [FREEBUSY]: () => ({ status: 403, body: {} }) }],
    ["freeBusy reports calendar errors", { [FREEBUSY]: () => ({ status: 200, body: { calendars: { [CAL]: { errors: [{ domain: "global", reason: "notFound" }] } } }) }],
    ["Discord read fails", { [DC_GET]: () => ({ status: 401, body: {} }) }],
  ] as const)("throws and never writes when %s", async (_name, override) => {
    const r = router({ ...happyRoutes(null), ...override });
    await expect(runOnce(config, r.fn, now)).rejects.toThrow();
    expect(r.count(DC_PATCH)).toBe(0);
  });

  it("throws when the Discord write fails", async () => {
    const r = router({ ...happyRoutes(null), [DC_PATCH]: () => ({ status: 500, body: {} }) });
    await expect(runOnce(config, r.fn, now)).rejects.toThrow(/write failed/);
  });
});

describe("formatRunLine", () => {
  it("prints one readable line", async () => {
    const r = router(happyRoutes({ text: "в пути", emoji_name: "🚗", expires_at: null }));
    const result = await runOnce(config, r.fn, now);
    expect(formatRunLine(result, "Asia/Tashkent")).toBe("09:30 Asia/Tashkent | want: 📚 на паре until 10:30 | have: 🚗 в пути | updated");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/sync.test.ts`
Expected: FAIL — cannot find module `../src/sync`.

- [ ] **Step 3: Write `src/sync.ts`**

```ts
import type { Config } from "./config";
import { readStatus, writeStatus, type CustomStatus, type FetchFn } from "./discord";
import { fetchBusy, getAccessToken } from "./google";
import { decide, type Decision, type Labels, type Range } from "./schedule";

export type HaveClass = "empty" | "ours" | "manual";

export type Action =
  | { type: "write"; status: CustomStatus | null }
  | { type: "none"; reason: "unchanged" | "manual" };

export interface RunResult {
  now: Date;
  busy: Range[];
  want: Decision;
  prev: Decision;
  have: CustomStatus | null;
  action: Action;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function toStatus(d: Decision): CustomStatus | null {
  return d.kind === "clear" ? null : { text: d.text, emoji: d.emoji, expiresAt: d.expiresAt };
}

/** Who owns the bubble: nobody, this job, or the user. Judged by text only. */
export function classify(have: CustomStatus | null, labels: Labels): HaveClass {
  const text = have?.text.trim() ?? "";
  if (text === "") return "empty";
  if (text === labels.textInClass || text === labels.textTransit) return "ours";
  return "manual";
}

/** Text and emoji only — expiry is deliberately not compared. */
export function statusEquals(a: CustomStatus | null, b: CustomStatus | null): boolean {
  const norm = (s: CustomStatus | null) => ({ text: s?.text.trim() ?? "", emoji: s?.emoji ?? "" });
  const na = norm(a);
  const nb = norm(b);
  return na.text === nb.text && na.emoji === nb.emoji;
}

/** The update-decision table from the spec. */
export function planAction(want: Decision, prev: Decision, have: CustomStatus | null, labels: Labels): Action {
  const target = toStatus(want);
  if (statusEquals(target, have)) return { type: "none", reason: "unchanged" };
  if (classify(have, labels) !== "manual") return { type: "write", status: target };
  if (want.kind !== prev.kind) return { type: "write", status: target };
  return { type: "none", reason: "manual" };
}

/** One full run. Throws on any failure before the write; never writes on failure. */
export async function runOnce(
  config: Config,
  fetchFn: FetchFn,
  now: Date,
  opts: { dryRun?: boolean } = {},
): Promise<RunResult> {
  const token = await getAccessToken(config.serviceAccount, fetchFn, now);
  const busy = await fetchBusy(
    token,
    config.calendarId,
    new Date(now.getTime() - DAY_MS),
    new Date(now.getTime() + DAY_MS),
    fetchFn,
  );
  const have = await readStatus(config.discordToken, fetchFn);

  const want = decide(now, busy, config.windows, config.labels);
  const prevAt = new Date(now.getTime() - config.runEveryMinutes * 60_000);
  const prev = decide(prevAt, busy, config.windows, config.labels);
  const action = planAction(want, prev, have, config.labels);

  if (action.type === "write" && !opts.dryRun) {
    await writeStatus(config.discordToken, action.status, fetchFn);
  }
  return { now, busy, want, prev, have, action };
}

export function formatTime(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(d);
}

export function formatStatus(s: CustomStatus | null): string {
  if (!s || (s.text.trim() === "" && s.emoji === "")) return "empty";
  return `${s.emoji} ${s.text}`.trim();
}

export function formatDecision(d: Decision, timezone: string): string {
  if (d.kind === "clear") return "clear";
  const until = d.expiresAt ? ` until ${formatTime(d.expiresAt, timezone)}` : "";
  return `${d.emoji} ${d.text}${until}`;
}

export function formatRunLine(r: RunResult, timezone: string): string {
  const action =
    r.action.type === "write" ? "updated" : r.action.reason === "manual" ? "manual, left alone" : "unchanged";
  return `${formatTime(r.now, timezone)} ${timezone} | want: ${formatDecision(r.want, timezone)} | have: ${formatStatus(r.have)} | ${action}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck`
Expected: every test file passes (gate 5, discord 11, schedule 26, google 8, config 16, sync 26); no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts test/sync.test.ts
git commit -m "Add update decision and single-run orchestration"
```

---

### Task 7: Preview script and real-timetable checkpoint

**Files:**
- Create: `scripts/preview.ts`

**Interfaces:**
- Consumes: `loadConfig`, `Env` (Task 5); `runOnce`, `formatStatus`, `Action` (Task 6); `timeline` (Task 3).

- [ ] **Step 1: Write `scripts/preview.ts`**

```ts
import { loadConfig, type Env } from "../src/config";
import { timeline } from "../src/schedule";
import { formatStatus, runOnce, type Action } from "../src/sync";

process.loadEnvFile(".dev.vars");
const config = loadConfig(process.env as Env);
const tz = config.timezone;
const now = new Date();
const dayEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);

const fmt = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(d);

function describe(action: Action): string {
  if (action.type === "none") return action.reason === "manual" ? "nothing — manual status, left alone" : "nothing — unchanged";
  return action.status ? `write ${formatStatus(action.status)}` : "clear the bubble";
}

const result = await runOnce(config, fetch, now, { dryRun: true });

console.log(`Now: ${fmt(now)} (${tz})\n`);

console.log("Busy in the next 24h:");
const upcoming = result.busy.filter((r) => r.end > now && r.start < dayEnd);
if (upcoming.length === 0) console.log("  none");
for (const r of upcoming) console.log(`  ${fmt(r.start)} – ${fmt(r.end)}`);

console.log("\nStatus timeline:");
for (const s of timeline(now, dayEnd, result.busy, config.windows, config.labels)) {
  const label = s.decision.kind === "clear" ? "clear" : `${s.decision.emoji} ${s.decision.text}`;
  console.log(`  ${fmt(s.start)} – ${fmt(s.end)}  ${label}`);
}

console.log(`\nDiscord shows now: ${formatStatus(result.have)}`);
console.log(`A real run would do: ${describe(result.action)}`);
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: no errors. (`Action` must be exported from `src/sync.ts` — it is, per Task 6.)

- [ ] **Step 3: Run the preview — CHECKPOINT**

Run: `npm run preview`
Expected output shape:

```
Now: Mon 09:32 (Asia/Tashkent)

Busy in the next 24h:
  Mon 09:00 – Mon 10:30
  Mon 10:45 – Mon 12:15
  Mon 12:30 – Mon 14:00

Status timeline:
  Mon 09:32 – Mon 14:00  📚 на паре
  Mon 14:00 – Mon 16:00  🚗 в пути
  Mon 16:00 – Tue 07:00  clear
  Tue 07:00 – Tue 09:00  🚗 в пути
  Tue 09:00 – Tue 09:32  📚 на паре

Discord shows now: empty
A real run would do: write 📚 на паре
```

The user compares the timeline against the real timetable for the next day and confirms it is what they want the bubble to say. Do **not** start Task 8 without that confirmation. If it is wrong, the fix is in `schedule.ts` (Task 3) or the windows in `wrangler.jsonc`; re-run the preview after.

- [ ] **Step 4: Commit**

```bash
git add scripts/preview.ts
git commit -m "Add read-only preview of the status timeline"
```

---

### Task 8: Worker entry point, deploy, and first live day

**Files:**
- Create: `src/index.ts`
- Modify: `docs/superpowers/specs/2026-09-27-workers-calendar-status-design.md` (file table: add `src/gate.ts`)
- Delete: `.env`

**Interfaces:**
- Consumes: `shouldRun` (Task 1); `loadConfig`, `Env` (Task 5); `runOnce`, `formatRunLine`, `formatTime` (Task 6).

- [ ] **Step 1: Write `src/index.ts`**

```ts
import { loadConfig, type Env } from "./config";
import { shouldRun } from "./gate";
import { formatRunLine, formatTime, runOnce } from "./sync";

/** The subset of Cloudflare's ScheduledController this handler uses. */
interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    let config;
    try {
      config = loadConfig(env);
    } catch (err) {
      console.error(`config error: ${(err as Error).message}`);
      return;
    }

    if (!shouldRun(controller.scheduledTime, config.runEveryMinutes)) return;

    const now = new Date(controller.scheduledTime);
    try {
      const result = await runOnce(config, fetch, now);
      console.log(formatRunLine(result, config.timezone));
    } catch (err) {
      console.error(`${formatTime(now, config.timezone)} ${config.timezone} | failed: ${(err as Error).message}`);
    }
  },
};
```

A broken config logs every minute rather than every interval — deliberately, so it is noticed.

- [ ] **Step 2: Type-check and run the full suite**

Run: `npm run typecheck && npm test`
Expected: no type errors; all 92 tests pass.

- [ ] **Step 3: Run the handler locally once**

In one terminal: `npm run dev` (wrangler serves the Worker locally, reading `.dev.vars` and the `vars` block).
In another: `curl -s "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`

Expected: the first terminal prints one log line in the `HH:MM Asia/Tashkent | want: … | have: … | …` shape, **or nothing** if the current minute is not a multiple of 5 (then wait for one that is, or temporarily add `RUN_EVERY_MINUTES=1` to `.dev.vars` and remove it afterwards). Stop `npm run dev` with Ctrl-C.

- [ ] **Step 4: Note `gate.ts` in the spec's file table**

In the spec's `## Files` table, add one row after `src/index.ts`:

```
| `src/gate.ts` | The timer gate (`shouldRun`), kept separate from the handler so it is trivially testable |
```

- [ ] **Step 5: Store the three secrets in Cloudflare**

```bash
npx wrangler secret put DISCORD_TOKEN                    # paste the token when prompted
base64 < ~/dc-status-key.json | tr -d '\n' | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY
printf '%s' "<the university email address>" | npx wrangler secret put CALENDAR_ID
npx wrangler secret list                                 # expect the three names
```

- [ ] **Step 6: Deploy and watch**

```bash
npm run deploy
npm run tail
```

Expected from `tail`, within `RUN_EVERY_MINUTES` minutes: one line like `09:35 Asia/Tashkent | want: 📚 на паре until 14:00 | have: empty | updated`. The Discord app shows the bubble. Leave `tail` open through the next window change and confirm a second line with `updated`.

If the first line is `failed: Google reports notFound …` the calendar share (Task 4 step 6.6) is missing. If it is `failed: Discord read failed: HTTP 429`, wait one interval — a shared-egress rate limit that clears on its own.

- [ ] **Step 7: Remove the old `.env` and commit**

```bash
rm .env
git add src/index.ts docs/superpowers/specs/2026-09-27-workers-calendar-status-design.md
git commit -m "Add scheduled Worker entry point"
```

- [ ] **Step 8: Verification through one class day**

Not a code step. The user leaves the Worker running for one full class day and checks four moments:

1. Two hours before the first class: bubble is 🚗 в пути.
2. During a break between classes: bubble is still 📚 на паре.
3. Two hours after the last class: bubble is cleared.
4. Type any status by hand mid-class; five minutes later it is still there; at the next window change it has been replaced.

Anything off is reported with the `wrangler tail` line from that moment.
