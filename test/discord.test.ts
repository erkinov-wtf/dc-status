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
