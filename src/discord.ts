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
