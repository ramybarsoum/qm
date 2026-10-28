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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
