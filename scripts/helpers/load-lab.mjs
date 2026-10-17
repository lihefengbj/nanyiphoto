import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const filename = new URL("../../miniprogram/pages/lab/lab.js", import.meta.url);
const require = createRequire(filename);

export function loadLab(wx) {
  let page;
  const context = createContext({ wx, require, setTimeout, clearTimeout, Page(value) { page = value; } });
  new Script(readFileSync(filename, "utf8")).runInContext(context);
  page.data = { ...page.data };
  page.setData = (value) => { Object.assign(page.data, value); };
  page.alive = true;
  page.ownedExports = new Set();
  page.pendingCleanup = new Set();
  page.cleanupJobs = new Map();
  return page;
}
