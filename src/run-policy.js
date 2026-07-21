import path from "node:path";
import { verifyCasePolicyWorkspace } from "./case-policy-bundle.js";
import { resolvePolicyContext } from "./policy-registry.js";
import { resolveWorkspacePath } from "./workspace-path.js";

const SHELL_OPERATOR_PATTERN = /[;&|><`$()\r\n]/;

function isSafeArgument(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 240
    && !SHELL_OPERATOR_PATTERN.test(value);
}

function plansEqual(left, right) {
  return left?.executable === right?.executable
    && left?.cwd === right?.cwd
    && left?.expectedArtifact === right?.expectedArtifact
    && left?.timeoutMs === right?.timeoutMs
    && Array.isArray(left?.args)
    && Array.isArray(right?.args)
    && left.args.length === right.args.length
    && left.args.every((argument, index) => argument === right.args[index]);
}

export function classifyRunPlan(plan, policyContext) {
  const resolved = resolvePolicyContext(policyContext);
  const { profile, trustedCase } = resolved;
  const normalizedCwd = typeof plan?.cwd === "string" ? plan.cwd.replaceAll("\\", "/") : null;
  const entryArgument = Array.isArray(plan?.args) ? plan.args[0] : null;
  const normalizedEntry = typeof entryArgument === "string" ? entryArgument.replaceAll("\\", "/") : null;
  const checks = {
    policyContextRegistered: resolved.valid,
    executableAllowListed: Boolean(profile && plan?.executable === profile.executable),
    argsAreLiteral: Boolean(
      profile
      && Array.isArray(plan?.args)
      && plan.args.length >= profile.argumentCount.minimum
      && plan.args.length <= profile.argumentCount.maximum
      && plan.args.every(isSafeArgument),
    ),
    entryRepositoryRelative: Boolean(
      profile
      && normalizedEntry
      && normalizedEntry === path.posix.normalize(normalizedEntry)
      && !path.posix.isAbsolute(normalizedEntry)
      && !normalizedEntry.startsWith("..")
      && profile.entryExtensions.includes(path.posix.extname(normalizedEntry)),
    ),
    cwdRepositoryRelative: Boolean(
      normalizedCwd
      && normalizedCwd === path.posix.normalize(normalizedCwd)
      && !path.posix.isAbsolute(normalizedCwd)
      && !normalizedCwd.startsWith(".."),
    ),
    expectedArtifactAllowListed: Boolean(profile?.expectedArtifacts.includes(plan?.expectedArtifact)),
    timeoutWithinPolicy: Boolean(
      profile
      && Number.isInteger(plan?.timeoutMs)
      && plan.timeoutMs >= profile.timeoutMs.minimum
      && plan.timeoutMs <= profile.timeoutMs.maximum,
    ),
    trustedCasePlanMatch: Boolean(trustedCase?.allowedPlans.some((allowedPlan) => plansEqual(plan, allowedPlan))),
  };
  const approved = Object.values(checks).every(Boolean);
  return {
    actor: "Run policy engine",
    status: approved ? "eligible-for-approval" : "rejected",
    classification: approved ? "trusted-fixture-run-plan" : "unsafe-or-unapproved-run-plan",
    profileId: profile?.id || policyContext?.profileId || null,
    trustedCaseId: trustedCase?.id || policyContext?.trustedCaseId || null,
    resourceLimits: profile ? structuredClone(profile.resourceLimits) : null,
    checks,
    rationale: approved
      ? `The RunPlan satisfied ${profile.label} and exactly matched the registered ${trustedCase.label} case binding.`
      : "The proposed RunPlan failed the registered profile, trusted-case binding, or an independent structural execution-policy check.",
  };
}

export async function classifyRunPlanWorkspace(repoDirectory, plan, policyContext) {
  const classification = classifyRunPlan(plan, policyContext);
  if (classification.status === "rejected") return classification;
  let cwdRealpathSafe = false;
  let entryRealpathSafe = false;
  try {
    await resolveWorkspacePath(repoDirectory, plan.cwd, "RunPlan cwd", { allowRoot: true, expectedType: "directory" });
    cwdRealpathSafe = true;
    const entryPath = path.posix.join(plan.cwd.replaceAll("\\", "/"), plan.args[0].replaceAll("\\", "/"));
    await resolveWorkspacePath(repoDirectory, entryPath, "RunPlan entry point", { expectedType: "file" });
    entryRealpathSafe = true;
    const { trustedCase } = resolvePolicyContext(policyContext);
    const repositoryBundle = await verifyCasePolicyWorkspace(repoDirectory, trustedCase);
    if (!repositoryBundle.match) {
      throw new Error(`repository content did not match reviewed case bundle ${trustedCase.id}`);
    }
    return {
      ...classification,
      repositoryBundle: {
        ...repositoryBundle,
        bundleSha256: trustedCase.bundleSha256,
        reviewStatus: trustedCase.review.status,
        approvalType: "version-controlled-maintainer-metadata",
        signed: false,
        signatureVerification: "unsupported",
        origin: structuredClone(trustedCase.origin),
      },
      checks: {
        ...classification.checks,
        cwdRealpathSafe,
        entryRealpathSafe,
        repositoryBundleMatch: true,
      },
      rationale: `${classification.rationale} The working directory and entry point passed lstat/realpath checks, and every repository file matched the reviewed content manifest.`,
    };
  } catch (error) {
    return {
      ...classification,
      status: "rejected",
      classification: "unsafe-or-unapproved-run-plan",
      checks: {
        ...classification.checks,
        cwdRealpathSafe,
        entryRealpathSafe,
        repositoryBundleMatch: false,
      },
      rationale: `RunPlan workspace paths could not be approved: ${error.message}`,
    };
  }
}

export function approveRunPlan(classification, plan) {
  if (classification.status !== "eligible-for-approval"
    || classification.checks?.cwdRealpathSafe !== true
    || classification.checks?.entryRealpathSafe !== true
    || classification.checks?.repositoryBundleMatch !== true) {
    throw new Error("Run policy rejected the proposed execution plan");
  }
  return {
    actor: "Trusted case run policy",
    status: "approved",
    profileId: classification.profileId,
    trustedCaseId: classification.trustedCaseId,
    casePolicyBundle: structuredClone(classification.repositoryBundle),
    trustedFixtureOnly: true,
    osSandbox: false,
    networkIsolation: "not-enforced",
    resourceLimits: structuredClone(classification.resourceLimits),
    approvedPlan: structuredClone(plan),
    scope: "One registered plan over checked-in reviewed fixture code; arbitrary repositories remain disabled",
  };
}

export function formatRunPlan(plan) {
  return [plan.executable, ...plan.args].join(" ");
}
