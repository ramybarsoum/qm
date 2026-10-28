import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

export async function runRepositoryFormat(root, mode, tracked, helmPath = "helm") {
  assert.ok(mode === "--check" || mode === "--write", "expected --check or --write");
  root = resolve(root);
  tracked ??= execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const charts = tracked.filter((path) => /^deploy\/layers\/[^/]+\/.+\/Chart\.yaml$/.test(path)).map(dirname);
  const paths = [];
  const walk = (directory) => {
    for (const name of readdirSync(join(root, directory))) {
      const path = directory ? `${directory}/${name}` : name;
      const withinChart = charts.some((chart) => path === chart || path.startsWith(`${chart}/`));
      if ((name === ".git" || name === "node_modules") && !withinChart) continue;
      const value = lstatSync(join(root, path));
      assert.ok(!withinChart || !value.isSymbolicLink(), `chart paths must be ordinary: ${path}`);
      if (value.isDirectory()) walk(path);
      else if (value.isFile()) paths.push(path);
    }
  };
  walk("");
  const ignored = [join(root, ".gitignore"), join(root, ".prettierignore")];
  for (const chart of charts) {
    let current = root;
    for (const part of chart.split("/")) {
      assert.ok(part && part !== "." && part !== "..");
      current = join(current, part);
      assert.ok(
        lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(),
        "chart ancestors must be ordinary directories",
      );
    }
    assert.ok(realpathSync(current).startsWith(realpathSync(root) + sep));
    const descriptor = lstatSync(join(current, "Chart.yaml"));
    assert.ok(descriptor.isFile() && !descriptor.isSymbolicLink(), "tracked Chart.yaml must be ordinary");
  }
  const templates = paths.filter((path) => charts.some((chart) => path.startsWith(`${chart}/templates/`)));
  const helmFiles = new Set(templates);
  const failed = [];
  let prettierFiles = 0;
  for (const path of paths) {
    const absolute = join(root, path);
    const info = await prettier.getFileInfo(absolute, { ignorePath: ignored, withNodeModules: false });
    if (helmFiles.has(path)) {
      const text = readFileSync(absolute, "utf8");
      if (/\t|[ \t]+$/m.test(text) || (text.length > 0 && !text.endsWith("\n"))) failed.push(path);
      continue;
    }
    if (info.ignored) continue;
    assert.ok(!/^deploy\/layers\/[^/]+\/.*\.tpl$/.test(path), `template outside a tracked chart: ${path}`);
    if (!info.inferredParser) continue;
    prettierFiles++;
    const config = (await prettier.resolveConfig(absolute, { editorconfig: true })) ?? {};
    const text = readFileSync(absolute, "utf8");
    const options = { ...config, filepath: absolute };
    if (mode === "--write") writeFileSync(absolute, await prettier.format(text, options));
    else if (!(await prettier.check(text, options))) failed.push(path);
  }
  if (templates.length) {
    const home = mkdtempSync(join(tmpdir(), "qm-helm-format-"));
    const helm = (args) =>
      execFileSync(helmPath, args, {
        cwd: root,
        env: {
          ...process.env,
          KUBECONFIG: "/dev/null",
          HELM_PLUGINS: join(home, "plugins"),
          HELM_CONFIG_HOME: join(home, "config"),
          HELM_CACHE_HOME: join(home, "cache"),
          HELM_DATA_HOME: join(home, "data"),
        },
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 16 * 1024 * 1024,
      });
    for (const chart of charts.filter((chart) => templates.some((path) => path.startsWith(`${chart}/templates/`)))) {
      const values = paths.filter((path) => path.startsWith(`${chart}/ci/`) && /-values\.ya?ml$/.test(path));
      for (const value of values.length ? values : [null]) {
        const flags = value ? ["--values", join(root, value)] : [];
        helm(["lint", "--strict", chart, ...flags]);
        const rendered = helm(["template", "format-contract", chart, ...flags]);
        await prettier.format(rendered, { parser: "yaml" });
      }
    }
  }
  assert.equal(failed.length, 0, `formatting failures: ${failed.join(", ")}`);
  return { prettierFiles, helmTemplateFiles: templates.length, chartRoots: charts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3);
  console.log(JSON.stringify(await runRepositoryFormat(process.cwd(), process.argv[2])));
}
