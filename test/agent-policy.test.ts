import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentCronDigest,
  agentSkillDigest,
  admitAgentOperation,
  filterAgentSkills,
  guardAgentTools,
  type AgentPolicy,
} from "../src/auth/agent-policy.ts";
import { createSkillMethods } from "../src/api/app-skills.ts";
import { surfaceRoutes } from "../src/api/routes/surface.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { createSkillBundleStore } from "../src/skills/skill-bundle-store.ts";
import { scopeId } from "../src/types.ts";

const context = { principalId: "owner", threadRef: "dm:owner:policy" };
async function fixture() {
  const store = createSkillStore();
  const skill = await store.create({
    scopeId: scopeId("org", "test"),
    createdBy: "owner",
    manifest: { name: "allowed", description: "task", body: "instructions", requiredCapabilities: [] },
  });
  await store.review(skill.id, "owner", []);
  await store.publish(skill.id);
  return { store, skill: (await store.get(skill.id))!, rows: await store.visibleFor([skill.scopeId], []) };
}
function policy(grants?: { id: string; digest: string }[], admitted = true): AgentPolicy {
  return {
    resolve: async () => ({ subjectId: "one", revision: 1, ...(grants ? { grants } : {}) }),
    admit: async () => admitted,
  };
}

test("unconfigured and unbound policies retain ordinary visibility", async () => {
  const { rows } = await fixture();
  assert.equal(await filterAgentSkills(undefined, context, rows), rows);
  assert.equal(await filterAgentSkills({ resolve: async () => null, admit: async () => false }, context, rows), rows);
  assert.equal(await admitAgentOperation(undefined, context, { kind: "cron" }), true);
  assert.equal(
    await admitAgentOperation({ resolve: async () => null, admit: async () => false }, context, { kind: "turn" }),
    true,
  );
});

test("bound subjects with missing or empty grants see no skills", async () => {
  const { rows } = await fixture();
  assert.deepEqual(await filterAgentSkills(policy(), context, rows), []);
  assert.deepEqual(await filterAgentSkills(policy([]), context, rows), []);
});

test("exact grants subtract and drop shadowed candidates without elevating visibility", async () => {
  const { rows, skill } = await fixture();
  const grants = [{ id: skill.id, digest: agentSkillDigest(skill) }];
  assert.equal(
    (await filterAgentSkills(policy(grants), context, [{ ...rows[0]!, shadowed: [skill] }]))[0]?.shadowed.length,
    0,
  );
  assert.deepEqual(await filterAgentSkills(policy(grants), context, []), []);
  assert.deepEqual(await filterAgentSkills(policy(grants, false), context, rows), []);
  assert.deepEqual(
    await filterAgentSkills(policy(grants), context, [{ skill: { ...skill, status: "archived" }, shadowed: [] }]),
    [],
  );
});

test("changed content, supporting files, executable bit and revision invalidate a grant", async () => {
  const { rows, skill } = await fixture();
  const grants = [{ id: skill.id, digest: agentSkillDigest(skill) }];
  for (const changed of [
    { ...skill, version: skill.version + 1 },
    { ...skill, manifest: { ...skill.manifest, body: "changed" } },
    { ...skill, manifest: { ...skill.manifest, files: [{ path: "run.sh", content: "run", executable: true }] } },
  ])
    assert.deepEqual(await filterAgentSkills(policy(grants), context, [{ ...rows[0]!, skill: changed }]), []);
});

test("pack bundles are bound into the digest and missing or changed bundles deny", async () => {
  const { skill } = await fixture();
  skill.pack = { packId: "pack", commit: "abc", upstreamName: "allowed" };
  const bundles = createSkillBundleStore();
  const bundle = { packId: "pack", commit: "abc", hash: "untrusted", files: [{ path: "shared/run", content: "safe" }] };
  await bundles.put(bundle);
  const grants = [{ id: skill.id, digest: agentSkillDigest(skill, bundle) }];
  const rows = [{ skill, shadowed: [] }];
  assert.equal((await filterAgentSkills(policy(grants), context, rows, bundles)).length, 1);
  assert.equal(
    (await filterAgentSkills(policy(grants), context, [{ ...rows[0]!, screenedBundles: [bundle] }])).length,
    1,
  );
  await bundles.put({ ...bundle, files: [{ path: "shared/run", content: "changed" }] });
  assert.deepEqual(await filterAgentSkills(policy(grants), context, rows, bundles), []);
  assert.deepEqual(await filterAgentSkills(policy(grants), context, rows), []);
});

