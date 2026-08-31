import nodemailer from 'nodemailer';
import type Transporter from 'nodemailer/lib/mailer/index.js';
import { getClientUrl } from './clientUrl.js';

let transporter: Transporter | null = null;

function emailConfigured(): boolean {
  return Boolean(process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

function getTransporter(): Transporter {
  if (!transporter) {
    const pass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');

    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT) || 587,
      secure: Number(process.env.EMAIL_PORT) === 465,
      auth: {
        user: process.env.EMAIL_USER,
        pass,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  return transporter;
}

export async function verifyMailTransport(): Promise<void> {
  if (!emailConfigured()) {
    console.warn('[mail] EMAIL_HOST, EMAIL_USER, or EMAIL_PASS is missing — verification emails will not send.');
    return;
  }

  try {
    await getTransporter().verify();
    console.log('[mail] SMTP connection verified');
  } catch (error) {
    console.error('[mail] SMTP verification failed:', error);
  }
}

function logDevLink(kind: string, link: string, email: string) {
  if (process.env.NODE_ENV === 'production' && process.env.LOG_EMAIL_LINKS !== 'true') return;
  console.log(`[mail] ${kind} link for ${email}: ${link}`);
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

  const info = await getTransporter().sendMail({
    from: `"CanvasRTC" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
    text,
  });

  console.log(`[mail] ${kind} sent to ${to} (messageId: ${info.messageId || 'n/a'})`);
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
