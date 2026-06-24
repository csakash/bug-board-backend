import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const password = await bcrypt.hash('password123', 10);

  const maya = await prisma.user.upsert({
    where: { email: 'maya@bugboard.dev' },
    update: {},
    create: { name: 'Maya Chen', email: 'maya@bugboard.dev', password },
  });

  const priya = await prisma.user.upsert({
    where: { email: 'priya@bugboard.dev' },
    update: {},
    create: { name: 'Priya Nair', email: 'priya@bugboard.dev', password },
  });

  const workspace = await prisma.workspace.create({
    data: {
      name: "Maya's workspace",
      members: {
        create: [
          { userId: maya.id, role: 'owner' },
          { userId: priya.id, role: 'member' },
        ],
      },
    },
  });

  // --- Checkout Web ---
  const chk = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Checkout Web',
      key: 'CHK',
      description: 'Customer-facing checkout, cart and payments.',
      color: '#c0552d',
      contextStatus: 'ready',
      createdById: maya.id,
    },
  });

  async function addIssue(
    project: { id: string; key: string },
    data: {
      type: string;
      title: string;
      description: string;
      status: string;
      severity?: string;
      labels?: string[];
      environment?: string;
      stepsToReproduce?: string[];
      expectedResult?: string;
      actualResult?: string;
      reporterId: string;
    },
  ) {
    const updated = await prisma.project.update({
      where: { id: project.id },
      data: { issueCounter: { increment: 1 } },
    });
    const issueNumber = updated.issueCounter;
    const issue = await prisma.issue.create({
      data: {
        projectId: project.id,
        issueNumber,
        issueKey: `${project.key}-${issueNumber}`,
        type: data.type as never,
        title: data.title,
        description: data.description,
        status: data.status as never,
        severity: (data.severity ?? null) as never,
        environment: data.environment,
        stepsToReproduce: data.stepsToReproduce ?? [],
        expectedResult: data.expectedResult,
        actualResult: data.actualResult,
        reporterId: data.reporterId,
        source: 'manual',
      },
    });
    for (const name of data.labels ?? []) {
      const label = await prisma.label.upsert({
        where: { projectId_name: { projectId: project.id, name } },
        create: { projectId: project.id, name },
        update: {},
      });
      await prisma.issueLabel.create({
        data: { issueId: issue.id, labelId: label.id },
      });
    }
    return issue;
  }

  await addIssue(chk, {
    type: 'regression',
    title: 'Customers charged twice when retrying a failed payment',
    description:
      'When a payment is declined and the customer immediately retries, the second attempt occasionally succeeds for both the original and the retried charge, resulting in a duplicate charge on their card.',
    status: 'open',
    severity: 'critical',
    labels: ['payments', 'regression'],
    environment: 'Chrome 126 · macOS 14.5 · Production',
    stepsToReproduce: [
      'Add an item to the cart and proceed to checkout',
      'Use a test card that declines on the first attempt',
      'Immediately click Try again after the decline',
      'Observe two successful charges in the Stripe dashboard',
    ],
    expectedResult: 'Only a single successful charge is created once the retry succeeds.',
    actualResult:
      'Two charges are created and the customer is billed twice, requiring a manual refund.',
    reporterId: priya.id,
  });
  await addIssue(chk, {
    type: 'bug',
    title: 'Promo code field clears after applying a discount',
    description: 'The promo code input resets unexpectedly after a discount is applied.',
    status: 'open',
    severity: 'medium',
    labels: ['payments', 'ui'],
    reporterId: maya.id,
  });
  await addIssue(chk, {
    type: 'improvement',
    title: 'Checkout button slow to respond on first click',
    description: 'The primary checkout button has noticeable latency on the first interaction.',
    status: 'in_progress',
    severity: 'medium',
    labels: ['performance'],
    reporterId: priya.id,
  });
  await addIssue(chk, {
    type: 'bug',
    title: 'Address autocomplete returns wrong postal codes',
    description: 'Autocomplete occasionally returns postal codes that do not match the street.',
    status: 'in_progress',
    severity: 'high',
    labels: ['ui'],
    reporterId: maya.id,
  });
  await addIssue(chk, {
    type: 'bug',
    title: 'Order summary total misaligned on Safari',
    description: 'On Safari the order summary total is visually misaligned.',
    status: 'resolved',
    severity: 'low',
    labels: ['ui'],
    reporterId: maya.id,
  });
  await addIssue(chk, {
    type: 'bug',
    title: 'Guest checkout fails when email contains a plus sign',
    description: 'Guest checkout rejects valid emails that contain a plus sign.',
    status: 'resolved',
    severity: 'high',
    labels: ['auth', 'payments'],
    reporterId: maya.id,
  });

  // --- Mobile App ---
  const mob = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Mobile App',
      key: 'MOB',
      description: 'iOS and Android consumer application.',
      color: '#3f6f4e',
      contextStatus: 'ready',
      createdById: maya.id,
    },
  });
  await addIssue(mob, {
    type: 'bug',
    title: 'App crashes on launch after updating to v4.2',
    description: 'Some users see an immediate crash on launch after updating to v4.2.',
    status: 'open',
    severity: 'critical',
    reporterId: maya.id,
  });
  await addIssue(mob, {
    type: 'bug',
    title: 'Push notifications arrive 10+ minutes late',
    description: 'Push notifications are significantly delayed.',
    status: 'open',
    severity: 'medium',
    reporterId: maya.id,
  });
  await addIssue(mob, {
    type: 'bug',
    title: 'Dark mode toggle resets after backgrounding',
    description: 'The dark mode preference resets after the app is backgrounded.',
    status: 'in_progress',
    severity: 'low',
    reporterId: maya.id,
  });

  // --- Admin Dashboard ---
  const adm = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Admin Dashboard',
      key: 'ADM',
      description: 'Internal operations and support tooling.',
      color: '#5b5bd6',
      contextStatus: 'ready',
      createdById: maya.id,
    },
  });
  await addIssue(adm, {
    type: 'feature',
    title: 'Bulk export of support tickets to CSV',
    description: 'Support team needs to export filtered tickets to CSV.',
    status: 'open',
    severity: 'low',
    reporterId: maya.id,
  });
  await addIssue(adm, {
    type: 'task',
    title: 'Add audit log for permission changes',
    description: 'Track who changed permissions and when.',
    status: 'in_progress',
    severity: 'medium',
    reporterId: maya.id,
  });

  console.log('Seed complete. Login: maya@bugboard.dev / password123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
