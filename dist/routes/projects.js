import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errors.js';
import { invalidateCache, remember } from '../services/response-cache.js';
import { generateProjectContext } from '../services/gemini.js';
import { getObjectBytes } from '../files/r2.js';
import { isR2Configured } from '../config/env.js';
export const projectsRouter = Router();
const createSchema = z.object({
    name: z.string().min(1).max(120),
    key: z
        .string()
        .min(2)
        .max(8)
        .regex(/^[A-Za-z]+$/, 'Key must be letters only')
        .optional(),
    description: z.string().min(1),
    color: z.string().optional(),
    links: z.array(z.string()).default([]),
    fileIds: z.array(z.string().uuid()).default([]),
    screenshotIds: z.array(z.string().uuid()).default([]),
});
const updateSchema = z.object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().min(1).optional(),
    color: z.string().optional(),
});
function deriveKey(name) {
    const letters = name.replace(/[^A-Za-z]/g, '').toUpperCase();
    return (letters.slice(0, 3) || 'PRJ').padEnd(2, 'X');
}
// Generate and persist the AI project context (runs inline, fire-and-forget).
async function runContextGeneration(projectId) {
    try {
        await prisma.project.update({
            where: { id: projectId },
            data: { contextStatus: 'generating' },
        });
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            include: { files: { include: { file: true } } },
        });
        if (!project)
            return;
        const fileSummaries = project.files.map((pf) => `${pf.file.fileName} (${pf.file.contentType}, ${pf.purpose})`);
        // Pull a handful of screenshots so the model can "see" the product and build
        // richer context. Bounded by count and size to stay within request limits.
        const MAX_IMAGES = 6;
        const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
        const images = [];
        if (isR2Configured) {
            const imageFiles = project.files
                .filter((pf) => pf.file.contentType.startsWith('image/') &&
                (pf.purpose === 'screenshot' || pf.purpose === 'context'))
                .slice(0, MAX_IMAGES);
            for (const pf of imageFiles) {
                try {
                    const bytes = await getObjectBytes(pf.file.objectKey);
                    if (bytes.length > MAX_IMAGE_BYTES)
                        continue;
                    images.push({ data: bytes.toString('base64'), mimeType: pf.file.contentType });
                }
                catch (err) {
                    console.error('Failed to load screenshot for context generation:', pf.file.id, err);
                }
            }
        }
        const result = await generateProjectContext({
            name: project.name,
            description: project.description,
            fileSummaries,
            links: [],
            images,
        });
        await prisma.projectContext.upsert({
            where: { projectId },
            create: {
                projectId,
                summary: result.summary,
                audience: result.audience,
                terminology: result.terminology,
                flows: result.flows,
                components: result.components,
                suggestedLabels: result.suggestedLabels,
                suggestedTemplates: result.suggestedTemplates,
                risks: result.risks,
                openQuestions: result.openQuestions,
                sourceFileIds: project.files.map((pf) => pf.fileId),
                model: 'gemini',
            },
            update: {
                summary: result.summary,
                audience: result.audience,
                terminology: result.terminology,
                flows: result.flows,
                components: result.components,
                suggestedLabels: result.suggestedLabels,
                suggestedTemplates: result.suggestedTemplates,
                risks: result.risks,
                openQuestions: result.openQuestions,
            },
        });
        // Seed suggested labels onto the project.
        for (const label of result.suggestedLabels.slice(0, 12)) {
            await prisma.label
                .create({ data: { projectId, name: label } })
                .catch(() => undefined);
        }
        await prisma.project.update({
            where: { id: projectId },
            data: { contextStatus: 'ready' },
        });
        invalidateCache(`workspace:${project.workspaceId}:projects`);
        invalidateCache(`workspace:${project.workspaceId}:project:${project.id}`);
    }
    catch (err) {
        console.error('Context generation failed:', err);
        const failedProject = await prisma.project
            .update({ where: { id: projectId }, data: { contextStatus: 'failed' } })
            .catch(() => undefined);
        if (failedProject) {
            invalidateCache(`workspace:${failedProject.workspaceId}:projects`);
            invalidateCache(`workspace:${failedProject.workspaceId}:project:${failedProject.id}`);
        }
    }
}
projectsRouter.use(requireAuth);
projectsRouter.get('/', asyncHandler(async (req, res) => {
    const workspaceId = req.workspaceId;
    if (!workspaceId)
        throw new HttpError(400, 'No workspace');
    const data = await remember(`workspace:${workspaceId}:projects`, 10_000, async () => {
        const projects = await prisma.project.findMany({
            where: { workspaceId },
            orderBy: { createdAt: 'asc' },
            select: {
                id: true,
                name: true,
                key: true,
                description: true,
                color: true,
                contextStatus: true,
                context: { select: { summary: true } },
                _count: { select: { issues: true } },
            },
        });
        const activeCounts = await prisma.issue.groupBy({
            by: ['projectId'],
            where: {
                project: { workspaceId },
                status: { not: 'resolved' },
            },
            _count: { _all: true },
        });
        const activeCountByProjectId = new Map(activeCounts.map((entry) => [entry.projectId, entry._count._all]));
        return projects.map((p) => ({
            id: p.id,
            name: p.name,
            key: p.key,
            description: p.description,
            summary: p.context?.summary ?? null,
            color: p.color,
            contextStatus: p.contextStatus,
            issueCount: p._count.issues,
            activeCount: activeCountByProjectId.get(p.id) ?? 0,
        }));
    });
    res.json({ projects: data });
}));
projectsRouter.post('/', asyncHandler(async (req, res) => {
    const workspaceId = req.workspaceId;
    if (!workspaceId)
        throw new HttpError(400, 'No workspace');
    const body = createSchema.parse(req.body);
    let key = (body.key ?? deriveKey(body.name)).toUpperCase();
    // Ensure key uniqueness within the workspace.
    const existingKeys = new Set((await prisma.project.findMany({
        where: { workspaceId },
        select: { key: true },
    })).map((p) => p.key));
    let suffix = 1;
    const base = key;
    while (existingKeys.has(key)) {
        key = `${base}${suffix++}`;
    }
    const project = await prisma.project.create({
        data: {
            workspaceId,
            name: body.name,
            key,
            description: body.description,
            color: body.color,
            createdById: req.user.id,
            files: {
                create: [
                    ...body.fileIds.map((fileId) => ({ fileId, purpose: 'context' })),
                    ...body.screenshotIds.map((fileId) => ({
                        fileId,
                        purpose: 'screenshot',
                    })),
                ],
            },
        },
    });
    invalidateCache(`workspace:${workspaceId}:projects`);
    // Kick off AI context generation without blocking the response.
    void runContextGeneration(project.id);
    res.status(201).json({ project });
}));
projectsRouter.get('/:projectId', asyncHandler(async (req, res) => {
    const workspaceId = req.workspaceId;
    if (!workspaceId)
        throw new HttpError(400, 'No workspace');
    const project = await remember(`workspace:${workspaceId}:project:${req.params.projectId}`, 10_000, async () => prisma.project.findFirst({
        where: { id: req.params.projectId, workspaceId },
        include: {
            context: true,
            labels: true,
            files: {
                orderBy: { createdAt: 'asc' },
                include: {
                    file: {
                        select: {
                            id: true,
                            fileName: true,
                            contentType: true,
                            sizeBytes: true,
                            createdAt: true,
                        },
                    },
                },
            },
        },
    }));
    if (!project)
        throw new HttpError(404, 'Project not found');
    res.json({ project });
}));
projectsRouter.patch('/:projectId', asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    const project = await prisma.project.updateMany({
        where: { id: req.params.projectId, workspaceId: req.workspaceId },
        data: body,
    });
    if (!project)
        throw new HttpError(404, 'Project not found');
    if (project.count === 0)
        throw new HttpError(404, 'Project not found');
    if (req.workspaceId) {
        invalidateCache(`workspace:${req.workspaceId}:projects`);
        invalidateCache(`workspace:${req.workspaceId}:project:${req.params.projectId}`);
    }
    res.json({ ok: true });
}));
projectsRouter.delete('/:projectId', asyncHandler(async (req, res) => {
    const workspaceId = req.workspaceId;
    if (!workspaceId)
        throw new HttpError(400, 'No workspace');
    const project = await prisma.project.findFirst({
        where: { id: req.params.projectId, workspaceId },
        select: { id: true },
    });
    if (!project)
        throw new HttpError(404, 'Project not found');
    // Related rows (issues, labels, files, threads, context, suggestions,
    // relations, activity) cascade via the schema's onDelete: Cascade.
    await prisma.project.delete({ where: { id: project.id } });
    invalidateCache(`workspace:${workspaceId}:projects`);
    invalidateCache(`workspace:${workspaceId}:project:${project.id}`);
    invalidateCache(`workspace:${workspaceId}:project:${project.id}:issues`);
    invalidateCache(`project:${project.id}:context`);
    res.json({ ok: true });
}));
projectsRouter.get('/:projectId/context', asyncHandler(async (req, res) => {
    const context = await remember(`project:${req.params.projectId}:context`, 10_000, async () => prisma.projectContext.findUnique({
        where: { projectId: req.params.projectId },
    }));
    res.json({ context });
}));
projectsRouter.post('/:projectId/context/regenerate', asyncHandler(async (req, res) => {
    const project = await prisma.project.findFirst({
        where: { id: req.params.projectId, workspaceId: req.workspaceId },
    });
    if (!project)
        throw new HttpError(404, 'Project not found');
    if (req.workspaceId) {
        invalidateCache(`workspace:${req.workspaceId}:projects`);
        invalidateCache(`workspace:${req.workspaceId}:project:${project.id}`);
    }
    invalidateCache(`project:${project.id}:context`);
    void runContextGeneration(project.id);
    res.json({ ok: true, contextStatus: 'generating' });
}));
//# sourceMappingURL=projects.js.map