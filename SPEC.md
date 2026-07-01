# SPEC — Project invitations, project-level membership & multi-user collaboration

**Slug:** `project-invites`
**Spans:** `backend/` (schema, auth, routes, email service) + `frontend/` (invite UI, invite landing page, polling)
**Status:** ready to implement

---

## Context

Bug Board today is single-tenant per user. Registration creates one personal
`Workspace` (owner) and the JWT (`bb_token`) carries exactly one `workspaceId`
([backend/src/middleware/auth.ts:29](backend/src/middleware/auth.ts)). Every
project/issue query filters by `req.workspaceId`, so "who can see a project" is
identical to "who is in the workspace" — there is no way to bring a specific
outside person into a specific project, and no notion of a project being personal
vs shared.

We want: while creating a project (and later, from Project details) the owner can
invite people by email; the invitee gets an email from Resend; clicking it lets
them sign up (or log in if they already have an account) and lands them directly
on that project's board as a member; owners and members collaborate on the same
issues with each other's changes visible within seconds. Projects with no other
members are "personal"; inviting someone makes a project "shared."

Issues, comments, and the per-issue activity feed already work end to end
([backend/src/routes/issues.ts:308](backend/src/routes/issues.ts) comments,
`:354` activity; frontend `IssueDetailPage`). This feature does **not** rebuild
collaboration primitives — it opens them to invited members and makes cross-user
changes visible.

**Decisions locked with the requester:**
- **Access model:** new project-level membership (`ProjectMember`). Access resolves
  per project, not per workspace.
- **Roles:** two per project — `owner` (creator; invite/revoke members, delete
  project, everything a member can do) and `member` (create/edit/comment/move
  issues). No viewer role.
- **Invites:** owner-only. Opaque token link, **locked to the invited email**,
  **7-day expiry**, single-use, revocable. Handles both a brand-new signup and an
  existing account.
- **Email:** Resend Node SDK. Env `RESEND_API_KEY` + `RESEND_FROM`. Key set later;
  when unset, log the invite link to the server console so the flow is testable.
- **Realtime:** polling (TanStack Query `refetchInterval` ~5–10s) + shortened
  server cache TTLs. No SSE/WebSocket infra.
- **Personal vs shared:** implicit (personal until someone is invited). No toggle.

---

## Current State (verified 2026-07-01)

Every authenticated route derives `req.workspaceId` and scopes on it. The refactor
must replace workspace-scoping with project-membership access checks at each site:

| File | Route(s) | Current scoping | Change |
|---|---|---|---|
| `backend/src/routes/projects.ts:146` | `GET /` list | `where: { workspaceId }` | list projects where caller is a `ProjectMember` |
| `backend/src/routes/projects.ts:198` | `POST /` create | writes `workspaceId`, `createdById` | also create owner `ProjectMember`; accept optional `invites[]` |
| `backend/src/routes/projects.ts:250` | `GET /:id` | `findFirst … workspaceId` | `requireProjectAccess(member)` |
| `backend/src/routes/projects.ts:287` | `PATCH /:id` | `updateMany … workspaceId` | `requireProjectAccess(owner)` |
| `backend/src/routes/projects.ts:305` | `DELETE /:id` | `findFirst … workspaceId` | `requireProjectAccess(owner)` |
| `backend/src/routes/projects.ts:330,345` | context get/regenerate | `workspaceId` | get→member, regenerate→owner |
| `backend/src/routes/issues.ts:75` | `GET …/issues` | `project: { workspaceId }` | `requireProjectAccess(member)` |
| `backend/src/routes/issues.ts:114` | `POST …/issues` | `findFirst … workspaceId` | `requireProjectAccess(member)` |
| `backend/src/routes/issues.ts` (search, detail, PATCH, comment, activity, related) | all | `workspaceId` | member access; search spans caller's member-projects, not the workspace |
| `backend/src/routes/chat.ts`, `uploads.ts` | all | `workspaceId` | member access on the referenced project (audit during build) |

Cache keys are currently `workspace:{workspaceId}:...`
([response-cache.ts](backend/src/services/response-cache.ts) via `remember`/
`invalidateCache`). The projects-list cache must become per-user
(`user:{userId}:projects`); project/issue caches key by `project:{projectId}:...`.
`invalidateCache` is in-memory per instance — on Vercel serverless it does not
span instances, so **short TTL is the reliable cross-user freshness knob**, not
invalidation.

