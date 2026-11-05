import { currentLocale, t } from "./i18n.ts";

/** When a device or PC was last seen, as a list row says it: minutes, then hours, then a date. */
export function lastSeen(value: string | null, now = Date.now()): string {
  if (value === null) return t("never");
  const minutes = Math.round((now - Date.parse(value)) / 60_000);
  if (minutes < 2) return t("just now");
  if (minutes < 60) return t("{n} min ago", { n: minutes });
  if (minutes < 60 * 48) return t("{n} h ago", { n: Math.round(minutes / 60) });
  return new Date(value).toLocaleDateString(currentLocale());
}
