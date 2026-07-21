import { resolvePolicyContext } from "./policy-registry.js";
import { resolveWorkspacePath } from "./workspace-path.js";

function sameText(left, right) {
  return typeof left === "string" && left === right;
}

export function classifyRepairProposal(proposal, policyContext) {
  const resolved = resolvePolicyContext(policyContext);
  const rules = resolved.trustedCase?.repairRules || [];
  const matchedRule = rules.find((rule) => (
    sameText(proposal?.file, rule.file)
      && sameText(proposal?.oldText, rule.oldText)
      && sameText(proposal?.newText, rule.newText)
  ));
  const allowListChecks = {
    policyContextRegistered: resolved.valid,
    repairCandidateId: rules.some((rule) => sameText(proposal?.repairCandidateId, rule.id)),
    file: rules.some((rule) => sameText(proposal?.file, rule.file)),
    oldText: rules.some((rule) => sameText(proposal?.oldText, rule.oldText)),
    newText: rules.some((rule) => sameText(proposal?.newText, rule.newText)),
    exactPatch: Boolean(matchedRule),
  };
  const allowListMatch = Boolean(matchedRule);
  return {
    actor: "Patch policy engine",
    profileId: resolved.profile?.id || policyContext?.profileId || null,
    trustedCaseId: resolved.trustedCase?.id || policyContext?.trustedCaseId || null,
    agentRecommendation: proposal?.classificationAdvisory || "missing",
    policyClassification: allowListMatch ? matchedRule.policyClassification : "analytical-or-unapproved",
    classification: allowListMatch ? matchedRule.policyClassification : "analytical-or-unapproved",
    allowListMatch,
    allowListRule: matchedRule?.id || null,
    allowListChecks,
    status: allowListMatch ? "eligible-for-approval" : "rejected",
    rationale: allowListMatch
      ? `The exact patch matched a reviewed repair rule registered for ${resolved.trustedCase.label}. The investigator's candidate ID and classification were not trusted.`
      : "No exact reviewed repair rule for this registered case matched the proposed file, removed text, and replacement text; the agent's advisory classification was not trusted.",
  };
}

export async function classifyRepairProposalForWorkspace(repoDirectory, proposal, policyContext) {
  const classification = classifyRepairProposal(proposal, policyContext);
  if (classification.status === "rejected") return classification;
  try {
    await resolveWorkspacePath(repoDirectory, proposal.file, "patch target", { expectedType: "file" });
    return {
      ...classification,
      allowListChecks: { ...classification.allowListChecks, targetRealpathSafe: true },
      rationale: `${classification.rationale} The patch target also passed lstat and realpath checks.`,
    };
  } catch (error) {
    return {
      ...classification,
      allowListMatch: false,
      status: "rejected",
      policyClassification: "analytical-or-unapproved",
      classification: "analytical-or-unapproved",
      allowListChecks: { ...classification.allowListChecks, targetRealpathSafe: false },
      rationale: `Patch target could not be approved: ${error.message}`,
    };
  }
}

export function approveRepair(classification, proposal) {
  if (classification.status !== "eligible-for-approval" || !classification.allowListMatch
    || classification.allowListChecks?.targetRealpathSafe !== true) {
    throw new Error("Repair policy rejected the proposed change");
  }
  return {
    actor: "Trusted case repair policy",
    status: "approved",
    profileId: classification.profileId,
    trustedCaseId: classification.trustedCaseId,
    mechanism: "Exact registered replacement",
    humanApproval: false,
    scope: "One reviewed infrastructure-only replacement in the per-audit trusted fixture copy",
    allowListRule: classification.allowListRule,
    approvedPatch: {
      repairCandidateId: classification.allowListRule,
      file: proposal.file,
      oldText: proposal.oldText,
      newText: proposal.newText,
    },
  };
}
