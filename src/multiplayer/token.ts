import { randomBytes } from 'node:crypto';

/** Generate a 12-char URL-safe random invite token. */
export function generateInviteToken(): string {
  return randomBytes(9).toString('base64url');
}

export type InviteValidityInput = {
  revokedAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  usesCount: number;
};

/** Check whether an invite is currently usable. */
export function isInviteValid(invite: InviteValidityInput, now: Date = new Date()): boolean {
  if (invite.revokedAt) return false;
  if (invite.expiresAt && invite.expiresAt.getTime() < now.getTime()) return false;
  if (invite.maxUses !== null && invite.usesCount >= invite.maxUses) return false;
  return true;
}
