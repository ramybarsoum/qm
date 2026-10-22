import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { createMockHarness } from "./support/mock-harness.ts";
import { testConfig } from "./support/test-config.ts";
import { runNowSettled } from "./support/settle.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { agentSkillDigest, type AgentPolicy, type AgentPolicyOperation } from "../src/auth/agent-policy.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";

interface Switchable {
  bound: boolean;
  grants: { id: string; digest: string }[];
  admit: (operation: AgentPolicyOperation) => boolean;
  operations: AgentPolicyOperation[];
}

async function fixture(t: TestContext) {
  const state: Switchable = { bound: false, grants: [], admit: () => true, operations: [] };
  const agentPolicy: AgentPolicy = {
    resolve: async () => (state.bound ? { subjectId: "agent", revision: 1, grants: state.grants } : null),
    admit: async (_context, _binding, operation) => {
      state.operations.push(operation);
      return state.admit(operation);
    },
  };
  const captures: HarnessTurnInput[] = [];
  const pi = createMockHarness();
  const runTurn = pi.turns.runTurn.bind(pi.turns);
  pi.turns.runTurn = async (input) => {
    captures.push(input);
    return runTurn(input);
  };
  const built = buildApp(testConfig(), { agentPolicy, harnesses: { pi } });
  await built.deploymentLayerReady;
  const computer = await built.sandboxResources.create("U1", "personal:U1", "sprites", "default");
  await built.sandboxResources.setDefault("U1", "personal:U1", computer.id);
  t.after(async () => {
    built.scheduler.stop();
    built.deploymentLayerRefresh.stop();
    await built.runtime.stop();
  });
  const turn = (text: string, extra: Partial<TurnRequest> = {}) =>
    built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:agent-policy" },
      text,
      ...extra,
    } as TurnRequest);
  const reply = async (text: string) => {
    const result = await turn(text);
    assert.equal(result.status, "ok", JSON.stringify(result));
    return result.reply ?? "";
  };
  const skill = await built.skills.create({
    scopeId: "personal:U1",
    createdBy: "U1",
    manifest: {
      name: "policy-helper",
      description: "policy test",
      body: "POLICY_BODY",
      requiredCapabilities: [],
      files: [{ path: "references/example.txt", content: "POLICY_ASSET" }],
    },
  });
  await built.skills.review(skill.id, "reviewer", []);
  await built.skills.publish(skill.id);
  const grant = async () => {
    const current = (await built.skills.get(skill.id))!;
    state.grants = [{ id: current.id, digest: agentSkillDigest(current) }];
  };
  return { ...built, state, captures, turn, reply, skill, grant };
}

test("a configured policy that binds no subject leaves turns and skills unchanged", async (t) => {
  const b = await fixture(t);
  assert.match(await b.reply("!skill policy-helper"), /POLICY_BODY$/);
  assert.equal(await b.reply("!skill-run policy-helper cat {dir}/references/example.txt"), "POLICY_ASSET");
  assert.deepEqual(b.state.operations, []);
});

test("bound subjects are refused when the policy denies the turn", async (t) => {
  const b = await fixture(t);
  b.state.bound = true;
  b.state.admit = (operation) => operation.kind !== "turn";
  const result = await b.turn("hello");
  assert.equal(result.status, "refused");
  assert.equal(b.captures.length, 0);
});

test("bound subjects see only skills granted at their exact digest", async (t) => {
  const b = await fixture(t);
  b.state.bound = true;
  assert.match(await b.reply("!skill policy-helper"), /no skill file/);
  await b.grant();
  assert.match(await b.reply("!skill policy-helper"), /POLICY_BODY$/);
  await b.skills.update(b.skill.id, { ...b.skill.manifest, body: "CHANGED_BODY" });
  assert.match(await b.reply("!skill policy-helper"), /no skill file/);
});

test("a laid skill tree is removed before the next tool call once its grant is revoked", async (t) => {
  const b = await fixture(t);
  b.state.bound = true;
  await b.grant();
  assert.equal(await b.reply("!skill-run policy-helper cat {dir}/references/example.txt"), "POLICY_ASSET");
  b.state.admit = (operation) => {
    if (operation.kind === "tool" && operation.name === "execute") b.state.grants = [];
    return true;
  };
  assert.notEqual(await b.reply("!skill-run policy-helper cat {dir}/references/example.txt"), "POLICY_ASSET");
});

test("denied tool calls do not run", async (t) => {
  const b = await fixture(t);
  b.state.bound = true;
  b.state.admit = (operation) => !(operation.kind === "tool" && operation.name === "read");
  await assert.rejects(b.turn("!read notes.txt"), /agent policy denied tool admission/);
  assert.ok(b.state.operations.some((operation) => operation.kind === "tool" && operation.name === "read"));
});

test("bound turns start without inherited history, prior turns or overheard context", async (t) => {
  const b = await fixture(t);
  assert.equal((await b.turn("OLD_HISTORY_MARKER")).status, "ok");
  b.state.bound = true;
  const result = await b.turn("current task", {
    priorTurns: [{ role: "user", text: "OLD_PRIOR_MARKER" }],
    overheard: [{ role: "user", ts: "100.1", text: "OLD_OVERHEARD_MARKER" }],
  } as Partial<TurnRequest>);
  assert.equal(result.status, "ok", JSON.stringify(result));
  const input = b.captures.at(-1)!;
  assert.deepEqual(input.history, []);
  assert.equal(input.priorTurns, undefined);
  assert.equal(input.overheard, undefined);
  assert.doesNotMatch(input.environment ?? "", /OLD_/);
});

test("cron fires are admitted against the stored payload and a denial disables the cron", async () => {
  const crons = createCronStore();
  const calls: TurnRequest[] = [];
  const operations: AgentPolicyOperation[] = [];
  let admitted = false;
  const scheduler = createScheduler({
    ...singleProcessDeps(),
    agentPolicy: {
      resolve: async () => ({ subjectId: "agent", revision: 1 }),
      admit: async (_context, _binding, operation) => {
        operations.push(operation);
        return admitted;
      },
    },
    crons,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(),
    identity: createIdentityService(),
    run: async (req: TurnRequest): Promise<TurnResult> => {
      calls.push(req);
      return { status: "ok", reply: "done" };
    },
  });
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "summarize",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls.length, 0);
  assert.equal(operations[0]?.kind, "cron");
  assert.equal(typeof (operations[0] as { payloadDigest?: string }).payloadDigest, "string");
  const stored = await crons.get(cron.id);
  assert.equal(stored?.enabled, false);
  assert.equal((await crons.listFires(cron.id)).runs[0]?.status, "refused");
  admitted = true;
  await crons.setEnabled(cron.id, true);
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls.length, 1);
});
