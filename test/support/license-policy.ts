import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export function apacheLicenseOffenders(root: string, tracked: string[]): string[] {
  const physicalRoot = realpathSync(root);
  const paths = new Set(tracked);
  const packages: { prefix: string; spdx: "MIT" | "Apache-2.0" }[] = [];
  const safeRelative = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.split("/").every((part) => part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part));
  const readTracked = (path: string, ordinary: boolean): Buffer => {
    assert.ok(
      paths.has(path) &&
        !path.startsWith("/") &&
        !path.split("/").some((part) => part === ".." || !part || part.includes("\\")),
    );
    let current = physicalRoot;
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const value = lstatSync(current);
      if (index < parts.length - 1) {
        assert.ok(value.isDirectory() && !value.isSymbolicLink(), `${path} must have ordinary ancestors`);
      } else if (value.isSymbolicLink()) {
        assert.ok(!ordinary, `${path} must be an ordinary retained input`);
        return Buffer.from(readlinkSync(current), "utf8");
      } else {
        assert.ok(value.isFile(), `${path} must be an ordinary file or tracked source link`);
      }
    }
    const physical = realpathSync(current);
    assert.ok(physical.startsWith(physicalRoot + sep), `${path} escapes the repository`);
    return readFileSync(physical);
  };
  for (const manifest of tracked.filter((path) => /^deploy\/layers\/[^/]+\/LICENSE-PACKAGES\.json$/.test(path))) {
    let context = manifest;
    try {
      const declared: unknown = JSON.parse(readTracked(manifest, true).toString("utf8"));
      assert.ok(declared && typeof declared === "object" && !Array.isArray(declared));
      const data = declared as { version: unknown; packages: unknown };
      assert.deepEqual(Object.keys(data).sort(), ["packages", "version"]);
      assert.equal(data.version, 1);
      assert.ok(Array.isArray(data.packages));
      for (const [index, item] of data.packages.entries()) {
        context = `${manifest}: package[${index}]`;
        assert.ok(item && typeof item === "object" && !Array.isArray(item));
        assert.deepEqual(Object.keys(item).sort(), ["licenseFile", "root", "sha256", "spdx"]);
        assert.ok(safeRelative(item.root) && safeRelative(item.licenseFile));
        assert.ok(item.spdx === "MIT" || item.spdx === "Apache-2.0");
        const prefix = `${dirname(manifest)}/${item.root}/`;
        context = `${manifest}: package ${item.root}, license ${prefix + item.licenseFile}`;
        assert.equal(typeof item.sha256, "string");
        assert.match(item.sha256, /^[a-f0-9]{64}$/);
        assert.ok(
          packages.every((other) => !prefix.startsWith(other.prefix) && !other.prefix.startsWith(prefix)),
          "license package boundaries must not overlap",
        );
        const license = readTracked(prefix + item.licenseFile, true);
        assert.equal(createHash("sha256").update(license).digest("hex"), item.sha256);
        const text = license.toString("utf8");
        if (item.spdx === "MIT") {
          assert.match(text, /MIT License/);
          assert.ok(!text.includes(["Apache", " License"].join("")));
        } else {
          assert.match(text, /Apache\s+License[\s\S]*Version\s+2\.0(?=[\s,]|$)/);
        }
        packages.push({ prefix, spdx: item.spdx });
      }
    } catch (cause) {
      throw new Error(`License validation failed for ${context}`, { cause });
    }
  }
  return tracked.filter((path) => {
    if (path.endsWith("package-lock.json") || path === "test/skills-seed.test.ts") return false;
    const boundary = packages.find((item) => path.startsWith(item.prefix));
    const text = readTracked(path, false).toString("utf8");
    return boundary?.spdx !== "Apache-2.0" && text.includes(["Apache", " License"].join(""));
  });
}
