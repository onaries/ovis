import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsRow, Toggle } from "./SettingsControls.tsx";

/** Settings → File viewer → Markdown outline: a Preview lists its headings beside the text, marking the one being read (#636). */
export function MarkdownOutlineRow() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsRow label={t("Markdown outline")} description={t("A Markdown preview lists its headings beside the text and marks the one you are reading. On a narrow screen, the Outline button in the header opens the list.")}>
      <Toggle label={t("Markdown outline")} checked={settings.markdownOutline} onChange={(markdownOutline) => update({ markdownOutline })} />
    </SettingsRow>
  );
}
