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
    expect(new Headers(calls[0].init?.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
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
    expect(new Headers(calls[0].init?.headers).get("Content-Type")).toBe("application/json");
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

  it("treats a calendar entry with no busy list as a failure", async () => {
    const { fn } = fakeFetch(200, { calendars: { [CAL]: {} } });
    await expect(fetchBusy("t", CAL, timeMin, timeMax, fn)).rejects.toBeInstanceOf(GoogleError);
  });

  it("throws GoogleError when a busy range has an unparseable time", async () => {
    const { fn } = fakeFetch(200, {
      calendars: { [CAL]: { busy: [{ start: "not-a-date", end: "2026-09-28T05:30:00Z" }] } },
    });
    await expect(fetchBusy("t", CAL, timeMin, timeMax, fn)).rejects.toBeInstanceOf(GoogleError);
  });
});
