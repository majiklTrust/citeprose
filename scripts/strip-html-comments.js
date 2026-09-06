#!/usr/bin/env node
// strip-html-comments.js
// Removes HTML comments (<!-- ... -->) but leaves the contents of
// <script> and <style> blocks alone, where the same characters are
// code, not comments.
//
// Usage:
//   node strip-html-comments.js input.html > output.html
//   node strip-html-comments.js input.html --in-place

const fs = require("fs");

const file = process.argv[2];
const inPlace = process.argv.includes("--in-place");
if (!file) {
  console.error("usage: node strip-html-comments.js <file.html> [--in-place]");
  process.exit(1);
}

const html = fs.readFileSync(file, "utf8");

// Split on script/style blocks so we can skip their bodies. The block
// delimiters themselves stay; only the text OUTSIDE them is stripped.
const parts = html.split(/(<(script|style)\b[^>]*>[\s\S]*?<\/\2>)/gi);

const out = parts
  .map((part, i) => {
    // Every 3rd element (i % 3 === 1) is a full script/style block;
    // i % 3 === 2 is the captured tag name. Leave both alone.
    if (i % 3 !== 0) return part;
    // Plain HTML: remove comments, but never the doctype/conditional
    // downlevel-revealed ones are already gone by this simple rule.
    return part.replace(/<!--[\s\S]*?-->/g, "");
  })
  .join("");

if (inPlace) {
  fs.writeFileSync(file, out);
  console.error(`stripped comments in ${file}`);
} else {
  process.stdout.write(out);
}