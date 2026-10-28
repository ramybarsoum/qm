import { test } from "node:test";
import { tmpdir } from "node:os";
import { runRepositoryFormat } from "../scripts/repository-format.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

export async function formatCases(format, sandbox, helm, run) {
  const fixture = () => {
    const root = mkdtempSync(join(sandbox, "format-"));
    const tracked = [];
    const put = (path, text, track = true) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
      if (track && !tracked.includes(path)) tracked.push(path);
    };
    const chart = "deploy/layers/example/chart";
    const installChart = () => {
      put(chart + "/Chart.yaml", "apiVersion: v2\nname: fixture\nversion: 0.1.0\ndescription: Generic fixture\n");
      put(chart + "/values.yaml", "enabled: true\n");
      put(
        chart + "/templates/service.yaml",
        '{{- if .Values.enabled }}\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}\ndata:\n  value: "ok"\n{{- end }}\n',
      );
      put(chart + "/templates/_helpers.tpl", '{{- define "fixture.name" -}}fixture{{- end -}}\n');
    };
    const check = (mode) => format(root, mode ?? "--check", tracked, helm);
    const snapshot = () => {
      const result = {};
      const walk = (path) => {
        for (const name of readdirSync(join(root, path))) {
          const p = path ? path + "/" + name : name;
          if (statSync(join(root, p)).isDirectory()) walk(p);
          else
            result[p] = createHash("sha256")
              .update(readFileSync(join(root, p)))
              .digest("hex");
        }
      };
      walk("");
      return result;
    };
    return { root, tracked, put, chart, installChart, check, snapshot };
  };
  await run("format: ordinary formatted YAML passes", async () => {
    const f = fixture();
    f.put("plain.yaml", "name: example\n");
    await f.check();
  });
  await run("format: ordinary unformatted YAML is rejected", async () => {
    const f = fixture();
    f.put("plain.yaml", "name:    example\n");
    await assert.rejects(f.check());
  });
  await run("format: untracked ordinary source remains checked", async () => {
    const f = fixture();
    f.put("new.js", "const answer=42\n", false);
    await assert.rejects(f.check());
  });
  await run("format: check does not change source bytes", async () => {
    const f = fixture();
    f.put("plain.yaml", "name: example\n");
    const before = f.snapshot();
    await f.check();
    assert.deepEqual(f.snapshot(), before);
  });
  await run("format: write formats untracked ordinary source", async () => {
    const f = fixture();
    f.put("new.js", "const answer=42\n", false);
    await f.check("--write");
    assert.equal(readFileSync(join(f.root, "new.js"), "utf8"), "const answer = 42;\n");
  });
  await run("format: valid Helm grammar and tpl are validated", async () => {
    const f = fixture();
    f.installChart();
    await f.check();
  });
  await run("format: malformed Helm grammar is rejected", async () => {
    const f = fixture();
    f.installChart();
    f.put(f.chart + "/templates/service.yaml", "{{ if .Values.enabled }}\napiVersion: v1\n");
    await assert.rejects(f.check());
  });
  await run("format: malformed rendered YAML is rejected", async () => {
    const f = fixture();
    f.installChart();
    f.put(f.chart + "/templates/service.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata: [unterminated\n");
    await assert.rejects(f.check());
  });
  await run("format: source whitespace is rejected", async () => {
    const f = fixture();
    f.installChart();
    f.put(f.chart + "/templates/_helpers.tpl", '{{ define "fixture.name" }}fixture{{ end }} \n');
    await assert.rejects(f.check());
  });
  await run("format: source tabs are rejected", async () => {
    const f = fixture();
    f.installChart();
    f.put(f.chart + "/templates/_helpers.tpl", '\t{{ define "fixture.name" }}fixture{{ end }}\n');
    await assert.rejects(f.check());
  });
  await run("format: absent Helm is rejected", async () => {
    const f = fixture();
    f.installChart();
    await assert.rejects(format(f.root, "--check", f.tracked, join(f.root, "missing-helm")));
  });
  await run("format: unassigned raw template is rejected", async () => {
    const f = fixture();
    f.put("deploy/layers/example/templates/raw.yaml", "{{ if .Values.enabled }}\napiVersion: v1\n{{ end }}\n");
    await assert.rejects(f.check());
  });
  await run("format: untracked Chart cannot authorize templates", async () => {
    const f = fixture();
    f.installChart();
    f.tracked.splice(f.tracked.indexOf(f.chart + "/Chart.yaml"), 1);
    await assert.rejects(f.check());
  });
  await run("format: untracked template under tracked Chart is validated", async () => {
    const f = fixture();
    f.installChart();
    f.put(f.chart + "/templates/new.tpl", "{{ if }}\n", false);
    await assert.rejects(f.check());
  });
  await run("format: all positive CI value profiles are rendered", async () => {
    const f = fixture();
    f.installChart();
    f.put(
      f.chart + "/templates/service.yaml",
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ required "a name is required" .Values.requiredName }}\n',
    );
    f.put(f.chart + "/ci/one-values.yaml", "requiredName: one\n");
    f.put(f.chart + "/ci/two-values.yaml", "requiredName: two\n");
    await f.check();
  });
  await run("format: any invalid CI value profile rejects", async () => {
    const f = fixture();
    f.installChart();
    f.put(
      f.chart + "/templates/service.yaml",
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ required "a name is required" .Values.requiredName }}\n',
    );
    f.put(f.chart + "/ci/one-values.yaml", "requiredName: one\n");
    f.put(f.chart + "/ci/two-values.yaml", 'requiredName: ""\n');
    await assert.rejects(f.check());
  });
  await run("format: raw Helm bytes are not rewritten", async () => {
    const f = fixture();
    f.installChart();
    const before = readFileSync(join(f.root, f.chart + "/templates/service.yaml"));
    await f.check("--write");
    assert.deepEqual(readFileSync(join(f.root, f.chart + "/templates/service.yaml")), before);
  });
  await run("format: invalid mode rejects before writes", async () => {
    const f = fixture();
    f.put("new.js", "const answer=42\n");
    const before = f.snapshot();
    await assert.rejects(f.check("--unknown"));
    assert.deepEqual(f.snapshot(), before);
  });
  await run("format: ignored working-tree content stays ignored", async () => {
    const f = fixture();
    f.put(".prettierignore", "ignored/\n");
    f.put("ignored/broken.yaml", "[unterminated\n", false);
    await f.check();
  });
}

