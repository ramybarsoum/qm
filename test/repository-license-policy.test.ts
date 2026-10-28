import { test } from "node:test";
import { tmpdir } from "node:os";
import { apacheLicenseOffenders } from "./support/license-policy.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";

const apache = ["Apache", " License\nVersion 2.0, January 2004\nhttps://www.apache.org/licenses/\n"].join("");
const mit = "MIT License\nCopyright Example Authors\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export async function licenseCases(
  policy: (root: string, tracked: string[]) => string[],
  sandbox: string,
  run: (name: string, fn: () => void | Promise<void>) => Promise<unknown>,
) {
  const fixture = () => {
    const root = mkdtempSync(join(sandbox, "license-"));
    const files = new Map([["skills-seed/demo/LICENSE", mit]]);
    const put = (path: string, text: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
      files.set(path, text);
    };
    for (const [path, text] of files) put(path, text);
    const declare = (spdx = "Apache-2.0", changes = {}) => {
      put("deploy/layers/example/vendor/LICENSE", spdx === "MIT" ? mit : apache);
      put(
        "deploy/layers/example/LICENSE-PACKAGES.json",
        JSON.stringify({
          version: 1,
          packages: [
            { root: "vendor", licenseFile: "LICENSE", spdx, sha256: sha(spdx === "MIT" ? mit : apache), ...changes },
          ],
        }),
      );
    };
    const check = () => assert.deepEqual(policy(root, [...files.keys()]), []);
    return { root, files, put, declare, check };
  };
  await run("license: ordinary MIT remains valid", () => fixture().check());
  await run("license: declared retained Apache package is accepted", () => {
    const f = fixture();
    f.declare();
    f.put("deploy/layers/example/vendor/source.txt", apache);
    f.check();
  });
  await run("license: seed Apache remains rejected", () => {
    const f = fixture();
    f.put("skills-seed/demo/LICENSE", apache);
    assert.throws(f.check);
  });
  await run("license: core Apache remains rejected despite nested package metadata", () => {
    const f = fixture();
    f.put("src/vendor/LICENSE", apache);
    f.put("src/vendor/package.json", "{}");
    assert.throws(f.check);
  });
  await run("license: undeclared layer Apache is rejected", () => {
    const f = fixture();
    f.put("deploy/layers/example/vendor/LICENSE", apache);
    assert.throws(f.check);
  });
  await run("license: MIT declaration cannot exempt Apache sibling", () => {
    const f = fixture();
    f.declare("MIT");
    f.put("deploy/layers/example/vendor/source.txt", apache);
    assert.throws(f.check);
  });
  await run("license: declared MIT package remains valid", () => {
    const f = fixture();
    f.declare("MIT");
    f.put("deploy/layers/example/vendor/source.txt", "plain");
    f.check();
  });
  await run("license: mismatched hash is rejected", () => {
    const f = fixture();
    f.declare("Apache-2.0", { sha256: "0".repeat(64) });
    assert.throws(f.check);
  });
  await run("license: mismatched SPDX is rejected", () => {
    const f = fixture();
    f.declare("Apache-2.0", { spdx: "MIT" });
    assert.throws(f.check);
  });
  await run("license: unsupported SPDX is rejected", () => {
    const f = fixture();
    f.declare("Apache-2.0", { spdx: "Unknown" });
    assert.throws(f.check);
  });
  await run("license: package traversal is rejected", () => {
    const f = fixture();
    f.declare("Apache-2.0", { root: "../../../src" });
    assert.throws(f.check);
  });
  await run("license: license traversal is rejected", () => {
    const f = fixture();
    f.declare("Apache-2.0", { licenseFile: "../LICENSE" });
    assert.throws(f.check);
  });
  await run("license: missing retained license is rejected", () => {
    const f = fixture();
    f.declare("Apache-2.0", { licenseFile: "ABSENT" });
    assert.throws(f.check);
  });
  await run("license: untracked retained license is rejected", () => {
    const f = fixture();
    f.declare();
    f.files.delete("deploy/layers/example/vendor/LICENSE");
    assert.throws(f.check);
  });
  await run("license: overlapping package roots are rejected", () => {
    const f = fixture();
    f.declare();
    f.put("deploy/layers/example/vendor/child/LICENSE", apache);
    const item = { root: "vendor", licenseFile: "LICENSE", spdx: "Apache-2.0", sha256: sha(apache) };
    f.put(
      "deploy/layers/example/LICENSE-PACKAGES.json",
      JSON.stringify({ version: 1, packages: [item, { ...item, root: "vendor/child" }] }),
    );
    assert.throws(f.check);
  });
  await run("license: manifest ancestor symlink is rejected", () => {
    const f = fixture();
    const outside = mkdtempSync(join(sandbox, "outside-"));
    mkdirSync(join(f.root, "deploy/layers"), { recursive: true });
    symlinkSync(outside, join(f.root, "deploy/layers/example"));
    f.declare();
    assert.throws(f.check);
  });
  await run("license: package ancestor symlink is rejected", () => {
    const f = fixture();
    mkdirSync(join(f.root, "deploy/layers/example"), { recursive: true });
    const outside = mkdtempSync(join(sandbox, "outside-"));
    symlinkSync(outside, join(f.root, "deploy/layers/example/vendor"));
    f.declare();
    assert.throws(f.check);
  });
  await run("license: retained license leaf symlink is rejected", () => {
    const f = fixture();
    f.declare("Apache-2.0", { licenseFile: "LINK" });
    symlinkSync("LICENSE", join(f.root, "deploy/layers/example/vendor/LINK"));
    f.files.set("deploy/layers/example/vendor/LINK", apache);
    assert.throws(f.check);
  });
  await run("license: Apache outside declared package is rejected", () => {
    const f = fixture();
    f.declare();
    f.put("deploy/layers/example/other.txt", apache);
    assert.throws(f.check);
  });
  await run("license: unknown manifest fields are rejected", () => {
    const f = fixture();
    f.declare();
    f.put("deploy/layers/example/LICENSE-PACKAGES.json", JSON.stringify({ version: 1, packages: [], ignored: true }));
    assert.throws(f.check);
  });
}