`config/env.ts` has no email config; `package.json` has no `resend` dependency.
`Project.createdById` is nullable. `App.tsx` has no `/invite` route; `LoginPage`
handles both login and register; `CreateProjectModal` posts `{name, description,
fileIds, screenshotIds}` then navigates to the board.

---

## Proposed Change

### 1. Data model (`backend/prisma/schema.prisma`)

```prisma
enum ProjectRole {
  owner
  member
}

enum InviteStatus {
  pending
  accepted
  revoked
  expired
}

model ProjectMember {
  id        String      @id @default(uuid())
  projectId String
  userId    String
  role      ProjectRole @default(member)
  createdAt DateTime    @default(now())

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([projectId, userId])
  @@index([userId])
}

model ProjectInvite {
  id           String       @id @default(uuid())
  projectId    String
  email        String                       // stored lower-cased
  role         ProjectRole  @default(member)
  token        String       @unique          // crypto.randomBytes(32).base64url
  status       InviteStatus @default(pending)
  invitedById  String?
  acceptedById String?
  expiresAt    DateTime
  createdAt    DateTime     @default(now())
  updatedAt    DateTime     @updatedAt

  project    Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  invitedBy  User?   @relation("InviteSender",   fields: [invitedById],  references: [id])
  acceptedBy User?   @relation("InviteAcceptor", fields: [acceptedById], references: [id])

  @@index([projectId, status])
  @@index([email])
}
```

Add relations: `Project.members ProjectMember[]`, `Project.invites ProjectInvite[]`;
`User.projectMemberships ProjectMember[]`, `User.sentInvites ProjectInvite[]
@relation("InviteSender")`, `User.acceptedInvites ProjectInvite[]
@relation("InviteAcceptor")`.

### 2. Access control (`backend/src/lib/access.ts`, new)

```ts
// Throws 404 if the project doesn't exist / caller isn't a member;
// throws 403 if member but below minRole. owner satisfies any minRole.
async function requireProjectAccess(
  projectId: string, userId: string, minRole: ProjectRole = 'member'
): Promise<ProjectMember>
```

- 404 (not 403) when the caller is a non-member, so project existence isn't leaked.
- `owner ⊇ member`: owner passes `member` checks.
- `requireAuth` stays for identity; `req.workspaceId` remains available for the
  "which workspace does a newly created project live in" default only.

### 3. Invitation endpoints

Owner-only (via `requireProjectAccess(owner)`):

```
POST   /api/projects                      body adds  invites?: {email:string}[]
POST   /api/projects/:projectId/invites   { email }               -> { invite }
GET    /api/projects/:projectId/invites                            -> { invites: [...] }  (pending only)
DELETE /api/projects/:projectId/invites/:inviteId                  -> { ok:true }          (status=revoked)
GET    /api/projects/:projectId/members                            -> { members: [...] }
DELETE /api/projects/:projectId/members/:userId                    -> { ok:true }          (owner cannot remove self / last owner)
```

Public / auth-for-accept (no project membership required):

```
GET  /api/invites/:token          -> { invite: { projectName, inviterName, email, status, expired } }   (no auth)
POST /api/invites/:token/accept   -> { projectId }   (requireAuth; caller email must equal invite.email)
```

**Create-invite rules:** lower-case + validate email; if that email is already a
member → return `{ alreadyMember: true }` (200, no email); if a `pending` invite
exists → refresh `expiresAt`/`token` and resend rather than duplicate; else create
`pending` invite (`expiresAt = now + 7d`), then send email.

**Accept rules:** load by token. Reject if `status != pending`, or `expiresAt < now`
(set `status=expired`, return 410). Require the authed user's email (case-insensitive)
== `invite.email`; else 403 `{ error, invitedEmail }`. On success: upsert
`ProjectMember(projectId, userId, role)`, set invite `status=accepted`,
`acceptedById=userId`. Idempotent (re-accept by an existing member is a no-op 200).

### 4. Email service (`backend/src/services/email.ts`, Resend)

