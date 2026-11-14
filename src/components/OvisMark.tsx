import type { ComponentProps } from "react";

/**
 * The app's own mark as a glyph: what stands for Back to Ovis wherever the inbox mode offers it (the column's foot,
 * a phone's More, the command palette), one mark for one action. It takes its size from where it stands: an item's
 * icon box in a menu or a sheet (styles.css, RowMenu.css), the mark's own in the foot (InboxList.css).
 */
export function OvisMark({ className, ...rest }: ComponentProps<"img">) {
  return <img src="/icons/icon-192.png?v=sheep1" alt="" {...rest} className={`ovis-mark${className ? ` ${className}` : ""}`} />;
}
