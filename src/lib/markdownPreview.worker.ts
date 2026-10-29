// Parses a Markdown file for the viewer's Preview off the page (src/lib/markdownPreview.ts): an
// input the parser handles slowly stalls this worker, which is ended past its budget, never the tab.
// A Preview that would draw too much for the page is answered as none (PREVIEW_ELEMENT_LIMIT).
import { parseMarkdown, type MarkdownBlock } from "../../shared/markdown.ts";
import { serveOffThread } from "./offThread.ts";
import { PREVIEW_ELEMENT_LIMIT, previewElements } from "./textPreview.ts";

serveOffThread<string, MarkdownBlock[] | null>((text) => {
  const blocks = parseMarkdown(text, 0, true);
  return { result: previewElements(blocks) > PREVIEW_ELEMENT_LIMIT ? null : blocks };
});
