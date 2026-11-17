import type { Response } from "playwright-core";

/**
 * What Playwright says when the browser no longer has a response's body: a navigation or an eviction let it go, or the
 * page closed under the read. Seen in a run: `Protocol error (Network.getResponseBody): No resource with given
 * identifier found`, the body of an answer read after the page had navigated on.
 */
const GONE = /Protocol error \(Network\.getResponseBody\): (No resource with given identifier found|No data found for resource with given identifier)|Target page, context or browser has been closed/;

/**
 * `read` of `response` (its JSON, body or headers), or undefined, said in the log, when the browser no longer has it:
 * a handler or a wait that comes to an answer late passes over that one instead of ending the run. Any other failure
 * (a body that is not JSON) is thrown, so a wrong answer still fails.
 */
export async function unlessGone<T>(response: Response, read: (response: Response) => Promise<T>): Promise<T | undefined> {
  try {
    return await read(response);
  } catch (error) {
    if (!GONE.test((error as Error).message)) throw error;
    console.log("response body gone:", response.request().method(), response.url(), (error as Error).message.split("\n")[0]);
    return undefined;
  }
}
