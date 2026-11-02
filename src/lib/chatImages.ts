import { machinePath } from "../../shared/machines.ts";
import type { ConversationPart } from "../../shared/protocol.ts";
import { fileUrl } from "./api.ts";
import type { Translate } from "./i18n.ts";
import { attachmentFileName, mentionFileName } from "./imageViewer.ts";
import type { GalleryImage } from "./imageViewer.ts";
import type { WorkImage } from "./workImages.ts";

/** A tool's picture as the viewer shows it, fetched from the conversation by its ref. */
export function toolGalleryImage(machineId: string, paneId: string, image: WorkImage, t: Translate): GalleryImage {
  return {
    src: machinePath(machineId, `pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: image.ref }).toString()}`),
    name: t("Image {n} from {tool}", { n: image.ordinal + 1, tool: image.part.name }),
    file: attachmentFileName(image.mediaType, image.ordinal),
  };
}

/** Pasted pictures first, then image files mentioned as @path, in the message's order. */
export function userGalleryImages(machineId: string, paneId: string, parts: readonly ConversationPart[], text: string, t: Translate): GalleryImage[] {
  const pasted = parts.filter((part): part is Extract<ConversationPart, { kind: "image" }> => part.kind === "image");
  const mentioned = [...new Set([...text.matchAll(/(?:^|\s)@(\S+\.(?:png|jpe?g|gif|webp))(?=\s|$)/gi)].map((match) => match[1] ?? ""))];
  return [
    ...pasted.map((part, index): GalleryImage => ({
      src: machinePath(machineId, `pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: part.ref }).toString()}`),
      name: t("Attached image"),
      file: attachmentFileName(part.media_type, index),
    })),
    ...mentioned.map((path): GalleryImage => ({ src: fileUrl(path, paneId, machineId), name: path, file: mentionFileName(path) })),
  ];
}
