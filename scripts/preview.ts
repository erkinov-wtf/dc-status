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
console.log(
  `(the last ${config.windows.transitBeforeMs / 60_000} minutes of the timeline are provisional: classes starting just beyond 24h are not fetched)`,
);

console.log(`\nDiscord shows now: ${formatStatus(result.have)}`);
console.log(`A real run would do: ${describe(result.action)}`);
