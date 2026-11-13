import { PanelRight } from "lucide-react";

import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsRow, Toggle } from "./SettingsControls.tsx";

/** Settings → Chat → Files beside the pane: Browse files as a panel right of the pane on a wide window (#1666). */
export function FilesPanelRow() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsRow icon={PanelRight} label={t("Files beside the pane")} description={t("On a wide window, Browse files opens as a panel to the right of the pane and not as a popup. With Open files on Beside the pane, a file opened from the list takes its place, and closing the file brings the list back.")}>
      <Toggle label={t("Files beside the pane")} checked={settings.filesPanel} onChange={(filesPanel) => update({ filesPanel })} />
    </SettingsRow>
  );
}

