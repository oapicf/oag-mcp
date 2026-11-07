"use strict";
/**
 * Path and URL string helpers.
 *
 * @module util/path
 */

/**
 * Remove every trailing `/` from a string.
 *
 * A loop rather than `s.replace(/\/+$/, "")`: that regex retries from every
 * `/` in a run that is not at the end, so a long run of slashes followed by
 * anything else takes quadratic time.
 *
 * @param {String} s - URL, path or path template
 * @return {String} the string without trailing slashes
 */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") {
    end--;
  }
  return s.slice(0, end);
}
