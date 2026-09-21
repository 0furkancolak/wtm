/**
 * The one adjustment a TOML document read from a file needs before a parser sees it.
 *
 * It lives in its own module because more than one command reads a user-authored `wtm.toml` from
 * disk — the config loader, `wtm init`, `wtm detect`, `wtm changes` — and each of them decoding
 * the file correctly and then failing on the same invisible character is the shape of bug that
 * gets fixed three times and missed once.
 */

/** UTF-8's byte order mark, as it survives decoding into a string. */
const byteOrderMark = 0xfeff;

/**
 * The document without a leading byte order mark.
 *
 * Reading a file as UTF-8 does not remove the mark; it arrives as a `U+FEFF` at index 0. TOML has
 * no rule that skips it, so a parser reads it as the first character of the first key and rejects
 * the entire document — with a syntax error pointing at a line that is visibly correct, which is
 * the worst possible message for a character an editor does not display. Several editors write the
 * mark by default, and a configuration saved by one of them is the same configuration to the
 * person who wrote it.
 *
 * Only a *leading* mark is removed. Anywhere else `U+FEFF` is a character inside the document, and
 * deleting it would change what the configuration says in order to make it parse.
 */
export function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === byteOrderMark ? text.slice(1) : text;
}
