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

  it("queries free/busy for now +/- 24h", async () => {
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
    const r = router(happyRoutes({ text: "болею", emoji_name: null, expires_at: null }));
    const result = await runOnce(config, r.fn, new Date("2026-09-28T04:02:00Z"));
    expect(result.action.type).toBe("write");
    expect(r.count(DC_PATCH)).toBe(1);
  });

  it.each([
    ["token exchange fails", { [TOKEN]: () => ({ status: 400, body: {} }) }],
    ["freeBusy HTTP error", { [FREEBUSY]: () => ({ status: 403, body: {} }) }],
    ["freeBusy reports calendar errors", { [FREEBUSY]: () => ({ status: 200, body: { calendars: { [CAL]: { errors: [{ domain: "global", reason: "notFound" }] } } } }) }],
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
