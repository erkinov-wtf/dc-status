import { loadConfig, type Env } from "../src/config";
import { fetchBusy, getAccessToken } from "../src/google";

process.loadEnvFile(".dev.vars");
const config = loadConfig(process.env as Env);

const token = await getAccessToken(config.serviceAccount, fetch);

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const busy = await fetchBusy(token, config.calendarId, new Date(now - DAY), new Date(now + 6 * DAY), fetch);

const fmt = (d: Date) => d.toLocaleString("en-GB", { timeZone: config.timezone });
console.log(`${busy.length} busy ranges from yesterday through the next 6 days:`);
for (const r of busy) console.log(`  ${fmt(r.start)} → ${fmt(r.end)}`);
