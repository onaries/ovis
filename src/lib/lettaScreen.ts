/**
 * The work on a Letta Code screen, without the chrome Letta draws under it (letta-code 0.34.23,
 * recorded in src/lib/fixtures-letta-screens): at the bottom an input box between two rules, its
 * first row Letta's `›` prompt (with what the user is typing), and one status row under it
 * (`Letta Code · <model>`, two when the terminal wraps it); while a turn runs, the rows a tip hangs
 * (`└`) under the spinner row (`… (esc to interrupt)`) just above the box. A screen in any other
 * shape is returned as it is: nothing is cut on a guess.
 */
const RULE = /^─{20,}$/;
const PROMPT = /^›/;
const STATUS_ROWS = 2;
const HANGING = /^\s+└/;
const SPINNER = /\(esc to interrupt/;

export function lettaScreenWork(screen: string): string {
  const rows = screen.split("\n");
  const bare = rows.map((row) => row.trimEnd());
  let end = bare.length;
  while (end > 0 && bare[end - 1] === "") end--;
  // the rule over the status row: the status row and nothing else below it
  let lower = -1;
  for (let row = end - 1; row >= Math.max(0, end - 1 - STATUS_ROWS); row--) if (RULE.test(bare[row]!)) { lower = row; break; }
  if (lower < 0 || lower === end - 1) return screen;
  // the rule over the input box, whose first row is the prompt
  let upper = -1;
  for (let row = lower - 1; row >= 0; row--) if (RULE.test(bare[row]!)) { upper = row; break; }
  if (upper < 0 || upper === lower - 1 || !PROMPT.test(bare[upper + 1]!)) return screen;
  let work = upper;
  while (work > 0 && bare[work - 1] === "") work--;
  let hung = work;
  while (hung > 0 && HANGING.test(bare[hung - 1]!)) hung--;
  if (hung < work && hung > 0 && SPINNER.test(bare[hung - 1]!)) work = hung;
  return rows.slice(0, work).join("\n");
}
