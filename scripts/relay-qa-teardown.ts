/**
 * Teardown for the relay browser QA harnesses. A route that proxies app.ovis.sh to the built shell can still be
 * waiting on it when a check closes its page, context or browser, and Playwright then rejects that route's fetch or
 * fulfill. So every close goes through `closeMarked`, which marks the target closing before it closes it
 * (context.on("close") fires only once the close is done, too late for a fulfill that fails during it), and a proxy
 * wrapped in `whileOpen` drops an error only when its page, context or browser is closing or closed: one while the
 * page is still open fails the run as before.
 */
import type { Browser, BrowserContext, Page, Route } from "playwright-core";

const closing = new WeakSet<Browser | BrowserContext | Page>();

/** Closes `target`, marked closing first so a route still in flight on it ends quietly. */
export async function closeMarked(target: Browser | BrowserContext | Page): Promise<void> {
  closing.add(target);
  await target.close();
}

/** `handler` for routes on `context`, its errors dropped once the request's page, `context` or the browser is closing. */
export function whileOpen(context: BrowserContext, handler: (route: Route) => Promise<void>): (route: Route) => Promise<void> {
  return async (route) => {
    try {
      await handler(route);
    } catch (error) {
      const page = route.request().frame().page();
      const browser = context.browser();
      if (!(page.isClosed() || closing.has(page) || closing.has(context) || (browser !== null && closing.has(browser)))) throw error;
    }
  };
}
