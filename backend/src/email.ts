// Invitation emails sent through Amazon SES (eu-west-1) from the verified deeptrack.io identity.
// A failed send never blocks the invitation itself; the caller reports it so the admin can
// send the link manually.
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const client = new SESv2Client({ region: process.env.AWS_REGION || "eu-west-1" });
const from = () => process.env.INVITE_FROM?.trim() || "Deeptrack Data Room <investors@deeptrack.io>";
const roomUrl = () => (process.env.DATA_ROOM_ORIGIN || "https://investors.deeptrack.io").replace(/\/$/, "");

const TIER: Record<number, string> = { 1: "General — first-look materials", 2: "Diligence — diligence materials" };
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export type Invitation = { to: string; firmName?: string; clearanceTier: number; expiresAt: string; inviterName?: string; inviterEmail?: string };

export function invitationContent(invite: Invitation) {
  const url = roomUrl();
  const who = invite.inviterName || "The Deeptrack team";
  const until = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Nairobi" }).format(new Date(invite.expiresAt));
  const tier = TIER[invite.clearanceTier] ?? "General";
  const subject = "You're invited to the Deeptrack data room";
  const text = [
    "Hello,",
    "",
    `${who} at Deeptrack has invited you${invite.firmName ? ` (${invite.firmName})` : ""} to review materials in the Deeptrack investor data room.`,
    "",
    "How to get in:",
    `1. Go to ${url}`,
    `2. Choose Sign in, then Continue with Google, using this email address: ${invite.to}`,
    "3. Accept the confidentiality acknowledgement.",
    "",
    `Your access: ${tier}, until ${until}.`,
    "",
    "Questions? Just reply to this email.",
    "",
    "Deeptrack Investor Relations",
    "",
    "This invitation is for the person it was sent to. The data room's contents are confidential.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#F4F6F8;font-family:Arial,Helvetica,sans-serif;color:#1F1F1F">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F8;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-top:4px solid #0191DA">
<tr><td style="padding:28px 32px 8px"><div style="font-size:26px;font-weight:bold;letter-spacing:-0.5px">deeptrack</div><div style="font-size:11px;color:#0191DA;letter-spacing:2px;text-transform:uppercase;margin-top:4px">Investor data room</div></td></tr>
<tr><td style="padding:16px 32px 0;font-size:15px;line-height:1.6">
<p style="margin:0 0 14px">Hello,</p>
<p style="margin:0 0 14px">${escape(who)} at Deeptrack has invited you${invite.firmName ? ` (${escape(invite.firmName)})` : ""} to review materials in the Deeptrack investor data room.</p>
<p style="margin:0 0 6px;font-weight:bold">How to get in</p>
<ol style="margin:0 0 18px;padding-left:20px"><li>Open the data room using the button below.</li><li>Choose <b>Sign in</b>, then <b>Continue with Google</b>, using this email address: <b>${escape(invite.to)}</b></li><li>Accept the confidentiality acknowledgement.</li></ol>
<p style="margin:0 0 22px"><a href="${url}" style="display:inline-block;background:#0191DA;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:3px">Open the data room</a></p>
<p style="margin:0 0 14px;padding:12px 14px;background:#E6F4FB;font-size:14px">Your access: <b>${escape(tier)}</b>, until <b>${escape(until)}</b>.</p>
<p style="margin:0 0 14px">Questions? Just reply to this email.</p>
<p style="margin:0 0 24px">Deeptrack Investor Relations</p>
</td></tr>
<tr><td style="padding:14px 32px 24px;font-size:12px;color:#808080;border-top:1px solid #E6F4FB">This invitation is for the person it was sent to. The data room's contents are confidential. If you weren't expecting it, you can ignore this email.<br>${escape(url)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

export async function sendInvitationEmail(invite: Invitation): Promise<{ sent: boolean; error?: string }> {
  const { subject, text, html } = invitationContent(invite);
  try {
    await client.send(new SendEmailCommand({
      FromEmailAddress: from(),
      Destination: { ToAddresses: [invite.to] },
      ReplyToAddresses: invite.inviterEmail ? [invite.inviterEmail] : undefined,
      Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } } } },
    }));
    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error("invitation-email-failed", message);
    // SES sandbox: only verified recipients can receive mail until production access is granted.
    const reason = /not verified|sandbox/i.test(message) ? "Email sending is still in the SES sandbox; send the link yourself for now." : "The invitation email could not be sent; send the link yourself.";
    return { sent: false, error: reason };
  }
}
