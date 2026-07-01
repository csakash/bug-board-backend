/**
 * One-time backfill for the project-membership model.
 *
 * Before this feature, access was workspace-scoped: every WorkspaceMember could
 * see every project in the workspace. To preserve that exact visibility after
 * switching to per-project membership, for each existing project we create:
 *   - one `owner` ProjectMember (the project's createdBy, or the workspace owner
 *     when createdById is null), and
 *   - a `member` ProjectMember for every other member of the project's workspace.
 *
 * Idempotent: safe to run multiple times (uses upsert on the unique
 * (projectId, userId) pair). Run after the schema migration:
 *   npm run db:backfill-members
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, workspaceId: true, createdById: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Backfilling members for ${projects.length} project(s)...`);
  let ownerRows = 0;
  let memberRows = 0;
  let skipped = 0;

  for (const project of projects) {
    const workspaceMembers = await prisma.workspaceMember.findMany({
      where: { workspaceId: project.workspaceId },
      orderBy: { createdAt: 'asc' },
      select: { userId: true, role: true },
    });

    if (workspaceMembers.length === 0) {
      console.warn(`  ! ${project.name} (${project.id}) has no workspace members — skipping`);
      skipped += 1;
      continue;
    }

    // Owner: the creator, else the workspace's `owner` member, else the first.
    const workspaceOwner =
      workspaceMembers.find((m) => m.role === 'owner') ?? workspaceMembers[0];
    const ownerUserId = project.createdById ?? workspaceOwner.userId;

    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: ownerUserId } },
      create: { projectId: project.id, userId: ownerUserId, role: 'owner' },
      update: { role: 'owner' },
    });
    ownerRows += 1;

    for (const wm of workspaceMembers) {
      if (wm.userId === ownerUserId) continue;
      await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: project.id, userId: wm.userId } },
        create: { projectId: project.id, userId: wm.userId, role: 'member' },
        update: {},
      });
      memberRows += 1;
    }
  }

  console.log(
    `Done. owners=${ownerRows}, members=${memberRows}, skipped=${skipped}.`,
  );
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
