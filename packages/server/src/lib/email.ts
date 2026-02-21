interface ResendPayload {
  from: string;
  to: string;
  subject: string;
  html: string;
}

async function sendEmail(apiKey: string, payload: ResendPayload): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
}

export async function sendVerificationEmail(
  apiKey: string,
  to: string,
  code: string,
): Promise<void> {
  await sendEmail(apiKey, {
    from: 'Relaycast <noreply@relaycast.dev>',
    to,
    subject: 'Verify your Relaycast email',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Verify your email</h2>
        <p>Your verification code is:</p>
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 4px; padding: 16px; background: #f4f4f5; border-radius: 8px; text-align: center; margin: 16px 0;">
          ${code}
        </div>
        <p style="color: #71717a;">This code expires in 15 minutes.</p>
      </div>
    `,
  });
}

export async function sendExpirationWarning(
  apiKey: string,
  to: string,
  workspaceName: string,
  daysRemaining: number,
): Promise<void> {
  await sendEmail(apiKey, {
    from: 'Relaycast <noreply@relaycast.dev>',
    to,
    subject: `Your workspace "${workspaceName}" will expire in ${daysRemaining} days`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Workspace expiration warning</h2>
        <p>Your workspace <strong>${workspaceName}</strong> has been inactive and will be deleted in <strong>${daysRemaining} days</strong>.</p>
        <p>To prevent deletion, either:</p>
        <ul>
          <li>Send a message or perform any action in the workspace</li>
          <li><a href="https://relaycast.dev/dashboard/billing">Upgrade to a paid plan</a></li>
        </ul>
        <p style="color: #71717a;">Free workspaces are deleted after 60 days of inactivity.</p>
      </div>
    `,
  });
}
