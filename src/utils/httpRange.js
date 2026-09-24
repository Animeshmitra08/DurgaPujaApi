/**
 * Resolve a single-range `Range: bytes=...` header against a known file size.
 *
 * The stream endpoint answers ranges from the size stored in MongoDB rather
 * than from whatever Drive echoes back: Drive's Content-Length/Content-Range
 * are not reliably surfaced through gaxios, and a 206 without Content-Range
 * (or a 200 without Content-Length) leaves <audio> unable to play or to work
 * out a duration.
 *
 * @param {string|undefined} header raw Range header
 * @param {number} size total size of the resource in bytes
 * @returns {null | {start: number, end: number} | {unsatisfiable: true}}
 *   null when the whole resource should be served (no header, a malformed
 *   one, or a multi-range request - all of which RFC 9110 lets us answer
 *   with a plain 200).
 */
export const parseRange = (header, size) => {
  if (!header || !Number.isFinite(size) || size < 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start;
  let end;

  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0) return { unsatisfiable: true };
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (start >= size || start > end) return { unsatisfiable: true };

  return { start, end };
};
