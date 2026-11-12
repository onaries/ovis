import type { ConversationTurn } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";

/** OmO's uncached input/output counters; cached input only contributes to the hit rate. */
export function TurnUsage({ usage }: { usage: ConversationTurn["usage"] }) {
  const t = useT();
  if (usage === undefined) return null;
  const input = usage.input + usage.cache_read + usage.cache_write;
  const number = (value: number) => new Intl.NumberFormat("en", { notation: "compact", minimumFractionDigits: value >= 1000 ? 1 : 0, maximumFractionDigits: 1 }).format(value).toLowerCase();
  const exact = (value: number) => new Intl.NumberFormat().format(value);
  return <span className="chat-turn-usage">
    <span title={`${t("Input")}: ${exact(usage.input)} · ${t("Input including cache")}: ${exact(input)}`} aria-label={`${t("Input")}: ${exact(usage.input)}`}>
      ↑{number(usage.input)}
    </span>
    <span title={`${t("Output")}: ${exact(usage.output)}`} aria-label={`${t("Output")}: ${exact(usage.output)}`}>
      ↓{number(usage.output)}
    </span>
    {input > 0 && <span title={`${t("Cache hit rate")}: ${exact(usage.cache_read)} / ${exact(input)}`}>
      · {t("Cache")} {new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(usage.cache_read / input)}
    </span>}
  </span>;
}
