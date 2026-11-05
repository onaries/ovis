import { useEffect, useRef } from "react";
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { IImageAddonOptions, ImageAddon } from "@xterm/addon-image";

/**
 * Caps on what a pane's pictures may hold in this tab. Decoded pictures are RGBA in memory, four bytes
 * a pixel: the addon's own defaults (16 megapixels a picture, 128 MB stored) suit a desk, not a phone's
 * WebView, which a tab past its memory share is reloaded from. Past the stored cap the oldest picture
 * goes first; one larger than the pixel cap is not drawn at all.
 */
export function terminalImageOptions(coarse: boolean): IImageAddonOptions {
  return coarse
    ? { pixelLimit: 2048 * 2048, storageLimit: 16, sixelSizeLimit: 8_000_000, iipSizeLimit: 8_000_000 }
    : { pixelLimit: 4096 * 4096, storageLimit: 64 };
}

interface Loaded {
  addon: ImageAddon;
  /** the window reports the terminal answered before the addon turned its pixel size reports on */
  windowOptions: Terminal["options"]["windowOptions"];
  /** whether the setting is on for it now */
  enabled: boolean;
}

/**
 * One addon for a terminal's whole life, loaded the first time pictures are on. A cell keeps the id of
 * the picture drawn in it, and a new addon numbers its pictures from 1 again: loaded anew after being
 * disposed, it drew its first picture into every cell an old picture 1 had left.
 */
const loaded = new WeakMap<Terminal, Loaded>();

/** Build-time constant: on only in the browser lane's demo build (lib/crashProbe.ts). */
declare const __HERDR_TEST_HOOKS__: boolean;

/** the colour at a picture's top left corner, for the browser scripts' probe */
function pictureColour(picture: CanvasImageSource | undefined): number[] | null {
  if (picture === undefined) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.drawImage(picture, 0, 0);
  return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

const SIZE_REPORTS = { getWinSizePixels: true, getCellSizePixels: true, getWinSizeChars: true };

/**
 * Settings -> Terminal -> Pictures in the terminal: draws sixel and iTerm2 inline images (imgcat,
 * img2sixel, chafa, yazi) with xterm's image addon, loaded only once the setting is on. It does not
 * draw kitty's graphics protocol. The pictures reach the tab only where the attach stream carries
 * them: herdr-core passes a pane's output on as it is, herdr draws the pane from its own grid again
 * and drops them; a pane drawn again (attached anew) comes back without its pictures either way.
 */
/** whether xterm draws iTerm2 and sixel pictures in this terminal (Pictures in the terminal is on and loaded) */
export function terminalDrawsPictures(terminal: Terminal): boolean {
  return loaded.get(terminal)?.enabled === true;
}

export function useTerminalImages(terminal: Terminal | null, enabled: boolean, coarse: boolean): void {
  // the addon takes the caps of the pointer at the moment it loads, not at the moment its import began
  const coarseRef = useRef(coarse);
  coarseRef.current = coarse;
  useEffect(() => {
    if (terminal === null) return;
    const present = loaded.get(terminal);
    if (!enabled) {
      if (present === undefined) return;
      // off: its pictures go, and the next ones are taken before the addon sees them
      present.addon.reset();
      // an iTerm2 picture still decoding places itself once done: cleared again after what came before
      // (the parser waits for a decode before it reads on)
      terminal.write("", () => { if (!present.enabled) present.addon.reset(); });
      present.enabled = false;
      terminal.options.windowOptions = present.windowOptions;
      const swallowed: IDisposable[] = [
        terminal.parser.registerDcsHandler({ final: "q" }, () => true),
        terminal.parser.registerOscHandler(1337, () => true),
      ];
      return () => { for (const handler of swallowed) handler.dispose(); };
    }
    if (present !== undefined) {
      present.enabled = true;
      terminal.options.windowOptions = { ...present.windowOptions, ...SIZE_REPORTS };
      return;
    }
    let gone = false;
    import("@xterm/addon-image").then(({ ImageAddon }) => {
      if (gone || loaded.has(terminal)) return;
      // the addon turns xterm's pixel size reports on (the bridge passes the cell size on to hc, which
      // answers the program with it); turned off, the terminal answers as it did before
      const windowOptions = { ...terminal.options.windowOptions };
      const addon = new ImageAddon(terminalImageOptions(coarseRef.current));
      terminal.loadAddon(addon);
      // XTSMGRAPHICS goes unanswered, as without the addon: hc leaves it to its viewers, and two
      // browsers on one pane answered it late, into the program's next read (measured on hc 0.1.17).
      // xterm disposes the handler with the terminal, as it does the addon.
      terminal.parser.registerCsiHandler({ prefix: "?", final: "S" }, () => true);
      loaded.set(terminal, { addon, windowOptions, enabled: true });
      if (typeof __HERDR_TEST_HOOKS__ === "boolean" && __HERDR_TEST_HOOKS__ && terminal.element) {
        // browser scripts ask which picture a cell holds (never in a release build)
        Object.assign(terminal.element, { imageAt: (col: number, row: number) => pictureColour(addon.getImageAtBufferCell(col, row)) });
      }
    }, (error: unknown) => {
      console.error("terminal pictures could not be loaded", error);
    });
    return () => { gone = true; };
    // the caps are the ones of the screen the addon was loaded on; a change of pointer moves the stored cap below
  }, [terminal, enabled]);

  useEffect(() => {
    const present = terminal === null ? undefined : loaded.get(terminal);
    if (present !== undefined) present.addon.storageLimit = terminalImageOptions(coarse).storageLimit!;
  }, [terminal, coarse]);
}
