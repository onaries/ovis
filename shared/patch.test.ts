import { describe, expect, it } from "bun:test";

import { patchFiles, patchText } from "./patch.ts";

const PATCH = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: docs/b.md\n+hi\n*** End Patch\n";

describe("Codex patches", () => {
  it("finds a patch given whole, or as the string an exec script hands to tools.apply_patch", () => {
    expect(patchText(PATCH)).toBe(PATCH);
    const script = `text(await tools.apply_patch(${JSON.stringify(PATCH)}));\nconsole.log("done")`;
    expect(patchText(script)).toBe(PATCH);
    expect(patchText("await tools.apply_patch(`" + PATCH + "`)")).toBe(PATCH);
    expect(patchText("tools.exec_command({cmd: 'ls'})")).toBeNull();
    expect(patchText('tools.apply_patch("not a patch")')).toBeNull();
  });

  it("resolves a patch template from preceding literal path constants without executing code", () => {
    const file = "/mnt/projects/safemotion/kidscafe-workspace/kiosk/frontend/app/(reactive)/(unauth)/parent-station/ParentStationClient.tsx";
    const template = ["*** Begin Patch", "*** Update File: ${f}", "@@",
      ' import { useCallback, useEffect, useMemo, useRef, useState } from "react";',
      '+import { useRouter } from "next/navigation";',
      ' import ParentStationLookup from "./ParentStationLookup.tsx";',
      "@@", " }: ParentStationClientProps = {}) {",
      "   const [screen, setScreen] = useState<Screen>(initialScreen);",
      "+  const router = useRouter();", "*** End Patch"].join("\n");
    const quote = String.fromCharCode(96);
    const source = "const f = " + JSON.stringify(file) + ";\nconst p = " + quote + template + quote + ";\ntext(await tools.apply_patch(p));";
    const expected = template.replace("${f}", file);
    expect(patchText(source)).toBe(expected);
    expect(patchFiles(patchText(source) ?? "")).toEqual([file]);
    expect(patchText("const f = " + JSON.stringify(file) + ";text(await tools.apply_patch(" + quote + template + quote + "));")).toBe(expected);
    for (const invalid of [
      source.replace("const f", "let f"),
      source.replace("${f}", "${missing}"),
      source.replace("${f}", "${resolveFile()}"),
      source.replace("tools.apply_patch(p)", "tools.apply_patch(other)"),
      source.replace("text(await", "change();text(await"),
      "const example = " + JSON.stringify(source) + ";",
      "/* " + source + " */",
    ]) expect(patchText(invalid)).toBeNull();
  });


  it("names each file a patch touches once, in order", () => {
    expect(patchFiles(PATCH + "*** Update File: src/a.ts\n*** Delete File: old.txt\n")).toEqual(["src/a.ts", "docs/b.md", "old.txt"]);
  });

  it("finds an exec patch stored in a constant without evaluating code", () => {
    const source = `const patch = ${JSON.stringify(PATCH)}; text(await tools.apply_patch(patch));`;
    expect(patchText(source)).toBe(PATCH);
    expect(patchText(source.replace("apply_patch(patch)", "apply_patch(other)"))).toBeNull();
    expect(patchText(`const patch = ${JSON.stringify(PATCH)}; // tools.apply_patch(patch)`)).toBeNull();
    expect(patchText(`const patch = ${JSON.stringify(PATCH)}; const example = "tools.apply_patch(patch)";`)).toBeNull();
    expect(patchText('const patch = getPatch(); tools.apply_patch(patch)')).toBeNull();
  });
});
