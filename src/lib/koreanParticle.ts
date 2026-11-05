/**
 * 을 or 를 after a name, by how its last sound ends: a Hangul syllable by its final consonant, a
 * digit by its Korean reading (영 일 삼 육 칠 팔 end in one), a Latin letter by how the word is
 * usually read ("MacBook" 맥북을, "Air" 에어를). Anything after the last letter or digit (a
 * bracket, a dot) is skipped; a name with neither takes 를.
 */
const DIGIT_ENDS_IN_CONSONANT = new Set(["0", "1", "3", "6", "7", "8"]);
const LATIN_ENDS_IN_CONSONANT = new Set(["b", "c", "g", "k", "l", "m", "n", "p", "t"]);

export function objectParticle(name: string): "을" | "를" {
  const last = [...name].reverse().find((char) => /[\p{L}\p{N}]/u.test(char));
  if (last === undefined) return "를";
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? "를" : "을";
  if (/\d/.test(last)) return DIGIT_ENDS_IN_CONSONANT.has(last) ? "을" : "를";
  return LATIN_ENDS_IN_CONSONANT.has(last.toLowerCase()) ? "을" : "를";
}
