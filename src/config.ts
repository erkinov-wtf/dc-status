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

function minutes(
  env: Env,
  name: keyof Env,
  fallback: number,
  max?: { atMost: number } | { lessThan: number },
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number of minutes, got "${raw}"`);
  const n = Number(raw);
  if (n <= 0) throw new ConfigError(`${name} must be greater than 0`);
  if (max && "atMost" in max && n > max.atMost) throw new ConfigError(`${name} must be at most ${max.atMost}`);
  if (max && "lessThan" in max && n >= max.lessThan) throw new ConfigError(`${name} must be less than ${max.lessThan}`);
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
    runEveryMinutes: minutes(env, "RUN_EVERY_MINUTES", 5, { atMost: 60 }),
    windows: {
      transitBeforeMs: minutes(env, "TRANSIT_BEFORE_MINUTES", 120, { lessThan: 1440 }) * MIN,
      transitAfterMs: minutes(env, "TRANSIT_AFTER_MINUTES", 120, { lessThan: 1440 }) * MIN,
      breakMaxMs: minutes(env, "BREAK_MAX_MINUTES", 120, { lessThan: 1440 }) * MIN,
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
