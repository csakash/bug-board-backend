import { prisma } from '../db/client.js';
import { invalidateCache } from './response-cache.js';

// Cache-key scheme (post project-membership refactor):
//   user:{userId}:projects        — a user's project list (membership-scoped)
//   project:{projectId}:detail    — project detail
//   project:{projectId}:issues    — board issue list
//   project:{projectId}:context   — AI context
//   issue:{issueId}:detail        — issue detail
//   issue:{issueId}:activity      — issue activity feed
//   issue:{issueId}:related       — related-issue suggestions
//
// invalidateCache matches by prefix, so `project:{id}:` clears detail+issues+context.

// Clear everything scoped to a project, plus each member's project-list cache.
// Per-user list caches can't be targeted by projectId alone, so we enumerate
// the project's members. In-memory + per-instance; short TTLs remain the
// reliable cross-instance freshness knob on serverless.
export async function invalidateProjectCaches(projectId: string): Promise<void> {
  invalidateCache(`project:${projectId}:`);
  const members = await prisma.projectMember.findMany({
    where: { projectId },
    select: { userId: true },
  });
  for (const m of members) invalidateCache(`user:${m.userId}:projects`);
}

// An issue write changes the issue itself plus the board list, project detail
// counts, and every member's project-list active counts.
export async function invalidateIssueCaches(projectId: string, issueId: string): Promise<void> {
  invalidateCache(`issue:${issueId}:`);
  await invalidateProjectCaches(projectId);
}
