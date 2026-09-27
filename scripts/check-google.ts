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
