import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = fileURLToPath(new URL("../miniprogram/", import.meta.url));
const app = JSON.parse(readFileSync(resolve(root, "app.json"), "utf8"));
const errors = [];
if (new Set(app.pages).size !== app.pages.length) errors.push("Duplicate app page.");
for (const page of app.pages) {
  for (const extension of ["js", "json", "wxml", "wxss"]) {
    if (!existsSync(resolve(root, `${page}.${extension}`))) errors.push(`Missing ${page}.${extension}`);
  }
}
function visit(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const filename = resolve(directory, item.name);
    if (item.isDirectory()) visit(filename);
    else {
      const text = readFileSync(filename, "utf8");
      if (extname(filename) === ".json") JSON.parse(text);
      if (extname(filename) === ".js") {
        new Script(`(function(require,module,exports,App,Page,Component,wx,getCurrentPages){\n${text}\n})`, { filename });
        for (const match of text.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
          if (!existsSync(resolve(dirname(filename), `${match[1]}.js`))) errors.push(`Missing require ${match[1]}`);
        }
      }
    }
  }
}
visit(root);
if (errors.length) throw new Error(errors.join("\n"));
console.log(`Checked ${app.pages.length} page bundles, JSON, JS syntax and relative dependencies (not a WeChat runtime test).`);
