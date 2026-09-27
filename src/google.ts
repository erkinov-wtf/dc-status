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
