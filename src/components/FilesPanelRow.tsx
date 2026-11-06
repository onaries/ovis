import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsRow, Toggle } from "./SettingsControls.tsx";

/** Settings → Chat → Files beside the pane: Browse files as a panel right of the pane on a wide window (#1666). */
export function FilesPanelRow() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsRow label={t("Files beside the pane")} description={t("On a wide window, Browse files opens as a panel on the right of the pane instead of a popup. With Open files set to Beside the pane, a file opened from it shows in its place, and closing the file brings the list back.")}>
      <Toggle label={t("Files beside the pane")} checked={settings.filesPanel} onChange={(filesPanel) => update({ filesPanel })} />
    </SettingsRow>
  );
}

/** Settings → Chat → Documents in Files: the Documents tab of Files (components/MarkdownDocuments.tsx, #1196), off by default. */
export function FilesDocumentsRow() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsRow label={t("Documents in Files")} description={t("Files shows a Documents tab: the Markdown files under the pane's folder, newest first, with a filter. Each one opens in the file viewer to read.")}>
      <Toggle label={t("Documents in Files")} checked={settings.filesDocuments} onChange={(filesDocuments) => update({ filesDocuments })} />
    </SettingsRow>
  );
}
