import { describe, expect, it } from "bun:test";
import type { SystemReport } from "../../shared/system.ts";
import { translate } from "./i18n.ts";
import { formatBytes, formatPercentValue, formatUptime, fullestDisk, parseSystemReport } from "./systemReport.ts";

const good: SystemReport = {
  sampled_at: 1, platform: "linux", uptime_s: 100, cpu_count: 4, cpu_percent: 12.5,
  memory: { used: 1, total: 2, percent: 50 }, load: [0.1, 0.2, 0.3],
  disks: [{ path: "/", used: 1, total: 2, percent: 50 }],
};

describe("system formatting", () => {
  it("writes bytes in powers of 1024", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(15 * 1024 ** 2)).toBe("15 MB");
    expect(formatBytes(2.5 * 1024 ** 4)).toBe("2.5 TB");
  });

  it("writes uptime in its two largest units, in the UI language", () => {
    const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
    const ko = (key: string, vars?: Record<string, string | number>) => translate("ko", key, vars);
    expect(formatUptime(59, en)).toBe("0m");
    expect(formatUptime(3 * 3600 + 5 * 60, en)).toBe("3h 5m");
    expect(formatUptime(2 * 86400 + 3 * 3600 + 900, en)).toBe("2d 3h");
    expect(formatUptime(2 * 86400 + 3 * 3600, ko)).toBe("2일 3시간");
  });

  it("shows a missing percent as a dash, not 0%", () => {
    expect(formatPercentValue(null)).toBe("—");
    expect(formatPercentValue(41.6)).toBe("42%");
  });

  it("picks the fullest disk", () => {
    expect(fullestDisk([])).toBeNull();
    const disks = [{ path: "/", used: 1, total: 2, percent: 50 }, { path: "/home", used: 9, total: 10, percent: 90 }];
    expect(fullestDisk(disks)?.path).toBe("/home");
  });
});

describe("parseSystemReport", () => {
  it("accepts what the server sends, with the nullable fields null", () => {
    expect(parseSystemReport(good)).toEqual(good);
    expect(parseSystemReport({ ...good, cpu_percent: null, memory: null, load: null, disks: [] })).not.toBeNull();
  });

  it("refuses an answer the sidebar could not draw, instead of throwing later", () => {
    for (const bad of [null, "x", [], {}, { ...good, disks: null }, { ...good, load: "x" }, { ...good, load: [1, 2] }, { ...good, memory: { used: "a", total: 2, percent: 1 } },
      { ...good, cpu_percent: 140 }, { ...good, cpu_percent: Number.NaN }, { ...good, cpu_count: 0 }, { ...good, disks: [{ path: 1, used: 1, total: 2, percent: 1 }] }]) {
      expect(parseSystemReport(bad)).toBeNull();
    }
  });

  it("cuts a list longer than a PC can have and names an unknown platform other", () => {
    const disks = Array.from({ length: 9 }, (_, i) => ({ path: `/d${i}`, used: 1, total: 2, percent: 50 }));
    expect(parseSystemReport({ ...good, disks })?.disks).toHaveLength(4);
    expect(parseSystemReport({ ...good, platform: "plan9" })?.platform).toBe("other");
  });
});
