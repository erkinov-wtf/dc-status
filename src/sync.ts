import type { Config } from "./config";
import { readStatus, writeStatus, type CustomStatus, type FetchFn } from "./discord";
import { fetchBusy, getAccessToken } from "./google";
import { decide, type Decision, type Labels, type Range } from "./schedule";

export type HaveClass = "empty" | "ours" | "manual";

export type Action =
  | { type: "write"; status: CustomStatus | null }
  | { type: "none"; reason: "unchanged" | "manual" };

export interface RunResult {
  now: Date;
  busy: Range[];
  want: Decision;
  prev: Decision;
  have: CustomStatus | null;
  action: Action;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function toStatus(d: Decision): CustomStatus | null {
  return d.kind === "clear" ? null : { text: d.text, emoji: d.emoji, expiresAt: d.expiresAt };
}

/** Who owns the bubble: nobody, this job, or the user. Judged by text only. */
export function classify(have: CustomStatus | null, labels: Labels): HaveClass {
  const text = have?.text.trim() ?? "";
  if (text === "") return "empty";
  if (text === labels.textInClass || text === labels.textTransit) return "ours";
  return "manual";
}

/** Text and emoji only — expiry is deliberately not compared. */
export function statusEquals(a: CustomStatus | null, b: CustomStatus | null): boolean {
  const norm = (s: CustomStatus | null) => ({ text: s?.text.trim() ?? "", emoji: s?.emoji ?? "" });
  const na = norm(a);
  const nb = norm(b);
  return na.text === nb.text && na.emoji === nb.emoji;
}

/** The update-decision table from the spec. */
export function planAction(want: Decision, prev: Decision, have: CustomStatus | null, labels: Labels): Action {
  const target = toStatus(want);
  if (statusEquals(target, have)) return { type: "none", reason: "unchanged" };
  if (classify(have, labels) !== "manual") return { type: "write", status: target };
  if (want.kind !== prev.kind) return { type: "write", status: target };
  return { type: "none", reason: "manual" };
}

/** One full run. Throws on any failure before the write; never writes on failure. */
export async function runOnce(
  config: Config,
  fetchFn: FetchFn,
  now: Date,
  opts: { dryRun?: boolean } = {},
): Promise<RunResult> {
  const token = await getAccessToken(config.serviceAccount, fetchFn, now);
  const busy = await fetchBusy(
    token,
    config.calendarId,
    new Date(now.getTime() - DAY_MS),
    new Date(now.getTime() + DAY_MS),
    fetchFn,
  );
  const have = await readStatus(config.discordToken, fetchFn);

  const want = decide(now, busy, config.windows, config.labels);
  const prevAt = new Date(now.getTime() - config.runEveryMinutes * 60_000);
  const prev = decide(prevAt, busy, config.windows, config.labels);
  const action = planAction(want, prev, have, config.labels);

  if (action.type === "write" && !opts.dryRun) {
    await writeStatus(config.discordToken, action.status, fetchFn);
  }
  return { now, busy, want, prev, have, action };
}

export function formatTime(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(d);
}

export function formatStatus(s: CustomStatus | null): string {
  if (!s || (s.text.trim() === "" && s.emoji === "")) return "empty";
  return `${s.emoji} ${s.text}`.trim();
}

export function formatDecision(d: Decision, timezone: string): string {
  if (d.kind === "clear") return "clear";
  const until = d.expiresAt ? ` until ${formatTime(d.expiresAt, timezone)}` : "";
  return `${d.emoji} ${d.text}${until}`;
}

export function formatRunLine(r: RunResult, timezone: string): string {
  const action =
    r.action.type === "write" ? "updated" : r.action.reason === "manual" ? "manual, left alone" : "unchanged";
  return `${formatTime(r.now, timezone)} ${timezone} | want: ${formatDecision(r.want, timezone)} | have: ${formatStatus(r.have)} | ${action}`;
}
