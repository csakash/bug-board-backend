import { Resend } from 'resend';
import { env, isEmailConfigured } from '../config/env.js';

const resend = isEmailConfigured ? new Resend(env.email.apiKey) : null;

interface ProjectInviteEmail {
  to: string;
  projectName: string;
  inviterName: string;
  acceptUrl: string;
}

function inviteHtml({ projectName, inviterName, acceptUrl }: Omit<ProjectInviteEmail, 'to'>): string {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
    <h2 style="margin:0 0 8px;font-size:20px">You're invited to <strong>${escapeHtml(projectName)}</strong></h2>
    <p style="margin:0 0 20px;font-size:14px;line-height:22px;color:#555">
      ${escapeHtml(inviterName)} invited you to collaborate on the <strong>${escapeHtml(projectName)}</strong>
      board on Bug Board. Accept to start tracking and commenting on issues together.
    </p>
    <a href="${acceptUrl}" style="display:inline-block;background:#c0552d;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:8px">
      Accept invitation
    </a>
    <p style="margin:20px 0 0;font-size:12px;color:#999">
      Or paste this link into your browser:<br />
      <a href="${acceptUrl}" style="color:#c0552d">${acceptUrl}</a>
    </p>
    <p style="margin:16px 0 0;font-size:12px;color:#999">This invite expires in 7 days.</p>
  </div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Send a project-invite email. Never throws: when Resend is not configured the
 * link is logged to the server console (so the flow is testable before a key is
 * set); when a real send fails, the error is logged and swallowed (the invite
 * row already exists — the owner can copy the link from Project details).
 *
 * Returns whether an email was actually dispatched.
 */
export async function sendProjectInvite(input: ProjectInviteEmail): Promise<boolean> {
  if (!resend) {
    console.info(`[invite] email disabled — link for ${input.to}: ${input.acceptUrl}`);
    return false;
  }
  try {
    // The Resend SDK resolves with { data, error } for API-level failures
    // (e.g. unverified sending domain) rather than throwing — inspect `error`.
    const { error } = await resend.emails.send({
      from: env.email.from,
      to: input.to,
      subject: `${input.inviterName} invited you to ${input.projectName} on Bug Board`,
      html: inviteHtml(input),
    });
    if (error) {
      console.error('[invite] email send rejected:', error);
      console.info(`[invite] fallback link for ${input.to}: ${input.acceptUrl}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[invite] email send failed:', err);
    console.info(`[invite] fallback link for ${input.to}: ${input.acceptUrl}`);
    return false;
  }
}
