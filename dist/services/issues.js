import { prisma } from '../db/client.js';
const ISSUE_TYPES = [
    'bug',
    'feature',
    'improvement',
    'task',
    'regression',
    'investigation',
    'design',
    'documentation',
    'support',
    'question',
];
const STATUSES = ['open', 'in_progress', 'resolved'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
function pick(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}
// Create an issue with an atomic per-project issue number/key, labels and files.
export async function createIssue(projectId, input) {
    return prisma.$transaction(async (tx) => {
        const project = await tx.project.update({
            where: { id: projectId },
            data: { issueCounter: { increment: 1 } },
        });
        const issueNumber = project.issueCounter;
        const issueKey = `${project.key}-${issueNumber}`;
        const issue = await tx.issue.create({
            data: {
                projectId,
                issueNumber,
                issueKey,
                type: (pick(input.type, ISSUE_TYPES, 'bug') ?? 'bug'),
                title: input.title,
                description: input.description,
                status: (pick(input.status, STATUSES, 'open') ?? 'open'),
                severity: pick(input.severity, SEVERITIES, null),
                priority: pick(input.priority, PRIORITIES, null),
                environment: input.environment ?? null,
                expectedResult: input.expectedResult ?? null,
                actualResult: input.actualResult ?? null,
                acceptanceCriteria: input.acceptanceCriteria ?? [],
                stepsToReproduce: input.stepsToReproduce ?? [],
                reporterId: input.reporterId ?? null,
                source: (input.source ?? 'manual'),
                aiConfidence: input.aiConfidence ?? null,
            },
        });
        // Attach labels, creating any that do not yet exist on the project.
        for (const name of input.labels ?? []) {
            const label = await tx.label.upsert({
                where: { projectId_name: { projectId, name } },
                create: { projectId, name },
                update: {},
            });
            await tx.issueLabel.create({
                data: { issueId: issue.id, labelId: label.id },
            });
        }
        for (const fileId of input.fileIds ?? []) {
            await tx.issueFile
                .create({ data: { issueId: issue.id, fileId } })
                .catch(() => undefined);
        }
        await tx.activityEvent.create({
            data: {
                projectId,
                issueId: issue.id,
                actorId: input.reporterId ?? null,
                eventType: 'issue_created',
                payload: { source: input.source ?? 'manual' },
            },
        });
        return issue;
    });
}
//# sourceMappingURL=issues.js.map