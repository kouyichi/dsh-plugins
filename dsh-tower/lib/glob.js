/**
 * Minimal picomatch-style glob matcher for tower mission scopes.
 * Supports: `**` (crosses directories), `*` (within a segment), `?`,
 * and multiple patterns (match if ANY pattern matches).
 */

function segmentRegex(seg) {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") {
      // `**` handled at pattern level; here `*` = any run within segment
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}-".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return out;
}

/** Convert a glob pattern to a RegExp. */
export function globToRegExp(pattern) {
  const segs = String(pattern).split("/");
  let re = "^";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === "**") {
      if (i === segs.length - 1) re += ".*";          // trailing ** matches everything below
      else re += "(?:.*/)?";                          // **/ crosses directories
    } else {
      re += segmentRegex(seg);
      if (i < segs.length - 1) re += "/";
    }
  }
  re += "$";
  return new RegExp(re);
}

/** True when `path` matches at least one pattern. */
export function matchAny(patterns, path) {
  const p = String(path).replace(/^\.\//, "");
  for (const pat of patterns) {
    const r = globToRegExp(pat);
    if (r.test(p)) return true;
    // A bare directory pattern should also cover its contents
    // (picomatch semantics: `src` matches `src` only; `src/**` matches contents)
  }
  return false;
}

/** Conservative stem for scope-overlap detection (Kimi Tower protocol). */
export function scopeStem(raw) {
  let s = String(raw);
  while (s.endsWith("*") || s.endsWith("/")) s = s.slice(0, -1);
  return s;
}