const sandbox = mkdtempSync(join(tmpdir(), "qm-repository-format-"));
await formatCases(runRepositoryFormat, sandbox, process.env.HELM ?? "helm", async (name, fn) => {
  await test(name, fn);
});

export async function extraFormatCases(format, sandbox, helm, run) {
  const fixture = () => {
    const root = mkdtempSync(join(sandbox, "chart-links-"));
    const tracked = [];
    const chart = "deploy/layers/example/chart";
    const put = (path, text) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
      tracked.push(path);
    };
    put(chart + "/Chart.yaml", "apiVersion: v2\nname: fixture\nversion: 0.1.0\ndescription: Generic fixture\n");
    put(chart + "/values.yaml", "enabled: true\n");
    put(chart + "/templates/map.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture\n");
    const check = () => format(root, "--check", tracked, helm);
    return { root, tracked, chart, put, check };
  };
  await run("format: unreadable ignored directory matches original Prettier behavior", async () => {
    const f = fixture();
    f.tracked.length = 0;
    f.put(".prettierignore", "ignored/\ndeploy/\n");
    mkdirSync(join(f.root, "ignored"));
    chmodSync(join(f.root, "ignored"), 0o000);
    try {
      const cli = join(dirname(fileURLToPath(import.meta.resolve("prettier"))), "bin/prettier.cjs");
      const baseline = spawnSync(process.execPath, [cli, "--check", "--ignore-unknown", "."], {
        cwd: f.root,
        encoding: "utf8",
      });
      assert.ok(baseline.status === 0 || baseline.status === 2);
      if (baseline.status === 0) await f.check();
      else {
        assert.match(baseline.stderr, /EACCES: permission denied, scandir/);
        await assert.rejects(f.check());
      }
    } finally {
      chmodSync(join(f.root, "ignored"), 0o700);
    }
  });
  await run("format: chart template leaf symlink is rejected", async () => {
    const f = fixture();
    const outside = mkdtempSync(join(sandbox, "outside-"));
    const target = join(outside, "map.yaml");
    writeFileSync(target, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: other\n");
    symlinkSync(target, join(f.root, f.chart + "/templates/linked.yaml"));
    await assert.rejects(f.check());
  });
  await run("format: chart template directory symlink is rejected", async () => {
    const f = fixture();
    const outside = mkdtempSync(join(sandbox, "outside-"));
    writeFileSync(join(outside, "map.yaml"), "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: other\n");
    symlinkSync(outside, join(f.root, f.chart + "/templates/linked"));
    await assert.rejects(f.check());
  });
  await run("format: chart values symlink is rejected", async () => {
    const f = fixture();
    const outside = mkdtempSync(join(sandbox, "outside-"));
    const target = join(outside, "linked.yaml");
    writeFileSync(target, "enabled: true\n");
    symlinkSync(target, join(f.root, f.chart + "/extra-values.yaml"));
    await assert.rejects(f.check());
  });
  await run("format: nested ordinary tracked chart remains valid", async () => {
    const f = fixture();
    writeFileSync(
      join(f.root, f.chart + "/Chart.yaml"),
      "apiVersion: v2\nname: fixture\nversion: 0.1.0\ndescription: Generic fixture\ndependencies:\n  - name: child\n    version: 0.1.0\n    repository: file://charts/child\n",
    );
    f.put(
      f.chart + "/charts/child/Chart.yaml",
      "apiVersion: v2\nname: child\nversion: 0.1.0\ndescription: Generic child fixture\n",
    );
    f.put(f.chart + "/charts/child/templates/map.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: child\n");
    await f.check();
  });
}

