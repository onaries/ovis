import { describe, expect, it } from "bun:test";

import { knownPreview, parsePreviewOffThread } from "./markdownPreview.ts";

describe("parsePreviewOffThread", () => {
  it("parses in a real worker and remembers the file", async () => {
    const text = "# Plan\n\n- [x] done\n- [ ] open\n";
    const blocks = await parsePreviewOffThread(text).promise;
    expect(blocks?.[0]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks?.[1]).toMatchObject({ type: "list" });
    expect(knownPreview(text)).toBe(blocks!);
    expect(knownPreview("# another file")).toBeUndefined();
  });

});
