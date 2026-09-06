#!/usr/bin/env node
// strip-html-comments.js
//
// Removes everything between <!-- and --> (the markers included) from
// HTML files. Operates ONLY on files whose name ends in .html.
//
// This is a blanket strip: any <!-- ... --> is removed wherever it
// appears, including multi-line blocks and blocks that contain markup.
// It does not distinguish descriptive comments from commented-out HTML;
// both go. It also does not special-case <script>/<style> bodies, so do
// not run it on files that embed JavaScript or CSS containing the
// literal sequence <!-- ... --> unless you mean to strip that too.
//
// Usage:
//   node strip-html-comments.js <path> [<path> ...]
//     <path> may be a .html file or a directory (recursed).
//   Flags:
//     --in-place   overwrite each file (default is a dry run: report only)
//     --write      alias for --in-place
//
// Dry run (default) prints how many comments and bytes WOULD be removed
// per file and changes nothing. Add --in-place to actually rewrite.

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const inPlace = args.includes("--in-place") || args.includes("--write");
const targets = args.filter((a) => !a.startsWith("--"));

if (targets.length === 0) {
  console.error("usage: node strip-html-comments.js <file-or-dir> [...] [--in-place]");
  process.exit(1);
}

// Matches <!-- ... --> across newlines, non-greedy so adjacent comments
// are not merged into one match.
const COMMENT = /<!--[\s\S]*?-->/g;

function collectHtmlFiles(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) {
      // skip the usual noise directories
      if (name === "node_modules" || name === ".git") continue;
      collectHtmlFiles(path.join(p, name), out);
    }
  } else if (st.isFile() && p.toLowerCase().endsWith(".html")) {
    out.push(p);
  }
}

const files = [];
for (const t of targets) {
  try {
    collectHtmlFiles(t, files);
  } catch (e) {
    console.error(`skip ${t}: ${e.message}`);
  }
}

if (files.length === 0) {
  console.error("no .html files found in the given paths");
  process.exit(1);
}

let totalComments = 0;
let totalBytes = 0;

for (const f of files) {
  const before = fs.readFileSync(f, "utf8");
  const matches = before.match(COMMENT) || [];
  const after = before.replace(COMMENT, "");
  const removedBytes = Buffer.byteLength(before) - Buffer.byteLength(after);
  totalComments += matches.length;
  totalBytes += removedBytes;

  if (matches.length === 0) {
    console.log(`  ${f}: no comments`);
    continue;
  }

  if (inPlace) {
    fs.writeFileSync(f, after);
    console.log(`  ${f}: removed ${matches.length} comment(s), ${removedBytes} bytes`);
  } else {
    console.log(`  ${f}: WOULD remove ${matches.length} comment(s), ${removedBytes} bytes`);
  }
}

console.log(
  `${inPlace ? "removed" : "would remove"} ${totalComments} comment(s), ` +
  `${totalBytes} bytes across ${files.length} file(s)` +
  (inPlace ? "" : "   (dry run; add --in-place to apply)")
);
