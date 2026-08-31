import { getClientUrl } from './clientUrl.js';

// Brevo's transactional endpoint is used instead of SMTP because most free
// hosting tiers (Render included) block outbound ports 25/465/587.
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const BREVO_ACCOUNT_ENDPOINT = 'https://api.brevo.com/v3/account';
const REQUEST_TIMEOUT_MS = 15_000;

function emailConfigured(): boolean {
  return Boolean(process.env.BREVO_API_KEY && process.env.EMAIL_FROM);
}

function getSender(): { name: string; email: string } {
  return {
    name: process.env.EMAIL_FROM_NAME || 'CanvasRTC',
    email: process.env.EMAIL_FROM as string,
  };
}

export async function verifyMailTransport(): Promise<void> {
  if (!emailConfigured()) {
    console.warn('[mail] BREVO_API_KEY or EMAIL_FROM is missing — verification emails will not send.');
    return;
  }

  try {
    const res = await fetch(BREVO_ACCOUNT_ENDPOINT, {
      headers: {
        accept: 'application/json',
        'api-key': process.env.BREVO_API_KEY as string,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`[mail] Brevo credentials rejected (HTTP ${res.status}): ${await res.text()}`);
      return;
    }

    const account = (await res.json()) as { email?: string };
    console.log(`[mail] Brevo API ready (account: ${account.email || 'unknown'}, sender: ${getSender().email})`);
  } catch (error) {
    console.error('[mail] Brevo verification failed:', error);
  }
}

function logDevLink(kind: string, link: string, email: string) {
  if (process.env.NODE_ENV === 'production' && process.env.LOG_EMAIL_LINKS !== 'true') return;
  console.log(`[mail] ${kind} link for ${email}: ${link}`);
}

function logProdLinkOnFailure(kind: string, link: string, email: string) {
  if (process.env.NODE_ENV !== 'production') return;
  console.warn(`[mail] ${kind} delivery failed — manual link for ${email}: ${link}`);
}

async function sendMail(options: {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind: string;
  link: string;
}) {
  const { to, subject, html, text, kind, link } = options;

  if (!emailConfigured()) {
    console.warn(`[mail] Email not configured. ${kind} link for ${to}: ${link}`);
    return;
  }

  logDevLink(kind, link, to);

  try {
    const res = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': process.env.BREVO_API_KEY as string,
      },
      body: JSON.stringify({
        sender: getSender(),
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Brevo responded ${res.status}: ${await res.text()}`);
    }

    const info = (await res.json()) as { messageId?: string };
    console.log(`[mail] ${kind} sent to ${to} (messageId: ${info.messageId || 'n/a'})`);
  } catch (error) {
    logProdLinkOnFailure(kind, link, to);
    throw error;
  }
}

export async function sendVerificationEmail(email: string, token: string) {
  const verifyLink = `${getClientUrl()}/verify-email?token=${token}`;

  await sendMail({
    to: email,
    subject: 'Verify your CanvasRTC Account',
    kind: 'Verification',
    link: verifyLink,
    text: `Welcome to CanvasRTC!\n\nVerify your email: ${verifyLink}\n\nThis link expires in 24 hours.`,
    html: `
      <div style="font-family: sans-serif; max-width: 500px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #7c3aed;">Welcome to CanvasRTC!</h2>
        <p style="color: #475569;">Please verify your email address to activate your account and start collaborating.</p>
        <a href="${verifyLink}" style="display:inline-block; padding: 10px 20px; background-color: #7c3aed; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 16px 0;">Verify Email Address</a>
        <p style="color: #94a3b8; font-size: 12px;">Or copy this link: ${verifyLink}</p>
        <p style="color: #94a3b8; font-size: 12px;">This link will expire in 24 hours.</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(email: string, token: string) {
  const resetLink = `${getClientUrl()}/reset-password?token=${token}`;

  await sendMail({
    to: email,
    subject: 'Reset your CanvasRTC Password',
    kind: 'Password reset',
    link: resetLink,
    text: `Reset your CanvasRTC password: ${resetLink}\n\nThis link expires in 1 hour.`,
    html: `
      <div style="font-family: sans-serif; max-width: 500px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #7c3aed;">Reset Your Password</h2>
        <p style="color: #475569;">You requested a password reset. Click the link below to set a new password:</p>
        <a href="${resetLink}" style="display:inline-block; padding: 10px 20px; background-color: #7c3aed; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 16px 0;">Reset Password</a>
        <p style="color: #94a3b8; font-size: 12px;">Or copy this link: ${resetLink}</p>
        <p style="color: #94a3b8; font-size: 12px;">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });
}
