import { randomUUID } from 'node:crypto';
import express from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errors.js';
import { buildObjectKey, getDownloadUrl, getUploadUrl, isR2Configured, uploadObject, } from '../files/r2.js';
import { env } from '../config/env.js';
export const uploadsRouter = Router();
const presignSchema = z.object({
    fileName: z.string().min(1),
    contentType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().optional(),
    projectId: z.string().uuid().optional(),
});
const completeSchema = z.object({
    fileId: z.string().uuid(),
    sizeBytes: z.number().int().nonnegative().optional(),
});
// Step 1: client asks for a presigned PUT url.
uploadsRouter.post('/presign', requireAuth, asyncHandler(async (req, res) => {
    if (!isR2Configured)
        throw new HttpError(503, 'File storage is not configured');
    const workspaceId = req.workspaceId;
    if (!workspaceId)
        throw new HttpError(400, 'No workspace');
    const { fileName, contentType, sizeBytes, projectId } = presignSchema.parse(req.body);
    const fileId = randomUUID();
    const objectKey = buildObjectKey({ workspaceId, projectId, fileId, fileName });
    const file = await prisma.file.create({
        data: {
            id: fileId,
            workspaceId,
            uploadedById: req.user.id,
            bucket: env.r2.bucket,
            objectKey,
            fileName,
            contentType,
            sizeBytes: BigInt(sizeBytes ?? 0),
            metadata: { status: 'pending' },
        },
    });
    const uploadUrl = await getUploadUrl(objectKey, contentType);
    res.json({ fileId: file.id, uploadUrl, objectKey });
}));
// Step 2: client confirms the upload finished.
uploadsRouter.post('/complete', requireAuth, asyncHandler(async (req, res) => {
    const { fileId, sizeBytes } = completeSchema.parse(req.body);
    const file = await prisma.file.update({
        where: { id: fileId },
        data: {
            sizeBytes: sizeBytes != null ? BigInt(sizeBytes) : undefined,
            metadata: { status: 'ready' },
        },
    });
    res.json({ file: { ...file, sizeBytes: file.sizeBytes.toString() } });
}));
// Browser-to-R2 uploads require bucket CORS. This endpoint avoids that dependency
// by accepting the file body and uploading to R2 from the backend.
uploadsRouter.post('/:fileId/content', requireAuth, express.raw({ type: '*/*', limit: '50mb' }), asyncHandler(async (req, res) => {
    if (!isR2Configured)
        throw new HttpError(503, 'File storage is not configured');
    const workspaceId = req.workspaceId;
    if (!workspaceId)
        throw new HttpError(400, 'No workspace');
    const file = await prisma.file.findFirst({
        where: { id: req.params.fileId, workspaceId },
    });
    if (!file)
        throw new HttpError(404, 'File not found');
    if (!Buffer.isBuffer(req.body))
        throw new HttpError(400, 'Invalid file body');
    await uploadObject({
        objectKey: file.objectKey,
        contentType: file.contentType,
        body: req.body,
    });
    const updated = await prisma.file.update({
        where: { id: file.id },
        data: {
            sizeBytes: BigInt(req.body.length),
            metadata: { status: 'ready', uploadMode: 'backend-proxy' },
        },
    });
    res.json({ file: { ...updated, sizeBytes: updated.sizeBytes.toString() } });
}));
// Resolve a file id to a short-lived signed download url.
uploadsRouter.get('/:fileId/url', requireAuth, asyncHandler(async (req, res) => {
    const file = await prisma.file.findUnique({ where: { id: req.params.fileId } });
    if (!file)
        throw new HttpError(404, 'File not found');
    const url = await getDownloadUrl(file.objectKey);
    res.json({ url, fileName: file.fileName, contentType: file.contentType });
}));
//# sourceMappingURL=uploads.js.map