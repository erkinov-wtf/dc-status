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

  it.each(["0", "abc", "5.5", "-5", "61"])("rejects RUN_EVERY_MINUTES=%s", (v) => {
    expect(() => loadConfig({ ...base, RUN_EVERY_MINUTES: v })).toThrow(/RUN_EVERY_MINUTES/);
  });

  it("accepts RUN_EVERY_MINUTES at its upper bound", () => {
    expect(loadConfig({ ...base, RUN_EVERY_MINUTES: "60" }).runEveryMinutes).toBe(60);
  });

  it("rejects a non-numeric window", () => {
    expect(() => loadConfig({ ...base, BREAK_MAX_MINUTES: "2h" })).toThrow(/BREAK_MAX_MINUTES/);
  });

  it.each(["TRANSIT_BEFORE_MINUTES", "TRANSIT_AFTER_MINUTES", "BREAK_MAX_MINUTES"] as const)(
    "rejects %s at or above 1440",
    (name) => {
      expect(() => loadConfig({ ...base, [name]: "1440" })).toThrow(new RegExp(name));
    },
  );

  it("accepts a window minutes value just under 1440", () => {
    const c = loadConfig({ ...base, TRANSIT_AFTER_MINUTES: "1439" });
    expect(c.windows.transitAfterMs).toBe(1439 * 60_000);
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
