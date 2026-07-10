import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { Resource } from "sst";

const ses = new SESv2Client({});

export async function sendInviteEmail(input: {
  to: string;
  organizationName: string;
  inviterName: string | null;
  inviteToken: string;
  baseUrl: string;
}) {
  const acceptUrl = `${input.baseUrl}/invite/${input.inviteToken}`;
  const inviterLabel = input.inviterName ?? "Someone";

  const subject = `You've been invited to join ${input.organizationName} on Agent Relay`;
  const textBody = [
    `${inviterLabel} invited you to join "${input.organizationName}" on Agent Relay.`,
    "",
    `Accept the invitation: ${acceptUrl}`,
    "",
    "This invite expires in 7 days.",
  ].join("\n");

  const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#09090b;color:#e4e4e7;padding:40px 20px;">
  <div style="max-width:480px;margin:0 auto;">
    <h2 style="color:#f4f4f5;margin-bottom:8px;">You're invited</h2>
    <p style="color:#a1a1aa;margin-bottom:24px;">
      ${escapeHtml(inviterLabel)} invited you to join
      <strong style="color:#f4f4f5;">${escapeHtml(input.organizationName)}</strong>
      on Agent Relay.
    </p>
    <a href="${escapeHtml(acceptUrl)}"
       style="display:inline-block;background:#00d9ff;color:#0a0a0f;font-weight:600;
              padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;">
      Accept invitation
    </a>
    <p style="color:#71717a;font-size:13px;margin-top:24px;">
      This invite expires in 7 days. If you didn't expect this email, you can ignore it.
    </p>
  </div>
</body>
</html>`.trim();

  // Resource is only linked in production (SES not provisioned in dev stages)
  const emailResource = (Resource as unknown as Record<string, { sender: string } | undefined>)
    .AgentRelayEmail;

  if (!emailResource) {
    console.log(`[invite] Email not configured — skipping send to ${input.to}`);
    console.log(`[invite] Accept URL: ${acceptUrl}`);
    return;
  }

  const sender = emailResource.sender;

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: `Agent Relay <noreply@${sender}>`,
      Destination: { ToAddresses: [input.to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: textBody, Charset: "UTF-8" },
            Html: { Data: htmlBody, Charset: "UTF-8" },
          },
        },
      },
    }),
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
