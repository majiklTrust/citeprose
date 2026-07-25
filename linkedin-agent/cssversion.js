import fs from "fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const current = pkg.config.cssversion;
const [major] = current.split(".").map(Number);

pkg.config.cssversion = `${major+1}`;

fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));
console.log("New cssversion:", pkg.config.cssversion);
