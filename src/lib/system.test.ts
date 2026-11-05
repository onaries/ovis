import { describe, expect, it } from "bun:test";
import { ApiError } from "./api.ts";
import { systemUnavailable } from "./system.ts";

const refused = (status: number) => new ApiError("/x", status, "no", null);

describe("systemUnavailable", () => {
  it("latches a bridge from before the route (404, 405) for any PC", () => {
    expect(systemUnavailable(refused(404), "local")).toBe(true);
    expect(systemUnavailable(refused(405), "pc-1")).toBe(true);
  });

  it("latches a refusal through the PC proxy (an old bridge with a token set answers 401/403)", () => {
    expect(systemUnavailable(refused(401), "pc-1")).toBe(true);
    expect(systemUnavailable(refused(403), "pc-1")).toBe(true);
  });

  it("does not stop asking the PC this browser is signed in to because it was signed out", () => {
    expect(systemUnavailable(refused(401), "local")).toBe(false);
  });

  it("keeps asking after a restart, a timeout or an unusable answer", () => {
    expect(systemUnavailable(refused(502), "pc-1")).toBe(false);
    expect(systemUnavailable(refused(503), "pc-1")).toBe(false);
    expect(systemUnavailable(new DOMException("timeout", "TimeoutError"), "pc-1")).toBe(false);
    expect(systemUnavailable(new TypeError("fetch failed"), "pc-1")).toBe(false);
  });
});
