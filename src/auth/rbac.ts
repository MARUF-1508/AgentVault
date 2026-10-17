/**
 * Role-based access for the local web UI. Pure: no I/O. The policy engine still
 * decides every transaction; roles only decide who may ask, approve or pause.
 *
 * viewer   : read balances, policy, budgets and the audit trail.
 * operator : viewer + preview, submit transfers and chat with the agent.
 *            T2 transactions still wait for an owner's approval.
 * owner    : operator + approve/reject T2, pause the wallet and manage web
 *            accounts (admin). New accounts are never self-served: only an
 *            owner can add one, and only the first owner can be created
 *            during first-run setup.
 *
 * No role can change the policy, resume a paused wallet or touch keys.
 */
export const ROLES = ['viewer', 'operator', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export type Permission = 'read' | 'preview' | 'transact' | 'chat' | 'approve' | 'pause' | 'admin';

const GRANTS: Record<Role, readonly Permission[]> = {
  viewer: ['read'],
  operator: ['read', 'preview', 'transact', 'chat'],
  owner: ['read', 'preview', 'transact', 'chat', 'approve', 'pause', 'admin'],
};

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}

export function permissionsOf(role: Role): Permission[] {
  return [...GRANTS[role]];
}
