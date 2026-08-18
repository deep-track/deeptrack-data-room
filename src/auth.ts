export type DataRoomRole = "founder" | "investorRelations" | "investor";

export type ReviewSession = {
  role: DataRoomRole;
  displayName: string;
  email: string;
  clearanceTier: 1 | 2 | 3;
};

export const roleDetails: Record<DataRoomRole, { label: string; description: string; clearanceTier: 1 | 2 | 3; administrator: boolean }> = {
  founder: { label: "Founder", description: "Super privileges for room policy, access, publication, and audit oversight.", clearanceTier: 3, administrator: true },
  investorRelations: { label: "Investor Relations Officer", description: "Operational administrator for disclosure workflow, invitations, and diligence support.", clearanceTier: 3, administrator: true },
  investor: { label: "Investor", description: "Read-only access to approved documents within assigned clearance.", clearanceTier: 1, administrator: false },
};

export const reviewRoleAccess: Partial<Record<DataRoomRole, { email: string; displayName: string }>> = {
  founder: { email: "bryan@deeptrack.io", displayName: "Bryan Koyundi" },
  investorRelations: { email: "ygachara@deeptrack.io", displayName: "Yvonne" },
};

export function isAdministrator(role: DataRoomRole) {
  return roleDetails[role].administrator;
}
