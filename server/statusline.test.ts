import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STALE_MS, parseStatusline, readStatusline } from "./statusline.ts";

/** Claude Code 2.1.308's payload, cut to the fields this reader shows */
const payload = {
  session_id: "1f029056-ac98-41b6-a111-125fd71c2c0e",
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  rate_limits: {
    five_hour: { used_percentage: 17, resets_at: 1793190600 },
    seven_day: { used_percentage: 64, resets_at: 1793343600 },
  },
  context_window: { used_percentage: 32, remaining_percentage: 68, context_window_size: 1000000 },
};

describe("parseStatusline", () => {
  it("reads the five-hour and weekly windows, resets from epoch seconds", () => {
    const reading = parseStatusline(payload, 1000)!;
    expect(reading.fiveHour).toEqual({ usedPercent: 17, resetsAt: new Date(1793190600 * 1000).toISOString() });
    expect(reading.sevenDay).toEqual({ usedPercent: 64, resetsAt: new Date(1793343600 * 1000).toISOString() });
  });

  it("keeps one window when the other is missing, and names no reset when it has none", () => {
    const reading = parseStatusline({ rate_limits: { seven_day: { used_percentage: 8 } } }, 1)!;
    expect(reading.fiveHour).toBeNull();
    expect(reading.sevenDay).toEqual({ usedPercent: 8, resetsAt: null });
  });

  it("is null for a payload with nothing to show", () => {
    expect(parseStatusline({}, 1)).toBeNull();
    expect(parseStatusline({ rate_limits: { five_hour: {} } }, 1)).toBeNull();
    // an ISO string where epoch seconds belong is not a time this reader invents one for
    expect(parseStatusline({ rate_limits: { five_hour: { used_percentage: 5, resets_at: "2026-10-28T00:00:00Z" } } }, 1)!.fiveHour)
      .toEqual({ usedPercent: 5, resetsAt: null });
  });
});

describe("readStatusline", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-statusline-"));
  const path = join(home, ".herdr", "statusline-last.json");
  const write = (value: unknown): void => {
    require("node:fs").mkdirSync(join(home, ".herdr"), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };

  it("reads the file the tee wrote", () => {
    write(payload);
    expect(readStatusline(home, payload.rate_limits.five_hour.resets_at * 1000 - 60_000)?.fiveHour?.usedPercent).toBe(17);
    rmSync(path);
    expect(readStatusline(home)).toBeNull();
  });

  it("drops windows at their reset while retaining unexpired windows", () => {
    write(payload);
    const now = payload.rate_limits.five_hour.resets_at * 1000;
    utimesSync(path, new Date(now - 60_000), new Date(now - 60_000));
    const reading = readStatusline(home, now)!;
    expect(reading.fiveHour).toBeNull();
    expect(reading.sevenDay?.usedPercent).toBe(64);
    write({ rate_limits: { five_hour: { used_percentage: 17, resets_at: now / 1000 - 1 } } });
    utimesSync(path, new Date(now), new Date(now));
    expect(readStatusline(home, now)?.fiveHour).toBeNull();
  });

  it("does not read a capture larger than any the capture writes", () => {
    write({ ...payload, padding: "x".repeat(1024 * 1024) });
    expect(readStatusline(home, payload.rate_limits.five_hour.resets_at * 1000 - 60_000)).toBeNull();
    rmSync(path);
  });

  it("stops reading a payload older than a five-hour window", () => {
    write(payload);
    const now = payload.rate_limits.five_hour.resets_at * 1000 - 60_000;
    utimesSync(path, new Date(now - STALE_MS - 60_000), new Date(now - STALE_MS - 60_000));
    expect(readStatusline(home, now)).toBeNull();
    utimesSync(path, new Date(now - 60_000), new Date(now - 60_000));
    expect(readStatusline(home, now)?.sevenDay?.usedPercent).toBe(64);
    rmSync(home, { recursive: true, force: true });
  });
});