const sandbox = mkdtempSync(join(tmpdir(), "qm-repository-license-"));
await licenseCases(apacheLicenseOffenders, sandbox, async (name, fn) => {
  await test(name, fn);
});

export async function extraLicenseCases(
  policy: (root: string, tracked: string[]) => string[],
  sandbox: string,
  run: (name: string, fn: () => void | Promise<void>) => Promise<unknown>,
) {
  const fixture = () => {
    const root = mkdtempSync(join(sandbox, "links-"));
    const files = new Set<string>();
    const put = (path: string, text: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
      files.add(path);
    };
    const apache = ["Apache", " License\nVersion 2.0, January 2004\n"].join("");
    put("deploy/layers/example/vendor/LICENSE", apache);
    put(
      "deploy/layers/example/LICENSE-PACKAGES.json",
      JSON.stringify({
        version: 1,
        packages: [{ root: "vendor", licenseFile: "LICENSE", spdx: "Apache-2.0", sha256: sha(apache) }],
      }),
    );
    const check = () => assert.deepEqual(policy(root, [...files]), []);
    return { root, files, put, check, apache };
  };
  await run("license: contained tracked source alias is read as link data", () => {
    const f = fixture();
    f.put("deploy/layers/example/vendor/source.txt", "plain");
    symlinkSync("source.txt", join(f.root, "deploy/layers/example/vendor/ALIAS"));
    f.files.add("deploy/layers/example/vendor/ALIAS");
    f.check();
  });
  await run("license: external source alias is read as link data without reading target", () => {
    const f = fixture();
    const outside = mkdtempSync(join(sandbox, "outside-"));
    const target = join(outside, "unreadable.txt");
    writeFileSync(target, f.apache);
    chmodSync(target, 0o000);
    symlinkSync(target, join(f.root, "deploy/layers/example/vendor/ALIAS"));
    f.files.add("deploy/layers/example/vendor/ALIAS");
    try {
      f.check();
    } finally {
      chmodSync(target, 0o600);
    }
  });
  await run("license: source alias cannot authorize a linked retained license", () => {
    const f = fixture();
    symlinkSync("LICENSE", join(f.root, "deploy/layers/example/vendor/LINK"));
    f.files.add("deploy/layers/example/vendor/LINK");
    f.put(
      "deploy/layers/example/LICENSE-PACKAGES.json",
      JSON.stringify({
        version: 1,
        packages: [{ root: "vendor", licenseFile: "LINK", spdx: "Apache-2.0", sha256: sha(f.apache) }],
      }),
    );
    assert.throws(f.check);
  });
}

await extraLicenseCases(apacheLicenseOffenders, sandbox, async (name, fn) => {
  await test(name, fn);
});
