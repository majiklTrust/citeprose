// =================================================================
// build-pages.mjs: page template builder (2.2.41.5 convention)
// =================================================================
// Convention: public_templates/{dir}-index.html builds to
// public/{dir}/index.html with the same substitutions the
// dashboard's build_html applies: {{CSSVERSION}}, {{VERSION}},
// {{APPLICATION}}. The bare index.html (dashboard) and template
// subdirectories keep their existing dedicated build steps.
// Deliveries ship templates, never generated html.
// =================================================================
import fs from "node:fs";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const subs = {
  "{{CSSVERSION}}": String((pkg.config && pkg.config.cssversion) || "0"),
  "{{VERSION}}": String(pkg.version || "0.0.0"),
  "{{APPLICATION}}": String((pkg.config && pkg.config.appname) || "")
};

const SRC = "public_templates";
let built = 0;
for (const name of fs.readdirSync(SRC)) {
  const m = /^(.+)-index\.html$/.exec(name);
  if (!m) continue;
  const srcPath = path.join(SRC, name);
  if (!fs.statSync(srcPath).isFile()) continue;
  let s = fs.readFileSync(srcPath, "utf8");
  for (const [k, v] of Object.entries(subs)) s = s.split(k).join(v);
  const outDir = path.join("public", m[1]);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "index.html"), s);
  console.log(`build-pages.mjs generated public/${m[1]}/index.html from ${name}`);
  built++;
}
if (built === 0) console.log("no page templates found (nothing to build)");

// ── JSX templates: public_templates/*.jsx build to public/*.js ──
// Same naming rule as the html family above: {dir}-{name}.jsx
// builds to public/{dir}/{name}.js; a bare {name}.jsx builds to
// public/{name}.js. React stays the CDN global; esbuild replaces
// only the retired in-browser Babel transform.
//
// ORDER MATTERS: placeholders are stamped BEFORE compilation. In a
// JSX text position a raw {{TOKEN}} parses as an object expression,
// so the source is only valid once stamped. The old babel path had
// the same order: build_html stamped the page, then the browser
// compiled it.
//
// FAIL-LOUD: the shells load these artifacts, so a missing compiler
// is a build failure, never a silent skip. Prerequisite:
//   npm install --save-dev --save-exact esbuild@0.28.2
const jsxEntries = [];
// for (const n of fs.readdirSync(SRC,{recursive:true})) {
for (const n of fs.readdirSync(SRC)) {
  const full = path.join(SRC, n);
  const st = fs.statSync(full);
  if (st.isFile() && n.endsWith(".jsx")) {
    jsxEntries.push({ name: n.replace(/\.jsx$/, ""), label: `public_templates/${n}`,
      read: () => fs.readFileSync(full, "utf8") });
  } else if (st.isDirectory()) {
    // Directory form: public_templates/<name>/ holds numbered .jsx
    // parts that concatenate in LEXICAL order into one source. The
    // parts are plain slices of one program, not modules; order is
    // the numbering's job (00-, 10-, ..., 90-mount last).
    console.log("Looking for JSX file in: " + full);
    const parts = fs.readdirSync(full).filter((p) => p.endsWith(".jsx")).sort();
    if (parts.length > 0) {
      console.log(parts);
      jsxEntries.push({ name: n, label: `public_templates/${n}/ (${parts.length} parts)`,
        read: () => parts.map((p) => fs.readFileSync(path.join(full, p), "utf8")).join("\n") });
    }
  }
}
// A file <name>.jsx and a directory <name>/ naming the same output is
// ambiguous authorship; refuse rather than let one silently win.
{
  const seen = new Set();
  for (const e of jsxEntries) {
    if (seen.has(e.name)) {
      console.error(`build-pages.mjs FATAL: duplicate jsx source name "${e.name}" (file and directory forms both present)`);
      process.exit(1);
    }
    seen.add(e.name);
  }
}
if (jsxEntries.length > 0) {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    console.error("build-pages.mjs FATAL: esbuild is required to compile "
      + jsxEntries.map((e) => e.name).join(", ")
      + ". Run: npm install --save-dev --save-exact esbuild@0.28.2");
    process.exit(1);
  }
  for (const entry of jsxEntries) {
    console.log(entry);
    const dm = /^(.+)-([^-]+)$/.exec(entry.name);
    const outDir = dm ? path.join("public", dm[1]) : "public";
    const outBase = (dm ? dm[2] : entry.name) + ".js";
    let source = entry.read();
    for (const [k, v] of Object.entries(subs)) source = source.split(k).join(v);
    const out = await esbuild.transform(source, {
      loader: "jsx",
      target: "es2020",
      minify: true,
      sourcemap: true,
      sourcefile: entry.label
    });
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, outBase);
    // External same-origin sourcemap: connect-src 'self' permits it
    // and the .map is only fetched when devtools opens.
    fs.writeFileSync(outPath, out.code + `\n//# sourceMappingURL=${outBase}.map\n`);
    fs.writeFileSync(outPath + ".map", out.map);
    console.log(`build-pages.mjs compiled ${outPath} (${out.code.length} bytes) from ${entry.label}`);
  }
}
