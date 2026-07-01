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

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).map((v) => String(v)) : [];
}

// Build a focused, human-readable snapshot of ONE issue so the issue-scoped
// agent can answer about it, summarize the discussion, and suggest field
// improvements. Includes the issue's own fields, its comment thread, and any
// related issues.
export async function buildIssueIntel(issueId: string): Promise<string> {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
      labels: { include: { label: { select: { name: true } } } },
      comments: {
        orderBy: { createdAt: 'asc' },
        take: 40,
        select: {
          body: true,
          reviewState: true,
          createdAt: true,
          author: { select: { name: true } },
        },
      },
      relationsFrom: {
        include: {
          target: { select: { issueKey: true, title: true, type: true, status: true } },
        },
      },
      relationsTo: {
        include: {
          source: { select: { issueKey: true, title: true, type: true, status: true } },
        },
      },
    },
  });

  if (!issue) return 'No issue data available.';

  const steps = toStringList(issue.stepsToReproduce);
  const criteria = toStringList(issue.acceptanceCriteria);
  const labels = issue.labels.map((l) => l.label.name);

  const lines: string[] = [];
  lines.push('THIS ISSUE:');
  lines.push(`- key: ${issue.issueKey}`);
  lines.push(`- title: ${issue.title}`);
  lines.push(`- type: ${issue.type}`);
  lines.push(`- status: ${issue.status}`);
  if (issue.severity) lines.push(`- severity: ${issue.severity}`);
  if (issue.priority) lines.push(`- priority: ${issue.priority}`);
  if (issue.environment) lines.push(`- environment: ${issue.environment}`);
  if (labels.length) lines.push(`- labels: ${labels.join(', ')}`);
  if (issue.reporter?.name) lines.push(`- reporter: ${issue.reporter.name}`);
  if (issue.assignee?.name) lines.push(`- assignee: ${issue.assignee.name}`);

  lines.push('');
  lines.push('Description:');
  lines.push(issue.description || '(empty)');

  if (steps.length) {
    lines.push('');
    lines.push('Steps to reproduce:');
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }

  if (issue.expectedResult || issue.actualResult) {
    lines.push('');
    if (issue.expectedResult) lines.push(`Expected result: ${issue.expectedResult}`);
    if (issue.actualResult) lines.push(`Actual result: ${issue.actualResult}`);
  }

  if (criteria.length) {
    lines.push('');
    lines.push('Acceptance criteria:');
    criteria.forEach((c) => lines.push(`- ${c}`));
  }

  const related = [
    ...issue.relationsFrom.map((r) => r.target),
    ...issue.relationsTo.map((r) => r.source),
  ];
  if (related.length) {
    lines.push('');
    lines.push('Related issues:');
    for (const r of related) {
      lines.push(`- ${r.issueKey} [${r.type}/${r.status}] ${r.title}`);
    }
  }

  if (issue.comments.length) {
    lines.push('');
    lines.push('Discussion on this issue (oldest first):');
    for (const c of issue.comments) {
      const who = c.author?.name ?? 'Someone';
      const review = c.reviewState && c.reviewState !== 'commented' ? ` (${c.reviewState})` : '';
      const body = c.body.length > 400 ? `${c.body.slice(0, 400)}…` : c.body;
      lines.push(`- ${who}${review}: ${body}`);
    }
  } else {
    lines.push('');
    lines.push('Discussion on this issue: (no comments yet)');
  }

  return lines.join('\n');
}