- Add `resend` to `backend/package.json`.
- `config/env.ts`: `email: { apiKey: optional('RESEND_API_KEY'), from:
  optional('RESEND_FROM', 'Bug Board <onboarding@resend.dev>') }` and
  `export const isEmailConfigured = Boolean(env.email.apiKey)`.
- `sendProjectInvite({ to, projectName, inviterName, acceptUrl })`:
  - `acceptUrl = \`${env.frontendUrls[0]}/invite/${token}\``.
  - If `!isEmailConfigured`: `console.info('[invite] email disabled — link:', acceptUrl)`
    and return (does not throw — the invite row is still created so the flow is
    testable before the key is set).
  - Else call Resend; on send failure, log and swallow (the invite still exists;
    surface a non-blocking "email may not have sent" note to the owner).
- Add `RESEND_API_KEY`, `RESEND_FROM` to `backend/.env.example`.

### 5. Realtime via polling

- Frontend: add `refetchInterval: 7000` + `refetchOnWindowFocus: true` to the
  shared queries — projects list (`ProjectsPage`), board issues (`BoardPage`),
  issue detail + comments + activity (`IssueDetailPage`).
- Backend: lower shared-read TTLs in `remember(...)` to ~3s for issues/board/
  activity/project detail so a warm instance doesn't hide another user's change
  for 10s. Keep write-path `invalidateCache` calls.

### 6. Frontend

- **`CreateProjectModal`**: add an optional "Invite teammates" email-chips input;
  include `invites` in the POST body. Board navigation unchanged.
- **`ProjectDetailsModal`**: new "Members & invites" section — list members with
  role, pending invites with a revoke (X) button, and an email input to invite.
  Owner-only controls; members see a read-only roster.
- **`InvitePage`** (new, route `/invite/:token` — reachable while logged out):
  fetch invite via `GET /api/invites/:token`.
  - invalid / expired / revoked → error card with a link to `/`.
  - not logged in → signup form, **email prefilled and read-only** = invite email,
    with a "Already have an account? Log in" toggle. On register/login success →
    `POST /accept` → redirect `/projects/:projectId`.
  - logged in as the invited email → auto-accept → redirect to the board.
  - logged in as a different email → "This invite is for {email}. Log out and sign
    in as {email} to accept." (email-locked; no silent cross-account accept).
- **`App.tsx`**: register `/invite/:token` in **both** the logged-out and logged-in
  route trees (invite links must work before auth).

### 7. Migration & backfill

