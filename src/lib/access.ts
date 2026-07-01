import type { ProjectMember, ProjectRole } from '@prisma/client';
import { prisma } from '../db/client.js';
import { HttpError } from '../middleware/errors.js';

// owner is a strict superset of member — an owner passes any member check.
const ROLE_RANK: Record<ProjectRole, number> = {
  member: 1,
  owner: 2,
};

/**
 * Resolve a caller's access to a project through ProjectMember.
 *
 * - Throws 404 when the project does not exist OR the caller is not a member,
 *   so a non-member cannot distinguish "no project" from "not invited"
 *   (project existence is not leaked).
 * - Throws 403 when the caller is a member but below `minRole`.
 * - Returns the caller's ProjectMember row on success.
 */
export async function requireProjectAccess(
  projectId: string,
  userId: string,
  minRole: ProjectRole = 'member',
): Promise<ProjectMember> {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });

  if (!member) {
    throw new HttpError(404, 'Project not found');
  }

  if (ROLE_RANK[member.role] < ROLE_RANK[minRole]) {
    throw new HttpError(403, 'You do not have permission to do that');
  }

  return member;
}

/**
 * Resolve access to a project given an issue id (issue -> project -> member).
 * Returns both the caller's membership and the issue's projectId so callers
 * can invalidate caches without a second lookup. Throws 404 if the issue does
 * not exist or the caller is not a member of its project.
 */
export async function requireIssueAccess(
  issueId: string,
  userId: string,
  minRole: ProjectRole = 'member',
): Promise<{ member: ProjectMember; projectId: string }> {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { projectId: true },
  });
  if (!issue) {
    throw new HttpError(404, 'Issue not found');
  }
  const member = await requireProjectAccess(issue.projectId, userId, minRole).catch(() => null);
  if (!member) {
    // Don't leak issue existence to non-members either.
    throw new HttpError(404, 'Issue not found');
  }
  return { member, projectId: issue.projectId };
}
