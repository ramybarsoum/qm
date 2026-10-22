import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Cron } from "../types.ts";
import type { Skill, SkillResolution } from "../skills/skill-store.ts";
import type { SkillBundle, SkillBundleStore } from "../skills/skill-bundle-store.ts";

export interface AgentPolicyContext {
  principalId: string;
  threadRef?: string;
  runId?: string;
  scopeId?: string;
  trigger?: { id: string; fireKey: string };
  runtime?: boolean;
}

interface AgentSkillGrant {
  id: string;
  digest: string;
}

interface AgentPolicyBinding {
  subjectId: string;
  revision: number;
  grants?: readonly AgentSkillGrant[];
}

export type AgentPolicyOperation =
  | { kind: "turn" | "cron"; payloadDigest?: string }
  | { kind: "skill"; resource: AgentSkillGrant }
  | { kind: "tool"; name: string; input: readonly unknown[] };

export interface AgentPolicy {
  resolve(context: AgentPolicyContext): Promise<AgentPolicyBinding | null>;
  admit(context: AgentPolicyContext, binding: AgentPolicyBinding, operation: AgentPolicyOperation): Promise<boolean>;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalFiles(files: Skill["manifest"]["files"]): unknown[] {
  return [...(files ?? [])]
    .map((file) => [file.path, file.content, file.executable === true] as const)
    .sort((a, b) => compareCodeUnits(a[0], b[0]));
}

export function agentSkillDigest(skill: Skill, bundle?: SkillBundle | null): string {
  if (skill.pack && (!bundle || bundle.commit !== skill.pack.commit)) throw new Error("skill bundle revision mismatch");
  return createHash("sha256")
    .update(
      JSON.stringify([
        "agent-skill-v1",
        skill.id,
        skill.version,
        skill.scopeId,
        skill.manifest.name,
        skill.manifest.description,
        skill.manifest.body,
        [...skill.manifest.requiredCapabilities].sort(),
        [...skill.grantedCapabilities].sort(),
        canonicalFiles(skill.manifest.files),
        skill.pack ?? null,
        bundle ? [bundle.packId, bundle.commit, canonicalFiles(bundle.files)] : null,
      ]),
    )
    .digest("hex");
}

async function skillBundleFor(
  row: SkillResolution & { skill: Skill },
  bundles?: Pick<SkillBundleStore, "get">,
): Promise<SkillBundle | null> {
  const pack = row.skill.pack;
  if (!pack) return null;
  const screened = row.screenedBundles?.find((bundle) => bundle.packId === pack.packId);
  return screened ?? (await bundles?.get(pack.packId)) ?? null;
}

export async function admitAgentOperation(
  policy: AgentPolicy | undefined,
  context: AgentPolicyContext,
  operation: AgentPolicyOperation,
): Promise<boolean> {
  if (!policy) return true;
  const binding = await policy.resolve(context);
  if (!binding) return true;
  return (await policy.admit(context, binding, operation)) === true;
}

export async function filterAgentSkills(
  policy: AgentPolicy | undefined,
  context: AgentPolicyContext,
  resolved: SkillResolution[],
  bundles?: Pick<SkillBundleStore, "get">,
): Promise<SkillResolution[]> {
  if (!policy) return resolved;
  const binding = await policy.resolve(context);
  if (!binding) return resolved;
  const permitted: SkillResolution[] = [];
  for (const row of resolved) {
    if (!row.skill || row.skill.status !== "published") continue;
    const skill = row.skill;
    let digest: string;
    try {
      digest = agentSkillDigest(skill, await skillBundleFor({ ...row, skill }, bundles));
    } catch {
      continue;
    }
    const resource = { id: skill.id, digest };
    const granted = binding.grants?.some((grant) => grant.id === resource.id && grant.digest === resource.digest);
    if (!granted) continue;
    if ((await policy.admit(context, binding, { kind: "skill", resource })) === true)
      permitted.push({ ...row, skill, shadowed: [] });
  }
  return permitted;
}

export function loadAgentPolicyModule(path: string): AgentPolicy {
  let pending: Promise<AgentPolicy> | undefined;
  const load = () =>
    (pending ??= import(pathToFileURL(path).href).then(async (module) => {
      const policy = await module.createAgentPolicy();
      if (!policy || typeof policy.resolve !== "function" || typeof policy.admit !== "function") {
        throw new Error("invalid agent policy module");
      }
      return policy as AgentPolicy;
    }));
  return {
    resolve: async (context) => (await load()).resolve(context),
    admit: async (context, binding, operation) => (await load()).admit(context, binding, operation),
  };
}

export type AgentGuardedTools<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? K extends "mcpToolDefs"
      ? T[K]
      : (...args: A) => R | Promise<Awaited<R>>
    : T[K];
};

export function guardAgentTools<T extends object>(
  policy: AgentPolicy | undefined,
  context: AgentPolicyContext,
  tools: T,
  prepare?: (name: string, input: readonly unknown[]) => Promise<void>,
  invalidate?: () => Promise<void>,
): AgentGuardedTools<T> {
  if (!policy) return tools as AgentGuardedTools<T>;
  return new Proxy(tools, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string" || property === "mcpToolDefs") return value;
      return async (...input: unknown[]) => {
        try {
          const binding = await policy.resolve(context);
          if (binding) {
            if (!(await policy.admit(context, binding, { kind: "tool", name: property, input })))
              throw new Error("agent policy denied tool admission");
            await prepare?.(property, input);
          }
        } catch (error) {
          await invalidate?.();
          throw error;
        }
        return Reflect.apply(value, target, input);
      };
    },
  }) as AgentGuardedTools<T>;
}

export function agentCronDigest(cron: Cron): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => compareCodeUnits(a, b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical([
          "agent-cron-v1",
          cron.id,
          cron.title ?? null,
          cron.owner,
          cron.ownerScopeId,
          cron.action ?? null,
          cron.message ?? null,
          cron.loopId ?? null,
          cron.destination ?? null,
          cron.schedule,
          cron.runtime ?? null,
          cron.unattendedGrants ?? [],
        ]),
      ),
    )
    .digest("hex");
}