test("revocation is rechecked and policy failures propagate", async () => {
  const { rows, skill } = await fixture();
  const grants = [{ id: skill.id, digest: agentSkillDigest(skill) }];
  const provider = policy(grants);
  assert.equal((await filterAgentSkills(provider, context, rows)).length, 1);
  grants.length = 0;
  assert.deepEqual(await filterAgentSkills(provider, context, rows), []);
  provider.resolve = async () => {
    throw new Error("offline");
  };
  await assert.rejects(filterAgentSkills(provider, context, rows), /offline/);
  await assert.rejects(admitAgentOperation(provider, context, { kind: "turn" }), /offline/);
});

test("turn and cron admission require explicit policy admission", async () => {
  for (const kind of ["turn", "cron"] as const) {
    assert.equal(await admitAgentOperation(policy([], false), context, { kind }), false);
    assert.equal(await admitAgentOperation(policy([], true), context, { kind }), true);
  }
});

test("guarded tools reauthorize every call and never run a denied operation", async () => {
  let allowed = true;
  let calls = 0;
  let invalidated = 0;
  const provider = policy([]);
  provider.admit = async (_context, _binding, operation) => operation.kind === "tool" && allowed;
  const raw = {
    read: async () => {
      calls++;
      return "data";
    },
    mcpToolDefs: () => [],
  };
  const guarded = guardAgentTools(provider, context, raw, undefined, async () => {
    invalidated++;
  });
  assert.equal(await guarded.read(), "data");
  allowed = false;
  await assert.rejects(guarded.read(), /denied tool/);
  assert.equal(calls, 1);
  assert.equal(invalidated, 1);
  assert.deepEqual(guarded.mcpToolDefs(), []);
  assert.equal(guardAgentTools(undefined, context, raw), raw);
});

test("unbound guarded tools pass through results unchanged", async () => {
  const raw = { soulRead: () => ({ effectiveSoul: "standing", soul: "standing", soulVersion: 2 }) };
  const unbound = guardAgentTools({ resolve: async () => null, admit: async () => false }, context, raw);
  assert.deepEqual(await unbound.soulRead(), raw.soulRead());
  await assert.rejects(Promise.resolve(guardAgentTools(policy([], false), context, raw).soulRead()), /denied/);
});

test("cron admission binds the stored task, destination, schedule and authority", () => {
  const cron = {
    id: "cron",
    owner: "owner",
    ownerScopeId: "personal:owner",
    action: "proposal",
    schedule: { everyMs: 60000 },
    destination: { type: "web", target: "owner" },
  };
  const digest = agentCronDigest(cron as never);
  for (const changed of [
    { ...cron, title: "different instructions" },
    { ...cron, action: "different" },
    { ...cron, owner: "other" },
    { ...cron, schedule: { everyMs: 1000 } },
    { ...cron, destination: { type: "web", target: "other" } },
    { ...cron, loopId: "loop" },
    { ...cron, unattendedGrants: ["send"] },
  ])
    assert.notEqual(agentCronDigest(changed as never), digest);
  assert.equal(agentCronDigest({ ...cron, lastAttemptAt: 999 } as never), digest);
});

test("catalog detail pairs its returned snapshot with the same content digest", async () => {
  const { skill } = await fixture();
  const changed = { ...skill, version: skill.version + 1, manifest: { ...skill.manifest, body: "changed content" } };
  let reads = 0;
  const app = createSkillMethods(
    {
      agentPolicy: { resolve: async () => null, admit: async () => true },
      skills: { get: async () => (++reads === 1 ? skill : changed) },
    } as never,
    { canManageSkill: async () => true } as never,
  );
  let response: { skill: { body: string; version: number; digest: string } } | undefined;
  await surfaceRoutes
    .find((route) => "method" in route && route.method === "GET" && route.path === "/v1/skills/:id")!
    .handle({
      app,
      params: { id: skill.id },
      url: new URL(`http://offline/v1/skills/${skill.id}?principalId=owner`),
      capability: null,
      res: {
        writeHead() {},
        setHeader() {},
        getHeader() {
          return undefined;
        },
        end(body: string) {
          response = JSON.parse(body);
        },
      },
    } as never);
  assert.ok(response);
  assert.equal(response.skill.body, skill.manifest.body);
  assert.equal(response.skill.version, skill.version);
  assert.equal(response.skill.digest, agentSkillDigest(skill));
  assert.equal(reads, 1);
});
