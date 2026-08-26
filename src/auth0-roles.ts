export type DataRoomRole = "founder" | "investorRelations" | "investor";
export type RoleResolutionConfig = {
  founderEmails?: string;
  investorRelationsEmails?: string;
};

function emailSet(value: string | undefined, fallback: string) {
  return new Set((value?.trim() || fallback).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function resolveDataRoomRole(user: { email?: string; roles?: unknown }, config: RoleResolutionConfig = {}) {
  const email = (user.email || "").trim().toLowerCase();
  const founderEmails = emailSet(config.founderEmails, "bryan@deeptrack.io");
  const investorRelationsEmails = emailSet(config.investorRelationsEmails, "ygachara@deeptrack.io");
  const roles = (Array.isArray(user.roles) ? user.roles.filter((item): item is string => typeof item === "string") : typeof user.roles === "string" ? [user.roles] : []).map((value) => value.trim().toLowerCase());
  const role: DataRoomRole = founderEmails.has(email) || roles.some((value) => ["founder", "owner", "head"].includes(value))
    ? "founder"
    : investorRelationsEmails.has(email) || roles.some((value) => ["investorrelations", "investor_relations", "investor-relations", "admin"].includes(value))
      ? "investorRelations"
      : "investor";
  return { role, clearanceTier: role === "investor" ? 1 as const : 3 as const };
}
