import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMarkdown, type InlineNode, type MarkdownBlock } from "../../shared/markdown.ts";

const text = (nodes: InlineNode[]): string => nodes.map((node) => node.type === "text" || node.type === "code" || node.type === "math" ? node.value
  : node.type === "image" ? `[img ${node.alt}]` : text(node.children)).join("");
const shown = (blocks: MarkdownBlock[]): string => JSON.stringify(blocks);

describe("HTML blocks in a markdown file", () => {
  it("reads the README's header as centered markdown, never as tag text", () => {
    const readme = readFileSync(join(import.meta.dir, "../../README.md"), "utf8");
    const head = readme.slice(0, readme.indexOf("\n## "));
    const blocks = parseMarkdown(head, 0, true);
    expect(shown(blocks)).not.toContain("<p");
    expect(shown(blocks)).not.toContain("<a ");
    expect(shown(blocks)).not.toContain("<img");
    const logo = blocks.find((block) => block.type === "paragraph" && block.lines.flat().some((node) => node.type === "image"));
    expect(logo).toMatchObject({ type: "paragraph", align: "center" });
    const image = logo?.type === "paragraph" ? logo.lines.flat().find((node) => node.type === "image") : undefined;
    expect(image).toMatchObject({ type: "image", src: "public/icons/icon-192.png", alt: "Ovis", width: 100 });
    const languages = blocks.find((block) => block.type === "paragraph" && text(block.lines.flat()).includes("English"));
    expect(languages?.type === "paragraph" && languages.lines.flat().some((node) => node.type === "file" && node.path === "README.ko.md")).toBe(true);
    const site = blocks.find((block) => block.type === "paragraph" && text(block.lines.flat()).includes("website"));
    expect(site?.type === "paragraph" && site.lines.flat().some((node) => node.type === "link" && node.href === "https://ovis.sh/")).toBe(true);
  });

  it("keeps text, drops comments and unknown tags, and reads headings, breaks, emphasis and entities", () => {
    const blocks = parseMarkdown([
      "<!-- a note",
      "",
      "still the note -->",
      "<h2 align=\"center\">Title &amp; more</h2>",
      "",
      "<div>one<br>two <b>bold</b> <i>it</i> <span class=\"x\">kept</span> <script>alert(1)</script></div>",
      "",
      "after **markdown**",
    ].join("\n"), 0, true);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 2, align: "center" });
    expect(blocks[0]?.type === "heading" && text(blocks[0].content)).toBe("Title & more");
    expect(blocks[1]?.type === "paragraph" && blocks[1].lines.map(text)).toEqual(["one", "two bold it kept"]);
    expect(blocks[1]?.type === "paragraph" && blocks[1].lines[1]?.some((node) => node.type === "strong")).toBe(true);
    expect(blocks[2]?.type === "paragraph" && blocks[2].lines[0]?.some((node) => node.type === "strong")).toBe(true);
    expect(blocks).toHaveLength(3);
  });

  it("never throws on a numeric reference outside Unicode, and ends a comment where it ends", () => {
    const blocks = parseMarkdown("<p>&#1114112; &#xD800; &#0; &#169;</p>", 0, true);
    expect(blocks[0]?.type === "paragraph" && text(blocks[0].lines[0] ?? [])).toBe("\ufffd \ufffd \ufffd ©");
    const after = parseMarkdown(["<!-- note -->", "# Heading", "", "<!-- a", "b -->", "```html", "<span>kept</span>", "```"].join("\n"), 0, true);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ type: "heading", level: 1 });
    expect(after[1]).toMatchObject({ type: "code", language: "html", value: "<span>kept</span>" });
  });

  it("keeps the spaces and breaks inside links and emphasis, and the centering of a wrapper", () => {
    const [broken] = parseMarkdown("<p><strong>one<br>two</strong></p>", 0, true);
    expect(broken?.type === "paragraph" && broken.lines.map(text)).toEqual(["one", "two"]);
    expect(broken?.type === "paragraph" && broken.lines.every((line) => line.some((node) => node.type === "strong"))).toBe(true);
    const [spaced] = parseMarkdown("<p><a href=\"https://example.com/\"><b>one</b> <b>two</b></a></p>", 0, true);
    expect(spaced?.type === "paragraph" && text(spaced.lines[0] ?? [])).toBe("one two");
    const wrapped = parseMarkdown("<center><h1>Title</h1><p>Subtitle</p></center>\n<div align=\"center\"><p>inner</p></div>\n<p>plain</p>", 0, true);
    expect(wrapped.map((block) => [block.type, block.type === "heading" || block.type === "paragraph" ? block.align ?? null : null])).toEqual([["heading", "center"], ["paragraph", "center"], ["paragraph", "center"], ["paragraph", null]]);
  });

  it("links only to safe addresses and files", () => {
    const [block] = parseMarkdown("<p><a href=\"javascript:alert(1)\">bad</a> <a href=\"docs/guide.md#x\">guide</a></p>", 0, true);
    const nodes = block?.type === "paragraph" ? block.lines.flat() : [];
    expect(nodes.some((node) => node.type === "link")).toBe(false);
    expect(nodes.find((node) => node.type === "file")).toMatchObject({ path: "docs/guide.md" });
    expect(text(nodes)).toBe("bad guide");
  });

  it("is text in an agent's message", () => {
    const [block] = parseMarkdown("<p align=\"center\">hi</p>");
    expect(block?.type === "paragraph" && text(block.lines.flat())).toBe("<p align=\"center\">hi</p>");
  });
});
