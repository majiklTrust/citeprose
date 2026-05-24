/*
node do_md_toc.js <notoc.md>
*/
const fs = require("fs");

function generateTOC(filename) {
  // --- 0. Validate .md extension (case-insensitive) ---
  if (!/\.md$/i.test(filename)) {
    console.error("Error: The file must have a .md extension.");
    process.exit(1);
  }

  const md = fs.readFileSync(filename, "utf8");
  const lines = md.split("\n");

  // --- 1. Detect existing TOC ---
  const hasTOC = lines.some(line => /^##\s+Table of Contents/i.test(line));
  if (hasTOC) {
    console.log("TOC already exists — no changes made.");
    return;
  }

  const tocEntries = [];
  const newLines = [];

  for (const line of lines) {
    // Match only H2 headings
    if (/^##\s+/.test(line) && !/^##\s+(Response:|Prompt)/i.test(line)) {
      const text = line.replace(/^##\s*/, "").trim();

      // GitHub-style anchor generation (correct double-hyphen behavior)
      const anchor = text
        .toLowerCase()
        .replace(/\s+/g, "-")        // spaces → hyphens FIRST
        .replace(/[^a-z0-9-]/g, ""); // strip punctuation, keep hyphens

      // Add TOC entry
      tocEntries.push(`- [${text}](#${anchor})`);

      // Keep original heading line (anchor stays valid)
      newLines.push(line);

      // Add backlink on its own line (does NOT affect anchor)
      newLines.push(`[back to top ↩](#table-of-contents)`);
    } else {
      newLines.push(line);
    }
  }

  const tocBlock = `## Table of Contents\n${tocEntries.join("\n")}\n\n`;
  const newContent = tocBlock + newLines.join("\n");

  fs.writeFileSync(filename, newContent, "utf8");
  console.log(`TOC + backlinks inserted into ${filename}`);
}

const filename = process.argv[2];
if (!filename) {
  console.error("Usage: node toc.js <filename.md>");
  process.exit(1);
}

generateTOC(filename);

/** TOC only **/
// const fs = require("fs");

// function generateTOC(filename) {
//   const md = fs.readFileSync(filename, "utf8");
//   const lines = md.split("\n");

//   const toc = lines
//     // Only match H2 headings: "## Something"
//     .filter(line => /^##\s+/.test(line))
//     // Exclude specific headings
//     .filter(line => !/^##\s+(Response:|Prompt)/i.test(line))
//     .map(line => {
//       const text = line.replace(/^##\s*/, "").trim();

//       // Anchor generation to match GitHub-style behavior
//       const anchor = text
//         .trim()
//         .toLowerCase()
//         .replace(/\s+/g, "-")      // spaces → hyphens first
//         .replace(/[^a-z0-9-]/g, ""); // then strip punctuation, keep hyphens

//       return `- [${text}](#${anchor})`;
//     })
//     .join("\n");

//   const newContent = `## Table of Contents\n${toc}\n\n${md}`;
//   fs.writeFileSync(filename, newContent, "utf8");

//   console.log(`TOC inserted at top of ${filename}`);
// }

// const filename = process.argv[2];
// if (!filename) {
//   console.error("Usage: node toc.js <filename.md>");
//   process.exit(1);
// }

// generateTOC(filename);