- `npm run db:migrate` adds the two models + enums.
- Backfill (data migration step or `prisma/seed`-style script, run once):
  for each existing `Project` — create `ProjectMember` `owner` for `createdById`
  (fallback: the workspace's `owner` `WorkspaceMember` when `createdById` is null),
  and create `member` rows for every other `WorkspaceMember` of that project's
  workspace. Preserves today's "all workspace members see all projects" behavior.

### 8. Env vars (backend `.env` / `.env.example`)

`RESEND_API_KEY` (set later), `RESEND_FROM` (verified sender; defaults to Resend's
sandbox for dev). `FRONTEND_URL` already exists and is reused for the accept link.

---

## Acceptance Criteria

1. An owner creating a project with 2 invite emails: project is created, owner is a
   `ProjectMember(owner)`, 2 `pending` `ProjectInvite` rows exist, 2 emails are
   sent (or 2 invite links are logged when `RESEND_API_KEY` is unset).
2. Inviting an email that already has an account → invitee accepting is added as
   `member` and lands on the board; **no second account is created**.
3. Inviting a brand-new email → invitee signs up on `/invite/:token` (email locked),
   is added as `member`, and is redirected to `/projects/:projectId`.
4. An invite link accepted by a user whose email ≠ invite email is refused with a
   clear message; no membership is created.
5. An invite older than 7 days, a revoked invite, and an already-accepted invite
   each return a distinct non-accepting state (410/gone, revoked, already-member).
6. A non-member requesting `GET /api/projects/:id`, its issues, comments, or
   activity gets 404; a member gets 200; only an owner can PATCH/DELETE the project,
   invite, revoke, or remove members.
7. A project with only its creator as member shows as personal (no other members);
   inviting someone makes it shared. Invited users' own projects are unaffected and
   not visible to the inviter.
8. Two browsers on the same board: an issue created / moved / commented by user A
   appears for user B within ~10s without a manual reload.
9. Owner can revoke a pending invite (link stops working) and remove a member
   (they lose access on next request); an owner cannot remove the last owner.
10. Backfill: after migration, every pre-existing project is still visible to the
    same users who could see it before.
11. Type-checks + builds clean in both repos (`npm run build`). No secrets committed.

---

## Testing Plan

| Layer | What | Count |
|---|---|---|
| Unit | `requireProjectAccess` (owner/member/non-member × minRole); token gen; accept email-match + expiry logic | +6 |
| Integration | create-with-invites; invite→accept (new user); invite→accept (existing user); wrong-email refusal; expired/revoked/already-member; revoke; remove-member; non-member 404s; owner-only 403s; backfill correctness | +12 |
| E2E | Owner invites → new user signs up via link → lands on board → both users see each other's issue/comment within poll window | +2 |

---

## Rollback Plan

Feature is additive. Backend: revert the routes/middleware/service commits;
`ProjectMember`/`ProjectInvite` tables can remain (unused) or be dropped via a
down-migration. Frontend: revert; `/invite/:token` 404s harmlessly. The access
refactor is the only non-trivial revert — keep it in one commit separate from the
invite/email commits so it can be reverted independently. No destructive data ops.

---

## Effort Estimate

- Schema + migration + backfill: ~2h
- Access-control refactor across projects/issues/chat/uploads routes: ~4h
- Invite + member endpoints: ~3h
- Resend email service + env wiring: ~1.5h
- Frontend (CreateProjectModal, ProjectDetailsModal, InvitePage, App routes, auth): ~5h
- Polling + cache TTL tuning: ~1h
- Tests: ~4h

~20h total.

---

## Files Reference

| File | Change |
|---|---|
| `backend/prisma/schema.prisma` | Add `ProjectRole`, `InviteStatus`, `ProjectMember`, `ProjectInvite`; relations on `Project`/`User` |
| `backend/src/lib/access.ts` (new) | `requireProjectAccess(projectId, userId, minRole)` |
| `backend/src/config/env.ts:36` | Add `email` config + `isEmailConfigured` |
| `backend/src/services/email.ts` (new) | Resend `sendProjectInvite`, dev-log fallback |
| `backend/src/routes/projects.ts` | Owner membership on create; `invites[]`; swap workspace-scoping → access checks; per-user list cache; invite + member CRUD |
| `backend/src/routes/invites.ts` (new) | `GET /api/invites/:token`, `POST /api/invites/:token/accept` |
| `backend/src/routes/issues.ts`, `chat.ts`, `uploads.ts` | swap workspace-scoping → `requireProjectAccess`; shorten shared-read TTLs |
| `backend/src/index.ts` | mount `invitesRouter` |
| `backend/.env.example` | `RESEND_API_KEY`, `RESEND_FROM` |
| `backend/package.json` | add `resend` |
| `frontend/src/components/CreateProjectModal.tsx` | invite-emails input + `invites` in POST |
| `frontend/src/components/ProjectDetailsModal.tsx` | members & invites section |
| `frontend/src/pages/InvitePage.tsx` (new) | invite landing + signup/login + accept + redirect |
| `frontend/src/App.tsx` | `/invite/:token` in both route trees |
| `frontend/src/lib/auth.ts` / `api.ts` | accept-invite call; register/login returning to accept |
| `frontend/src/pages/{BoardPage,IssueDetailPage,ProjectsPage}.tsx` | `refetchInterval` for cross-user freshness |

---

## Out of Scope

- AI/agent context awareness of members (explicitly deferred by requester).
- Live presence indicators / typing / true push (SSE/WebSocket).
- Notifications beyond the invite email (in-app notif center, digest emails).
- Org/team management, per-workspace billing, roles beyond owner/member.
- Transferring project ownership UI (last-owner guard exists; transfer is later).

---

## Dependency Graph

```
schema + migration + backfill ─┬─> access-control refactor ─┬─> invite/member endpoints ──> frontend invite UI + InvitePage
                               │                            └─> polling + cache TTLs
                               └─> Resend email service ────────> (used by invite endpoints)
```

Sequencing rationale: the data model and access refactor are the foundation
everything else calls; email and endpoints can proceed in parallel once access
exists; frontend consumes the endpoints last.
