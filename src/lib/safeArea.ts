/** The screen's safe-area insets in CSS pixels: the notch or Dynamic Island, the rounded corners
 * and the home indicator. A popover placed by script keeps clear of them, as the CSS does with
 * env(safe-area-inset-*); script reads them from the root's --safe-area-* properties (styles.css). */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function safeAreaInsets(): SafeAreaInsets {
  const style = getComputedStyle(document.documentElement);
  const inset = (side: keyof SafeAreaInsets): number => parseFloat(style.getPropertyValue(`--safe-area-${side}`)) || 0;
  return { top: inset("top"), right: inset("right"), bottom: inset("bottom"), left: inset("left") };
}
