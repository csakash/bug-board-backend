import { prisma } from '../db/client.js';

// Build a compact, human-readable snapshot of a project's live state so the
// chat agent can answer questions about issues, status, and ongoing discussion.
export async function buildProjectIntel(projectId: string): Promise<string> {
  const [project, statusCounts, severityCounts, recentIssues, recentComments] =
    await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        include: { context: true },
      }),
      prisma.issue.groupBy({
        by: ['status'],
        where: { projectId },
        _count: { _all: true },
      }),
      prisma.issue.groupBy({
        by: ['severity'],
        where: { projectId, severity: { not: null } },
        _count: { _all: true },
      }),
      prisma.issue.findMany({
        where: { projectId },
        orderBy: { updatedAt: 'desc' },
        take: 25,
        select: {
          issueKey: true,
          title: true,
          type: true,
          status: true,
          severity: true,
          priority: true,
          updatedAt: true,
          _count: { select: { comments: true } },
        },
      }),
      prisma.comment.findMany({
        where: { issue: { projectId } },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: {
          body: true,
          reviewState: true,
          createdAt: true,
          author: { select: { name: true } },
          issue: { select: { issueKey: true, title: true } },
        },
      }),
    ]);

  if (!project) return 'No project data available.';

  const statusMap = new Map(statusCounts.map((s) => [s.status, s._count._all]));
  const total = statusCounts.reduce((sum, s) => sum + s._count._all, 0);

  const lines: string[] = [];
  lines.push(`Project: ${project.name} (${project.key})`);
  lines.push(`Description: ${project.description}`);
  if (project.context?.summary) {
    lines.push(`Context summary: ${project.context.summary}`);
  }

  lines.push('');
  lines.push('Issue status counts:');
  lines.push(`- total: ${total}`);
  lines.push(`- open: ${statusMap.get('open') ?? 0}`);
  lines.push(`- in_progress: ${statusMap.get('in_progress') ?? 0}`);
  lines.push(`- resolved: ${statusMap.get('resolved') ?? 0}`);

  if (severityCounts.length) {
    lines.push('');
    lines.push('Severity breakdown:');
    for (const s of severityCounts) {
      lines.push(`- ${s.severity}: ${s._count._all}`);
    }
  }

  if (recentIssues.length) {
    lines.push('');
    lines.push('Recent issues (most recently updated first):');
    for (const issue of recentIssues) {
      const sev = issue.severity ? `, severity ${issue.severity}` : '';
      const pri = issue.priority ? `, priority ${issue.priority}` : '';
      lines.push(
        `- ${issue.issueKey} [${issue.type}/${issue.status}${sev}${pri}] ${issue.title} (${issue._count.comments} comments)`,
      );
    }
  }

  if (recentComments.length) {
    lines.push('');
    lines.push('Recent discussion across issues:');
    for (const c of recentComments) {
      const who = c.author?.name ?? 'Someone';
      const review = c.reviewState ? ` (${c.reviewState})` : '';
      const body = c.body.length > 160 ? `${c.body.slice(0, 160)}…` : c.body;
      lines.push(`- ${c.issue.issueKey}${review} — ${who}: ${body}`);
    }
  }

  return lines.join('\n');
}
