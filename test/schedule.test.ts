import { describe, expect, it } from "vitest";
import {
  decide,
  decideKind,
  mergeBlocks,
  nextChangeAt,
  timeline,
  type Labels,
  type Range,
  type Windows,
} from "../src/schedule";

const H = 60 * 60 * 1000;
const W: Windows = { transitBeforeMs: 2 * H, transitAfterMs: 2 * H, breakMaxMs: 2 * H };
const L: Labels = { textInClass: "на паре", textTransit: "в пути", emojiInClass: "📚", emojiTransit: "🚗" };

/** at("09:00") → 2026-09-28 09:00 Tashkent; at("01:00", 1) → the next day. */
function at(hhmm: string, dayOffset = 0): Date {
  const d = new Date(`2026-09-28T${hhmm}:00+05:00`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d;
}
function range(from: string, to: string, dayOffsetTo = 0): Range {
  return { start: at(from), end: at(to, dayOffsetTo) };
}

const threeClasses: Range[] = [range("09:00", "10:30"), range("10:45", "12:15"), range("12:30", "14:00")];

describe("mergeBlocks", () => {
  it("joins classes separated by short breaks into one block", () => {
    expect(mergeBlocks(threeClasses, W.breakMaxMs)).toEqual([range("09:00", "14:00")]);
  });

  it("splits at a gap exactly equal to breakMax", () => {
    const ranges = [range("09:00", "10:30"), range("12:30", "14:00")];
    expect(mergeBlocks(ranges, W.breakMaxMs)).toEqual(ranges);
  });

  it("keeps one block at a gap just under breakMax", () => {
    const ranges = [range("09:00", "10:30"), range("12:29", "14:00")];
    expect(mergeBlocks(ranges, W.breakMaxMs)).toEqual([range("09:00", "14:00")]);
  });

  it("merges overlapping ranges and sorts unsorted input", () => {
    const ranges = [range("10:00", "12:00"), range("09:00", "11:00")];
    expect(mergeBlocks(ranges, W.breakMaxMs)).toEqual([range("09:00", "12:00")]);
  });

  it("ignores zero-length and inverted ranges", () => {
    const ranges = [range("09:00", "09:00"), range("11:00", "10:00"), range("13:00", "14:00")];
    expect(mergeBlocks(ranges, W.breakMaxMs)).toEqual([range("13:00", "14:00")]);
  });

  it("does not mutate its input", () => {
    const ranges = [range("10:45", "12:15"), range("09:00", "10:30")];
    const copy = ranges.map((r) => ({ start: new Date(r.start), end: new Date(r.end) }));
    mergeBlocks(ranges, W.breakMaxMs);
    expect(ranges).toEqual(copy);
  });
});

describe("decideKind — single class 09:00–10:30", () => {
  const blocks = mergeBlocks([range("09:00", "10:30")], W.breakMaxMs);
  it.each([
    ["06:59", "clear"],
    ["07:00", "transit"],
    ["08:59", "transit"],
    ["09:00", "in-class"],
    ["10:29", "in-class"],
    ["10:30", "transit"],
    ["12:29", "transit"],
    ["12:30", "clear"],
  ])("at %s → %s", (time, kind) => {
    expect(decideKind(at(time), blocks, W)).toBe(kind);
  });
});

describe("decideKind — breaks and gaps", () => {
  it("stays in-class through 10–30 minute breaks", () => {
    const blocks = mergeBlocks(threeClasses, W.breakMaxMs);
    expect(decideKind(at("10:35"), blocks, W)).toBe("in-class");
    expect(decideKind(at("12:20"), blocks, W)).toBe("in-class");
  });

  it("reads a gap longer than breakMax as transit", () => {
    const blocks = mergeBlocks([range("09:00", "10:30"), range("13:00", "14:30")], W.breakMaxMs);
    expect(decideKind(at("11:00"), blocks, W)).toBe("transit");
    expect(decideKind(at("12:00"), blocks, W)).toBe("transit");
  });

  it("gives rule 1 priority when breakMax is shorter than transitBefore", () => {
    const w: Windows = { ...W, breakMaxMs: 30 * 60 * 1000 };
    const blocks = mergeBlocks([range("09:00", "10:00"), range("11:00", "12:00")], w.breakMaxMs);
    expect(blocks).toHaveLength(2);
    expect(decideKind(at("09:30"), blocks, w)).toBe("in-class");
  });

  it("handles a block crossing midnight", () => {
    const blocks = mergeBlocks([range("23:00", "01:00", 1)], W.breakMaxMs);
    expect(decideKind(at("00:30", 1), blocks, W)).toBe("in-class");
    expect(decideKind(at("02:30", 1), blocks, W)).toBe("transit");
  });
});

describe("nextChangeAt", () => {
  it("skips a boundary where the kind does not change", () => {
    // post-window of the first block (ends 12:30) overlaps the pre-window of the second (starts 11:00)
    const blocks = mergeBlocks([range("09:00", "10:30"), range("13:00", "14:30")], W.breakMaxMs);
    expect(nextChangeAt(at("10:45"), blocks, W)).toEqual(at("13:00"));
  });

  it("returns null when nothing changes again", () => {
    const blocks = mergeBlocks([range("09:00", "10:30")], W.breakMaxMs);
    expect(nextChangeAt(at("12:30"), blocks, W)).toBeNull();
  });
});

describe("decide", () => {
  it("returns clear with no expiry on an empty day", () => {
    expect(decide(at("09:00"), [], W, L)).toEqual({ kind: "clear", text: "", emoji: "", expiresAt: null });
  });

  it("in-class expires at the end of the whole block", () => {
    expect(decide(at("10:35"), threeClasses, W, L)).toEqual({
      kind: "in-class",
      text: "на паре",
      emoji: "📚",
      expiresAt: at("14:00"),
    });
  });

  it("pre-window transit expires when the block starts", () => {
    expect(decide(at("07:30"), threeClasses, W, L)).toEqual({
      kind: "transit",
      text: "в пути",
      emoji: "🚗",
      expiresAt: at("09:00"),
    });
  });

  it("post-window transit expires two hours after the block", () => {
    expect(decide(at("15:00"), threeClasses, W, L).expiresAt).toEqual(at("16:00"));
  });
});

describe("timeline", () => {
  it("lists the segments of a class day", () => {
    const segs = timeline(at("06:00"), at("18:00"), threeClasses, W, L);
    expect(segs.map((s) => [s.start, s.end, s.decision.kind])).toEqual([
      [at("06:00"), at("07:00"), "clear"],
      [at("07:00"), at("09:00"), "transit"],
      [at("09:00"), at("14:00"), "in-class"],
      [at("14:00"), at("16:00"), "transit"],
      [at("16:00"), at("18:00"), "clear"],
    ]);
  });

  it("is a single clear segment on an empty day", () => {
    const segs = timeline(at("06:00"), at("18:00"), [], W, L);
    expect(segs).toHaveLength(1);
    expect(segs[0].decision.kind).toBe("clear");
  });
});
