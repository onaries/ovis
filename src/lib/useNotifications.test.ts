import { describe, expect, it } from "bun:test";

import { ApiError } from "./api.ts";
import { subscribeFailure } from "./useNotifications.ts";

describe("subscribeFailure", () => {
  it("tells the browser's refusal, a service worker and the PC apart", () => {
    // pushManager.subscribe in Brave with its push service off, and the app's plugin without one
    expect(subscribeFailure(new DOMException("Registration failed - push service error", "AbortError"))).toBe("refused");
    expect(subscribeFailure(new Error("no push token"))).toBe("refused");
    // the PC answered no, or was never reached
    expect(subscribeFailure(new ApiError("/api/push/subscribe", 500, "boom", "internal_error"))).toBe("unregistered");
    expect(subscribeFailure(new TypeError("Failed to fetch"))).toBe("unregistered");
    // a retired endpoint the browser keeps handing over
    expect(subscribeFailure(new ApiError("/api/push/subscribe", 410, "retired", "subscription_gone"))).toBe("gone");
  });
});