await extraFormatCases(runRepositoryFormat, sandbox, process.env.HELM ?? "helm", async (name, fn) => {
  await test(name, fn);
});

await test("format: negated ignore rule keeps untracked included source checked", async () => {
  const root = mkdtempSync(join(sandbox, "negated-"));
  mkdirSync(join(root, "generated"));
  writeFileSync(join(root, ".prettierignore"), "generated/*\n!generated/include.js\n");
  writeFileSync(join(root, "generated/ignored.yaml"), "[unterminated\n");
  writeFileSync(join(root, "generated/include.js"), "const answer=42\n");
  await assert.rejects(runRepositoryFormat(root, "--check", [], process.env.HELM ?? "helm"));
});

for (const ignore of [".gitignore", ".prettierignore"]) {
  await test(`format: explicitly ignored ordinary tpl respects ${ignore}`, async () => {
    const root = mkdtempSync(join(sandbox, "ignored-tpl-"));
    mkdirSync(join(root, "deploy/layers/example"), { recursive: true });
    writeFileSync(join(root, ignore), "deploy/layers/example/ignored.tpl\n");
    writeFileSync(join(root, "deploy/layers/example/ignored.tpl"), "{{ deliberately invalid raw template }}\n");
    await runRepositoryFormat(
      root,
      "--check",
      [ignore, "deploy/layers/example/ignored.tpl"],
      process.env.HELM ?? "helm",
    );
  });
}

