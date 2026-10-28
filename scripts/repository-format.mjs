import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { escape, Minimatch } from "minimatch";
import * as prettier from "prettier";

export async function runRepositoryFormat(root, mode, tracked, helmPath = "helm", selected = []) {
  assert.ok(mode === "--check" || mode === "--write", "expected --check or --write");
  assert.ok(Array.isArray(selected) && selected.every((path) => typeof path === "string" && path.length > 0));
  root = resolve(root);
  const home = mkdtempSync(join(tmpdir(), "qm-repository-format-"));
  let command = 0;
  let completed = false;
  const execute = (binary, args, context, env = process.env) => {
    const prefix = join(home, String(command++));
    const stdoutFile = prefix + ".stdout";
    const stderrFile = prefix + ".stderr";
    let stdoutFd;
    let stderrFd;
    let cause;
    try {
      stdoutFd = openSync(stdoutFile, "wx", 0o600);
      stderrFd = openSync(stderrFile, "wx", 0o600);
      execFileSync(binary, args, { cwd: root, env, stdio: ["ignore", stdoutFd, stderrFd] });
    } catch (error) {
      cause = error;
    } finally {
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
    }
    const stdout = stdoutFd === undefined ? Buffer.alloc(0) : readFileSync(stdoutFile);
    const stderr = stderrFd === undefined ? Buffer.alloc(0) : readFileSync(stderrFile);
    if (cause) {
      throw Object.assign(new Error(`${context}\n${stdout.toString("utf8")}${stderr.toString("utf8")}`, { cause }), {
        stdout,
        stderr,
        status: cause.status,
        signal: cause.signal,
        code: cause.code,
      });
    }
    if (stderr.length) process.stderr.write(stderr);
    return { stdout, stderr };
  };
  try {
    tracked ??= execute("git", ["ls-files", "-z"], "Git file discovery failed")
      .stdout.toString("utf8")
      .split("\0")
      .filter(Boolean);
    const charts = tracked.filter((path) => /^deploy\/layers\/[^/]+\/.+\/Chart\.yaml$/.test(path)).map(dirname);
    const selectors = selected.map((path) => {
      const literal = existsSync(resolve(root, path));
      const negative = !literal && path.startsWith("!");
      const input = resolve(root, negative ? path.slice(1) : path);
      const pattern = literal
        ? escape(input, { windowsPathsNoEscape: process.platform === "win32", magicalBraces: true }) +
          (lstatSync(input).isDirectory() ? "/**" : "")
        : input;
      return { negative, matcher: new Minimatch(pattern, { dot: true, nonegate: true }) };
    });
    const positives = selectors.filter((selector) => !selector.negative);
    const negatives = selectors.filter((selector) => selector.negative);
    const candidates = charts.filter(
      (chart) => selected.length === 0 || positives.some(({ matcher }) => matcher.match(resolve(root, chart), true)),
    );
    const paths = new Set();
    const visited = new Set();
    const walkChart = (directory) => {
      if (visited.has(directory)) return;
      visited.add(directory);
      for (const name of readdirSync(join(root, directory))) {
        const path = `${directory}/${name}`;
        const value = lstatSync(join(root, path));
        if (value.isDirectory() && !value.isSymbolicLink()) walkChart(path);
        else paths.add(path);
      }
    };
    const ordinaryAncestors = (chart) => {
      let current = root;
      for (const part of chart.split("/")) {
        if (!part || part === "." || part === "..") return false;
        current = join(current, part);
        const value = lstatSync(current);
        if (!value.isDirectory() || value.isSymbolicLink()) return false;
      }
      return true;
    };
    for (const chart of candidates) {
      if (ordinaryAncestors(chart)) walkChart(chart);
      else for (const path of tracked.filter((path) => path.startsWith(`${chart}/`))) paths.add(path);
    }
    const active = candidates.filter(
      (chart) =>
        selected.length === 0 ||
        [...paths].some((path) => {
          if (!path.startsWith(`${chart}/`)) return false;
          const input = resolve(root, path);
          return (
            positives.some(({ matcher }) => matcher.match(input)) &&
            !negatives.some(({ matcher }) => matcher.match(input))
          );
        }),
    );
    for (const chart of active) {
      assert.ok(ordinaryAncestors(chart), `chart ancestors must be ordinary: ${chart}`);
      assert.ok(realpathSync(join(root, chart)).startsWith(realpathSync(root) + sep));
      const descriptor = lstatSync(join(root, chart, "Chart.yaml"));
      assert.ok(descriptor.isFile() && !descriptor.isSymbolicLink(), `tracked Chart.yaml must be ordinary: ${chart}`);
      for (const path of paths) {
        if (!path.startsWith(`${chart}/`)) continue;
        const value = lstatSync(join(root, path));
        assert.ok(value.isFile() && !value.isSymbolicLink(), `chart paths must be ordinary: ${path}`);
      }
    }
    const templates = [...paths].filter((path) => active.some((chart) => path.startsWith(`${chart}/templates/`)));
    for (const path of templates) {
      const text = readFileSync(join(root, path), "utf8");
      assert.ok(
        !/\t|[ \t]+$/m.test(text) && (text.length === 0 || text.endsWith("\n")),
        `template source whitespace: ${path}`,
      );
    }
    const targets = (selected.length ? selected : ["."]).filter((path) => {
      const input = resolve(root, path);
      return (
        (!existsSync(input) && !new Minimatch(input, { nonegate: true }).hasMagic()) ||
        !active.some((chart) => {
          const directory = resolve(root, chart, "templates");
          return input === directory || input.startsWith(directory + sep);
        })
      );
    });
    let prettierOutput = "";
    if (targets.length) {
      const exclusions = charts.map(
        (chart) =>
          "!" +
          escape(join(root, chart, "templates"), {
            windowsPathsNoEscape: process.platform === "win32",
            magicalBraces: true,
          }) +
          "/**",
      );
      const prettierCli = join(dirname(fileURLToPath(import.meta.resolve("prettier"))), "bin/prettier.cjs");
      prettierOutput = execute(
        process.execPath,
        [prettierCli, mode, "--ignore-unknown", ...targets, ...exclusions],
        "Prettier validation failed",
      ).stdout.toString("utf8");
    }
    const env = {
      ...process.env,
      KUBECONFIG: "/dev/null",
      HELM_PLUGINS: join(home, "plugins"),
      HELM_CONFIG_HOME: join(home, "config"),
      HELM_CACHE_HOME: join(home, "cache"),
      HELM_DATA_HOME: join(home, "data"),
    };
    let renderedBytes = 0;
    for (const chart of active.filter((chart) => templates.some((path) => path.startsWith(`${chart}/templates/`)))) {
      const values = [...paths].filter((path) => path.startsWith(`${chart}/ci/`) && /-values\.ya?ml$/.test(path));
      for (const value of values.length ? values : [null]) {
        const profile = value ?? "default values";
        const flags = value ? ["--values", join(root, value)] : [];
        execute(helmPath, ["lint", "--strict", chart, ...flags], `Helm lint failed: ${chart} (${profile})`, env);
        const rendered = execute(
          helmPath,
          ["template", "format-contract", chart, ...flags],
          `Helm render failed: ${chart} (${profile})`,
          env,
        );
        renderedBytes += rendered.stdout.length;
        try {
          await prettier.format(rendered.stdout.toString("utf8"), { parser: "yaml" });
        } catch (cause) {
          throw Object.assign(new Error(`Rendered YAML validation failed: ${chart} (${profile})`, { cause }), rendered);
        }
      }
    }
    completed = true;
    return { helmTemplateFiles: templates.length, chartRoots: active, renderedBytes, prettierOutput };
  } catch (error) {
    error.diagnosticDirectory = home;
    throw error;
  } finally {
    if (completed) rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runRepositoryFormat(
    process.cwd(),
    process.argv[2],
    undefined,
    process.env.HELM ?? "helm",
    process.argv.slice(3),
  );
  process.stdout.write(result.prettierOutput);
}
