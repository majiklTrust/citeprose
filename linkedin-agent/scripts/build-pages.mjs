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
  console.log(`built public/${m[1]}/index.html from ${name}`);
  built++;
}
if (built === 0) console.log("no page templates found (nothing to build)");
