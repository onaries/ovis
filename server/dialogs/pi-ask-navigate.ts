import { KEY, type ParsedPrompt } from "./shared.ts";

/** Switch only native tabs, observing every move; this path never sends text, Enter or Space. */
export async function navigatePiAsk(initial: ParsedPrompt, target: number, io: {
  read(): Promise<ParsedPrompt | null>;
  send(key: string): Promise<void>;
  active(): boolean;
  deadline: number;
}): Promise<boolean> {
  const form = initial.piAskForm;
  if (!form || !Number.isInteger(target) || target < 0 || target === form.index
    || !initial.steps?.[target]?.can_navigate) return false;
  let previous = initial;
  let index = form.index;
  while (index !== target) {
    if (!io.active() || Date.now() >= io.deadline) return false;
    // The request's first read can already be stale; recheck before the first arrow too.
    const before = await io.read();
    if (!before || before.piAskForm?.identity !== form.identity || before.piAskForm.index !== index
      || before.id !== previous.id || !io.active()) return false;
    const direction = target > index ? 1 : -1;
    await io.send(direction === 1 ? KEY.right : KEY.left);
    const expected = index + direction;
    let moved = false;
    while (io.active() && Date.now() < io.deadline) {
      const shown = await io.read();
      if (!shown || shown.piAskForm?.identity !== form.identity) return false;
      if (shown.piAskForm.index === expected) { previous = shown; index = expected; moved = true; break; }
      if (shown.piAskForm.index !== index || shown.id !== previous.id) return false;
      await Bun.sleep(Math.min(50, Math.max(0, io.deadline - Date.now())));
    }
    if (!moved) return false;
  }
  return io.active();
}
