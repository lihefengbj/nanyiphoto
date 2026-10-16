import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateSpecs } from "./validate-specs.mjs";

const catalog = JSON.parse(readFileSync(new URL("../config/specs.example.json", import.meta.url), "utf8"));
const errors = validateSpecs(catalog);
if (errors.length) throw new Error(errors.join("\n"));
mkdirSync(new URL("../miniprogram/data/", import.meta.url), { recursive: true });
const filename = fileURLToPath(new URL("../miniprogram/data/specs.js", import.meta.url));
writeFileSync(filename, `// Generated draft preview; never a release catalog.\nmodule.exports = ${JSON.stringify(catalog, null, 2)};\n`);
console.log("Synced draft preview; all examples remain disabled.");
