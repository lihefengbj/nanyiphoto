import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments, prepareDeviceLab, privateUrls } from "./start-matting-lab.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nanyi-device-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".data"));
  await writeFile(join(root, ".data/local-model.json"), "{}");
  return root;
}

test("launcher defaults to loopback and LAN requires an explicit flag", () => {
  assert.deepEqual(parseArguments([]), { prepare: false, lan: false, port: 8000 });
  assert.deepEqual(parseArguments(["--lan", "--port", "8100"]), { prepare: false, lan: true, port: 8100 });
  for (const args of [["--port", "0"], ["--port", "99999"], ["--lan", "--lan"], ["--other"], ["--port"]]) {
    assert.throws(() => parseArguments(args), /INVALID_LAB_ARGUMENTS/);
  }
});

test("candidate phone URLs exclude public, loopback and IPv6 addresses", () => {
  const interfaces = { en0: [
    { family: "IPv4", address: [192, 168, 1, 2].join("."), internal: false },
    { family: "IPv4", address: [8, 8, 8, 8].join("."), internal: false },
    { family: "IPv4", address: "127.0.0.1", internal: true },
    { family: "IPv6", address: "::1", internal: false }
  ] };
  assert.deepEqual(privateUrls(8000, interfaces), [`http://${[192, 168, 1, 2].join(".")}:8000`]);
});

test("preparation creates private credentials, does not touch .env or return its token", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, ".env"), "user-owned");
  const result = await prepareDeviceLab(root);
  const body = await readFile(result.file, "utf8");
  const token = /^NP_DEV_TOKEN=(.*)$/m.exec(body)[1];
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal((await stat(result.file)).mode & 0o777, 0o600);
  assert.equal(result.reused, false);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.equal(await readFile(join(root, ".env"), "utf8"), "user-owned");
  assert.match(body, /^NP_ENV=local$/m);
  assert.match(body, /^NP_MATTING_LAB=true$/m);
});

test("existing generated credentials are reused unchanged rather than silently rotated", async (t) => {
  const root = await fixture(t);
  const first = await prepareDeviceLab(root);
  const original = await readFile(first.file, "utf8");
  const second = await prepareDeviceLab(root);
  assert.equal(second.reused, true);
  assert.equal(await readFile(second.file, "utf8"), original);
});

test("invalid existing environment is preserved and cannot launch", async (t) => {
  const root = await fixture(t);
  const path = join(root, ".data/device-lab.env");
  await writeFile(path, "user-owned", { mode: 0o600 });
  await assert.rejects(prepareDeviceLab(root), /INVALID_LAB_ENVIRONMENT/);
  assert.equal(await readFile(path, "utf8"), "user-owned");
});

test("private setup refuses a credential symlink outside the data root", async (t) => {
  const root = await fixture(t);
  const outside = join(root, "outside.env");
  await writeFile(outside, "user-owned", { mode: 0o600 });
  await symlink(outside, join(root, ".data/device-lab.env"));
  await assert.rejects(prepareDeviceLab(root), /INVALID_LAB_ENVIRONMENT/);
  assert.equal(await readFile(outside, "utf8"), "user-owned");
});
