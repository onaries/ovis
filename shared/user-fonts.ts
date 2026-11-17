export const USER_FONTS_PATH = "/api/fonts";

/** One file of `fonts/`, as GET /api/fonts lists it. */
export interface UserFont {
  /** its name in `fonts/`, served at GET /api/fonts/<file> */
  readonly file: string;
  /** the family it is registered under: the file's name without its extension and a Regular, Bold, Italic or BoldItalic suffix */
  readonly family: string;
  readonly weight: 400 | 700;
  readonly style: "normal" | "italic";
  readonly bytes: number;
  /** changes whenever the file does: the file is asked for with it, so a copy kept by the browser is never an older one */
  readonly version: string;
}

export interface UserFontList {
  readonly fonts: readonly UserFont[];
}
