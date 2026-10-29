import type { FileInfo } from "../../shared/protocol.ts";
import { fileUriPath } from "../../shared/fileUri.ts";

/** Bigger images are offered as a download: a phone decodes an image whole. */
export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

export type MarkdownImagePreview = { kind: "inline"; url: string } | { kind: "too-large"; size: number; downloadUrl: string };

/**
 * Where an image of a markdown file lives, as a path the file endpoint reads: a `file://` URI or
 * an absolute path as written, a relative one from the folder of the markdown file. Null for what
 * the page cannot load (an http address: the CSP allows own-origin images only) or cannot place
 * (`~`, a Windows drive).
 */
export function markdownImagePath(src: string, markdownPath: string): string | null {
  const target = src.trim().replace(/[?#].*$/s, "");
  if (target === "" || /^(?:https?:|data:|blob:|\/\/)/i.test(src.trim())) return null;
  let path = fileUriPath(target);
  // a file URI comes decoded; any other path is decoded here, once
  if (path === null) { try { path = decodeURI(target); } catch { return null; } }
  if (/^~|^[A-Za-z]:|\\/.test(path)) return null;
  if (!path.startsWith("/")) {
    const folder = markdownPath.slice(0, markdownPath.lastIndexOf("/") + 1);
    if (!folder.startsWith("/")) return null;
    path = folder + path;
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Stat a local markdown image before giving the browser a URL to decode. */
export async function markdownImagePreview(
  src: string,
  markdownPath: string,
  fetchInfo: (path: string) => Promise<FileInfo | { candidates: string[] }>,
  fileUrl: (path: string, download: boolean) => string,
): Promise<MarkdownImagePreview | null> {
  const path = markdownImagePath(src, markdownPath);
  if (path === null) return null;
  try {
    const info = await fetchInfo(path);
    if ("candidates" in info || info.kind !== "image") return null;
    return info.size > MAX_INLINE_IMAGE_BYTES
      ? { kind: "too-large", size: info.size, downloadUrl: fileUrl(info.path, true) }
      : { kind: "inline", url: fileUrl(info.path, false) };
  } catch {
    return null;
  }
}
