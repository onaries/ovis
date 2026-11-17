/** A shell script imported `with { type: "text" }` (scripts/join/kit.ts embeds join.sh): its text. */
declare module "*.sh" {
  const text: string;
  export default text;
}
