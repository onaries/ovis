import type { ConversationTurn } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";

/** The answer's model requests, including cached input; child-task usage is separate. */
export function TurnUsage({ usage }: { usage: ConversationTurn["usage"] }) {
  const t = useT();
  if (usage === undefined) return null;
  const input = usage.input + usage.cache_read + usage.cache_write;
  const number = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const exact = (value: number) => new Intl.NumberFormat().format(value);
  return <span className="chat-turn-usage">
    <span title={`${t("Input")}: ${exact(input)}`} aria-label={`${t("Input")}: ${exact(input)}`}>
      {t("Input")} {number(input)}
    </span>
    <span title={`${t("Output")}: ${exact(usage.output)}`} aria-label={`${t("Output")}: ${exact(usage.output)}`}>
      {t("Output")} {number(usage.output)}
    </span>
    {input > 0 && <span title={`${t("Cache hit rate")}: ${exact(usage.cache_read)} / ${exact(input)}`}>
      {t("Cache hit rate")} {new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(usage.cache_read / input)}
    </span>}
  </span>;
}
