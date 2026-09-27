export interface Range {
  start: Date;
  end: Date;
}

export interface Windows {
  transitBeforeMs: number;
  transitAfterMs: number;
  breakMaxMs: number;
}

export interface Labels {
  textInClass: string;
  textTransit: string;
  emojiInClass: string;
  emojiTransit: string;
}

export type Kind = "in-class" | "transit" | "clear";

export interface Decision {
  kind: Kind;
  text: string;
  emoji: string;
  expiresAt: Date | null;
}

export interface Segment {
  start: Date;
  end: Date;
  decision: Decision;
}

/**
 * Groups busy ranges into blocks: a range joins the current block when it
 * starts less than breakMaxMs after the block's end. Breaks inside a block
 * count as class time. Zero-length and inverted ranges are ignored.
 */
export function mergeBlocks(ranges: Range[], breakMaxMs: number): Range[] {
  const sorted = ranges
    .filter((r) => r.end.getTime() > r.start.getTime())
    .map((r) => ({ start: new Date(r.start), end: new Date(r.end) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const blocks: Range[] = [];
  for (const r of sorted) {
    const last = blocks.at(-1);
    if (last && r.start.getTime() - last.end.getTime() < breakMaxMs) {
      if (r.end > last.end) last.end = r.end;
    } else {
      blocks.push(r);
    }
  }
  return blocks;
}

/** Rules 1–4 from the spec, first match wins. */
export function decideKind(now: Date, blocks: Range[], w: Windows): Kind {
  const t = now.getTime();
  if (blocks.some((b) => b.start.getTime() <= t && t < b.end.getTime())) return "in-class";
  if (blocks.some((b) => b.start.getTime() - w.transitBeforeMs <= t && t < b.start.getTime())) return "transit";
  if (blocks.some((b) => b.end.getTime() <= t && t < b.end.getTime() + w.transitAfterMs)) return "transit";
  return "clear";
}

/** The next moment the kind actually changes, or null if it never does. */
export function nextChangeAt(now: Date, blocks: Range[], w: Windows): Date | null {
  const t = now.getTime();
  const current = decideKind(now, blocks, w);
  const candidates = blocks
    .flatMap((b) => [
      b.start.getTime() - w.transitBeforeMs,
      b.start.getTime(),
      b.end.getTime(),
      b.end.getTime() + w.transitAfterMs,
    ])
    .filter((c) => c > t)
    .sort((a, b) => a - b);
  for (const c of candidates) {
    if (decideKind(new Date(c), blocks, w) !== current) return new Date(c);
  }
  return null;
}

export function decide(now: Date, ranges: Range[], w: Windows, labels: Labels): Decision {
  const blocks = mergeBlocks(ranges, w.breakMaxMs);
  const kind = decideKind(now, blocks, w);
  if (kind === "clear") return { kind, text: "", emoji: "", expiresAt: null };
  const expiresAt = nextChangeAt(now, blocks, w);
  return kind === "in-class"
    ? { kind, text: labels.textInClass, emoji: labels.emojiInClass, expiresAt }
    : { kind, text: labels.textTransit, emoji: labels.emojiTransit, expiresAt };
}

/** Consecutive segments from `from` to `to`, one per stretch of unchanged kind. */
export function timeline(from: Date, to: Date, ranges: Range[], w: Windows, labels: Labels): Segment[] {
  const blocks = mergeBlocks(ranges, w.breakMaxMs);
  const segments: Segment[] = [];
  let cursor = from;
  while (cursor < to) {
    const next = nextChangeAt(cursor, blocks, w);
    const end = next && next < to ? next : to;
    segments.push({ start: cursor, end, decision: decide(cursor, ranges, w, labels) });
    cursor = end;
  }
  return segments;
}