{
  const format = runRepositoryFormat;
  const node = process.execPath;
  const helm = process.env.HELM ?? "helm";
  const cli = join(dirname(fileURLToPath(import.meta.resolve("prettier"))), "bin/prettier.cjs");
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  const run = async (name, fn) => {
    await test(name, fn);
  };
  const fixture = () => {
    const root = fs.mkdtempSync(join(sandbox, "fixture-"));
    const tracked = [];
    const put = (path, text) => {
      fs.mkdirSync(join(root, path, ".."), { recursive: true });
      fs.writeFileSync(join(root, path), text);
      if (!tracked.includes(path)) tracked.push(path);
    };
    const chart = (name = "chart") => {
      const path = "deploy/layers/example/" + name;
      put(path + "/Chart.yaml", "apiVersion: v2\nname: fixture\nversion: 0.1.0\ndescription: Generic fixture\n");
      put(path + "/values.yaml", "port: 8080\n");
      put(path + "/templates/map.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture\n");
      return path;
    };
    return {
      root,
      tracked,
      put,
      chart,
      check: (mode = "--check", selected = []) => format(root, mode, tracked, helm, selected),
    };
  };
  const baseline = (root, mode, targets = ["."]) =>
    spawnSync(node, [cli, mode, "--ignore-unknown", ...targets], { cwd: root, encoding: "utf8" });
  await run("format: chart-owned tpl asset uses real Helm tpl Files.Get", async () => {
    const f = fixture();
    const chart = f.chart();
    f.put(chart + "/files/config.tpl", "port={{ .Values.port }}\n");
    f.put(
      chart + "/templates/map.yaml",
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture\ndata:\n  config: |\n{{ tpl (.Files.Get "files/config.tpl") . | indent 4 }}\n',
    );
    execFileSync(helm, ["lint", "--strict", chart], { cwd: f.root, stdio: "pipe" });
    await f.check();
  });
  await run("format: outside-chart unknown tpl keeps original ignore-unknown parity", async () => {
    const f = fixture();
    f.put("deploy/layers/example/opaque.tpl", "{{ deliberately opaque }}\n");
    assert.equal(baseline(f.root, "--check").status, 0);
    await f.check();
  });
  await run("format: actual package lint-staged command accepts selected Helm source", async () => {
    const f = fixture();
    const chart = f.chart();
    f.put(
      chart + "/templates/map.yaml",
      "{{- if .Values.port }}\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture\n{{- end }}\n",
    );
    const env = {
      ...process.env,
      HOME: "/nonexistent",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      HELM: helm,
    };
    execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "init", "--quiet", f.root], { env });
    execFileSync("/usr/bin/git", ["-C", f.root, "-c", "core.hooksPath=/dev/null", "add", "."], { env });
    const command = JSON.parse(fs.readFileSync(join(source, "package.json"), "utf8"))["lint-staged"]["*"];
    let argv;
    if (command === "prettier --write --ignore-unknown") argv = [node, cli, "--write", "--ignore-unknown"];
    else {
      assert.equal(command, "node scripts/repository-format.mjs --write");
      argv = [node, join(source, "scripts/repository-format.mjs"), "--write"];
    }
    const x = spawnSync(argv[0], [...argv.slice(1), join(f.root, chart, "templates/map.yaml")], {
      cwd: f.root,
      env,
      encoding: "utf8",
    });
    assert.equal(x.status, 0, x.stdout + x.stderr);
  });
  await run("format: selected ordinary write does not rewrite unselected files", async () => {
    const f = fixture();
    f.put("selected.js", "const selected=1\n");
    f.put("unselected.js", "const unselected=2\n");
    const before = fs.readFileSync(join(f.root, "unselected.js"), "utf8");
    await f.check("--write", [join(f.root, "selected.js")]);
    assert.equal(fs.readFileSync(join(f.root, "selected.js"), "utf8"), "const selected = 1;\n");
    assert.equal(fs.readFileSync(join(f.root, "unselected.js"), "utf8"), before);
  });
  for (const dir of [".jj", ".sl", ".hg", ".svn"]) {
    await run("format: check preserves " + dir + " metadata exclusion", async () => {
      const f = fixture();
      f.put("ordinary.yaml", "value: ok\n");
      f.put(dir + "/internal.json", '{"x":1}');
      assert.equal(baseline(f.root, "--check").status, 0);
      await f.check();
    });
    await run("format: write preserves " + dir + " metadata bytes", async () => {
      const f = fixture();
      f.put("ordinary.yaml", "value: ok\n");
      f.put(dir + "/internal.json", '{"x":1}');
      await f.check("--write");
      assert.equal(fs.readFileSync(join(f.root, dir, "internal.json"), "utf8"), '{"x":1}');
    });
  }
  await run("format: ordinary parse failure retains filename and original cause", async () => {
    const f = fixture();
    f.put("broken.yaml", "value: [unterminated\n");
    let error;
    try {
      await f.check();
    } catch (value) {
      error = value;
    }
    assert.ok(error);
    assert.match(error.message + error.stack, /broken\.yaml/);
    assert.ok(error.cause instanceof Error);
  });
  await run("format: valid full 17.6MB real Helm output remains accepted", async () => {
    const f = fixture();
    const chart = f.chart();
    f.put(
      chart + "/Chart.yaml",
      "apiVersion: v2\nname: limits-fixture\nversion: 0.1.0\ndescription: Limits review fixture\n",
    );
    f.put(
      chart + "/templates/map.yaml",
      '{{- range $i := until 32 }}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture-{{ $i }}\ndata:\n  value: {{ repeat 550000 "x" | quote }}\n{{- end }}\n',
    );
    const fd = fs.openSync(join(f.root, "baseline-rendered.private"), "wx", 0o600);
    try {
      execFileSync(helm, ["template", "format-contract", chart], { cwd: f.root, stdio: ["ignore", fd, "inherit"] });
    } finally {
      fs.closeSync(fd);
    }
    const bytes = fs.statSync(join(f.root, "baseline-rendered.private")).size;
    assert.ok(bytes > 16 * 1024 * 1024);
    const got = await f.check();
    assert.equal(got.renderedBytes, bytes);
    return { renderedBytes: bytes };
  });
  await run("format: ignores 10000 ordinary output leaves without a custom per-file pipeline", async () => {
    const f = fixture();
    f.put("ordinary.js", "const value = 1;\n");
    f.put(".prettierignore", "**/dist/\n");
    for (let i = 0; i < 10000; i++) f.put("dist/" + i + ".js", "const value=1\n");
    const original = fs.lstatSync;
    let visits = 0;
    fs.lstatSync = function (path, ...args) {
      if (String(path).includes("/dist/")) visits++;
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    try {
      await f.check();
    } finally {
      fs.lstatSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(visits, 0);
    return { wrapperIgnoredLeafVisits: visits };
  });
  for (const suffix of ["chart [a]", "chart space", "chart*literal", "chart!bang", "chart{a,b}", "chart(thing)"])
    await run("format: literal tracked chart boundary " + suffix, async () => {
      const f = fixture();
      const chart = f.chart(suffix);
      f.put(
        chart + "/templates/map.yaml",
        "{{- if .Values.port }}\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture\n{{- end }}\n",
      );
      await f.check();
    });
  await run("format: missing ordinary source still refuses", async () => {
    const f = fixture();
    f.put("ordinary.js", "const value = 1;\n");
    await assert.rejects(f.check("--check", ["missing-file.js"]));
  });
}

await test("format: full Git discovery accepts an index larger than the former buffer limit", async () => {
  const root = mkdtempSync(join(sandbox, "git-universe-"));
  const env = {
    ...process.env,
    HOME: "/nonexistent",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args, options = {}) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, env, ...options });
  git(["init", "--quiet", "--object-format=sha1"]);
  writeFileSync(join(root, "ordinary.js"), "const value = 1;\n");
  git(["add", "ordinary.js"]);
  const blob = git(["hash-object", "-w", "--stdin"], { input: Buffer.alloc(0), encoding: "utf8" }).trim();
  assert.match(blob, /^[a-f0-9]{40}$/);
  const records = Array.from(
    { length: 12000 },
    (_, index) => `100644 ${blob}\tfiles/${index}_${"x".repeat(100)}.opaque\n`,
  ).join("");
  git(["update-index", "--index-info"], { input: records });
  const output = join(root, "git-list.private");
  const fd = fs.openSync(output, "wx", 0o600);
  try {
    git(["ls-files", "-z"], { stdio: ["ignore", fd, "inherit"] });
  } finally {
    fs.closeSync(fd);
  }
  assert.ok(fs.statSync(output).size > 1024 * 1024);
  const script = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts/repository-format.mjs");
  const result = spawnSync(process.execPath, [script, "--check"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

async function actualLintStagedFixture(source, sandbox, toolCli, prettierRoot, helm) {
  const root = mkdtempSync(join(sandbox, "actual-lint-staged-"));
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), join(dirname(prettierRoot), ".bin"), process.env.PATH]
      .filter(Boolean)
      .join(delimiter),
    HOME: "/nonexistent",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HELM: helm,
  };
  const git = (args, options = {}) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, env, encoding: "utf8", ...options });
  const put = (path, text) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git(["init", "--quiet"]);
  const config = JSON.parse(readFileSync(join(source, "package.json"), "utf8"))["lint-staged"];
  put("package.json", JSON.stringify({ type: "module", "lint-staged": config }));
  put(".prettierrc.json", "{}\n");
  put("scripts/repository-format.mjs", readFileSync(join(source, "scripts/repository-format.mjs")));
  const guards = Array.from({ length: 8 }, (_, i) => `const guard${i} = ${i};\n`).join("");
  const initial = "const staged = 1;\n\n" + guards + "\nconst unstaged = 1;\n";
  put("selected.js", initial);
  put("unselected.js", "const unrelated = 1;\n");
  const chart = "deploy/layers/example/chart";
  put(
    chart + "/Chart.yaml",
    "apiVersion: v2\nname: staged-fixture\nversion: 0.1.0\ndescription: Generic staged fixture\n",
  );
  put(chart + "/values.yaml", "enabled: true\n");
  const originalTemplate =
    "{{- if .Values.enabled }}\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: initial\n{{- end }}\n";
  put(chart + "/templates/map.yaml", originalTemplate);
  git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const staged = initial.replace("const staged = 1;", "const staged=2");
  put("selected.js", staged);
  const stagedTemplate = originalTemplate.replace("name: initial", "name: staged");
  put(chart + "/templates/map.yaml", stagedTemplate);
  git(["add", "selected.js", chart + "/templates/map.yaml"]);
  put("selected.js", staged.replace("const unstaged = 1;", "const unstaged = 9;"));
  const unselected = "const unrelated=42\n";
  put("unselected.js", unselected);
  const result = spawnSync(process.execPath, [toolCli, "--concurrent", "false"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const formattedIndex = initial.replace("const staged = 1;", "const staged = 2;");
  assert.equal(git(["show", ":selected.js"]), formattedIndex);
  assert.equal(
    readFileSync(join(root, "selected.js"), "utf8"),
    formattedIndex.replace("const unstaged = 1;", "const unstaged = 9;"),
  );
  assert.equal(readFileSync(join(root, "unselected.js"), "utf8"), unselected);
  assert.equal(git(["show", ":" + chart + "/templates/map.yaml"]), stagedTemplate);
  assert.equal(readFileSync(join(root, chart, "templates/map.yaml"), "utf8"), stagedTemplate);
  assert.deepEqual(
    git(["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean).sort(),
    [chart + "/templates/map.yaml", "selected.js"].sort(),
  );
  return {
    actualLintStagedExit: result.status,
    sourceConfig: config,
    partialUnstagedPreserved: true,
    unselectedBytesPreserved: true,
    selectedHelmBytesPreserved: true,
    stagedIndexFormatted: true,
  };
}

await test("format: actual lint-staged preserves partial and unselected work while validating selected Helm", async () => {
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  const packageRoot = join(dirname(fileURLToPath(import.meta.resolve("lint-staged"))), "..");
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(metadata.name, "lint-staged");
  assert.equal(metadata.version, "17.0.1");
  const cli = join(packageRoot, metadata.bin["lint-staged"]);
  const prettierRoot = dirname(fileURLToPath(import.meta.resolve("prettier")));
  await actualLintStagedFixture(source, sandbox, cli, prettierRoot, process.env.HELM ?? "helm");
});

{
  const format = runRepositoryFormat;
  async function diagnosticCases(run) {
    const fixture = (program) => {
      const root = mkdtempSync(join(sandbox, "fixture-"));
      const chart = "deploy/layers/example/chart";
      const files = new Map([
        [chart + "/Chart.yaml", "apiVersion: v2\nname: fixture\nversion: 0.1.0\n"],
        [chart + "/templates/map.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture\n"],
        [chart + "/ci/check-values.yaml", "enabled: true\n"],
      ]);
      for (const [path, text] of files) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      const tool = join(mkdtempSync(join(sandbox, "tool-")), "helm.mjs");
      writeFileSync(tool, "#!/usr/bin/env node\n" + program, { mode: 0o700 });
      return { root, chart, tool, tracked: [...files.keys()] };
    };
    await run("rendered YAML error retains chart/profile and original parser cause", async () => {
      const f = fixture('if (process.argv[2] === "template") process.stdout.write("value: [unterminated\\n");\n');
      let error;
      try {
        await format(f.root, "--check", f.tracked, f.tool);
      } catch (value) {
        error = value;
      }
      assert.ok(error instanceof Error && error.cause instanceof Error);
      assert.ok(error.message.includes(f.chart) && error.message.includes("ci/check-values.yaml"));
    });
    await run("nonzero Helm failure keeps complete stderr and original status cause", async () => {
      const f = fixture('process.stderr.write("helm-stderr-sentinel\\n"); process.exit(17);\n');
      let error;
      try {
        await format(f.root, "--check", f.tracked, f.tool);
      } catch (value) {
        error = value;
      }
      assert.ok(error instanceof Error && error.cause instanceof Error);
      assert.equal(error.status, 17);
      assert.equal(error.cause.status, 17);
      assert.equal(error.stderr.toString("utf8"), "helm-stderr-sentinel\n");
    });
    await run("successful Helm stderr diagnostics remain observable", async () => {
      const f = fixture(
        'if (process.argv[2] === "lint") process.stderr.write("helm-success-warning\\n"); if (process.argv[2] === "template") process.stdout.write("{}\\n");\n',
      );
      const original = process.stderr.write;
      let observed = "";
      process.stderr.write = function (chunk) {
        observed += String(chunk);
        return true;
      };
      try {
        await format(f.root, "--check", f.tracked, f.tool);
      } finally {
        process.stderr.write = original;
      }
      assert.ok(observed.includes("helm-success-warning\n"));
    });
  }
  await diagnosticCases(async (name, fn) => {
    await test("format: " + name, fn);
  });
}

export async function selectionCases(format, sandbox, helm, prettierCli, run) {
  const fixture = () => {
    const root = mkdtempSync(join(sandbox, "selection-"));
    const chart = "deploy/layers/example/chart";
    const tracked = [];
    const put = (path, text, track = true) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
      if (track && !tracked.includes(path)) tracked.push(path);
    };
    put("src/value.ts", "const value = 1;\n");
    put(chart + "/Chart.yaml", "apiVersion: v2\nname: fixture\nversion: 0.1.0\ndescription: Generic fixture\n");
    put(chart + "/values.yaml", "enabled: true\n");
    put(chart + "/templates/map.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture\n");
    const baseline = (selected) =>
      spawnSync(process.execPath, [prettierCli, "--check", "--ignore-unknown", ...selected], {
        cwd: root,
        encoding: "utf8",
      });
    return {
      root,
      chart,
      tracked,
      put,
      baseline,
      check: (selected) => format(root, "--check", tracked, helm, selected),
    };
  };
  for (const selected of [
    ["src/**/*.ts"],
    ["**/*.ts"],
    ["src/value.ts"],
    ["src/**/*.ts", "!deploy/layers/example/chart/**"],
  ]) {
    await run(
      "selected ordinary path or glob leaves unrelated malformed chart inactive: " + selected.join(" "),
      async () => {
        const f = fixture();
        f.put(f.chart + "/templates/map.yaml", "not: validated \n");
        assert.equal(f.baseline(selected).status, 0);
        const result = await f.check(selected);
        assert.deepEqual(result.chartRoots, []);
        assert.equal(result.helmTemplateFiles, 0);
      },
    );
  }
  await run("selected chart glob runs real Helm validation", async () => {
    const f = fixture();
    const result = await f.check([f.chart + "/templates/*.yaml"]);
    assert.deepEqual(result.chartRoots, [f.chart]);
    assert.ok(result.renderedBytes > 0);
  });
  await run("selected chart glob rejects malformed Helm grammar", async () => {
    const f = fixture();
    f.put(f.chart + "/templates/map.yaml", "{{ if }}\n");
    await assert.rejects(f.check([f.chart + "/templates/*.yaml"]), /Helm lint failed/);
  });
  await run("selected chart directory remains active", async () => {
    const f = fixture();
    const result = await f.check([f.chart]);
    assert.deepEqual(result.chartRoots, [f.chart]);
    assert.ok(result.renderedBytes > 0);
  });
  await run("missing ordinary literal retains actual Prettier failure and filename", async () => {
    const f = fixture();
    f.put(f.chart + "/templates/map.yaml", "not: validated \n");
    const selected = ["src/missing.ts"];
    const baseline = f.baseline(selected);
    assert.notEqual(baseline.status, 0);
    await assert.rejects(
      f.check(selected),
      (error) =>
        error.message.includes("Prettier validation failed") &&
        error.message.includes("src/missing.ts") &&
        error.cause.status === baseline.status,
    );
  });
  await run("negated chart subtree is excluded from an ordinary full-directory selection", async () => {
    const f = fixture();
    f.put(f.chart + "/templates/map.yaml", "not: validated \n");
    const selected = [".", "!" + f.chart + "/**"];
    assert.equal(f.baseline(selected).status, 0);
    const result = await f.check(selected);
    assert.deepEqual(result.chartRoots, []);
  });
  await run("untracked selected template is included in chart validation", async () => {
    const f = fixture();
    f.put(f.chart + "/templates/untracked.tpl", "{{ if }}\n", false);
    await assert.rejects(f.check([f.chart + "/templates/*.tpl"]), /Helm lint failed/);
  });
  await run("negative-only pattern retains actual Prettier selection result", async () => {
    const f = fixture();
    f.put(f.chart + "/templates/map.yaml", "not: validated \n");
    const selected = ["!" + f.chart + "/**"];
    const baseline = f.baseline(selected);
    if (baseline.status === 0) {
      const result = await f.check(selected);
      assert.deepEqual(result.chartRoots, []);
    } else {
      await assert.rejects(
        f.check(selected),
        (error) => error.message.includes("Prettier validation failed") && error.cause.status === baseline.status,
      );
    }
  });
  await run("full run still validates malformed tracked charts", async () => {
    const f = fixture();
    f.put(f.chart + "/templates/map.yaml", "{{ if }}\n");
    await assert.rejects(f.check([]), /Helm lint failed/);
  });
}

await selectionCases(
  runRepositoryFormat,
  mkdtempSync(join(tmpdir(), "qm-format-selection-")),
  process.env.HELM ?? "helm",
  join(dirname(fileURLToPath(import.meta.resolve("prettier"))), "bin/prettier.cjs"),
  (name, fn) => test(name, fn),
);

export async function linkSelectionCases(format, sandbox, helm, prettierCli, run) {
  const fixture = (extension = "yaml") => {
    const root = mkdtempSync(join(sandbox, "selection-link-"));
    const chart = "deploy/layers/example/chart";
    const tracked = [];
    const put = (path, text) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
      tracked.push(path);
    };
    put("src/value.ts", "const value = 1;\n");
    put(chart + "/Chart.yaml", "apiVersion: v2\nname: fixture\nversion: 0.1.0\ndescription: Generic fixture\n");
    put(chart + "/values.yaml", "enabled: true\n");
    put(chart + "/templates/map.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture\n");
    put(chart + "/asset." + extension, "value: fixture\n");
    symlinkSync("../asset." + extension, join(root, chart, "templates/link." + extension));
    tracked.push(chart + "/templates/link." + extension);
    return {
      root,
      chart,
      tracked,
      baseline: (selected) =>
        spawnSync(process.execPath, [prettierCli, "--check", "--ignore-unknown", ...selected], {
          cwd: root,
          encoding: "utf8",
        }),
      check: (selected) => format(root, "--check", tracked, helm, selected),
    };
  };
  for (const extension of ["yaml", "txt"]) {
    await run("unrelated chart " + extension + " symlink remains inactive for ordinary glob", async () => {
      const f = fixture(extension);
      const selected = ["**/*.ts"];
      assert.equal(f.baseline(selected).status, 0);
      const result = await f.check(selected);
      assert.deepEqual(result.chartRoots, []);
    });
  }
  await run("explicitly negated chart with symlink remains inactive", async () => {
    const f = fixture();
    const selected = [".", "!" + f.chart + "/**"];
    assert.equal(f.baseline(selected).status, 0);
    const result = await f.check(selected);
    assert.deepEqual(result.chartRoots, []);
  });
  await run("selected chart glob still rejects symlink source", async () => {
    const f = fixture();
    await assert.rejects(f.check([f.chart + "/templates/*.yaml"]), /chart paths must be ordinary/);
  });
  await run("full run still rejects chart symlink source", async () => {
    const f = fixture();
    await assert.rejects(f.check([]), /chart paths must be ordinary/);
  });
  await run("active chart rejects unrelated txt symlink within its boundary", async () => {
    const f = fixture("txt");
    await assert.rejects(f.check([f.chart + "/Chart.yaml"]), /chart paths must be ordinary/);
  });
}

await linkSelectionCases(
  runRepositoryFormat,
  mkdtempSync(join(tmpdir(), "qm-format-selection-links-")),
  process.env.HELM ?? "helm",
  join(dirname(fileURLToPath(import.meta.resolve("prettier"))), "bin/prettier.cjs"),
  (name, fn) => test(name, fn),
);
