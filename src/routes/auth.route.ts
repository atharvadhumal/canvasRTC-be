import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { prisma } from '../db.js';
import { getClientUrl } from '../lib/clientUrl.js';
import { signAccessToken } from '../lib/jwt.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

const ALLOWED_AVATAR_PREFIXES = [
  'https://api.dicebear.com/9.x/avataaars/',
  'https://api.dicebear.com/8.x/avataaars/',
  'https://avataaars.io/',
];

function avataaarsUrl(seed: string): string {
  const params = new URLSearchParams({
    seed,
    size: '128',
    backgroundColor: 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf',
  });
  return `https://api.dicebear.com/9.x/avataaars/png?${params.toString()}`;
}

function publicUser(user: {
  id: string;
  name: string;
  email: string;
  tier: string;
  avatarUrl?: string | null;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    tier: user.tier,
    avatarUrl: user.avatarUrl || avataaarsUrl(user.email),
  };
}

function isAllowedAvatarUrl(url: string): boolean {
  return ALLOWED_AVATAR_PREFIXES.some((prefix) => url.startsWith(prefix));
}

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
});

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendVerificationEmail(email: string, token: string) {
  const clientUrl = getClientUrl();
  const verifyLink = `${clientUrl}/verify-email?token=${token}`;

  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('Email is not configured. Verification link:', verifyLink);
    return;
  }

  await transporter.sendMail({
    from: `"CanvasRTC" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Verify your CanvasRTC Account',
    html: `
      <div style="font-family: sans-serif; max-width: 500px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #4f46e5;">Welcome to CanvasRTC!</h2>
        <p style="color: #475569;">Please verify your email address to activate your account and start collaborating.</p>
        <a href="${verifyLink}" style="display:inline-block; padding: 10px 20px; background-color: #4f46e5; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 16px 0;">Verify Email Address</a>
        <p style="color: #94a3b8; font-size: 12px;">This link will expire in 24 hours.</p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail(email: string, token: string) {
  const resetLink = `${getClientUrl()}/reset-password?token=${token}`;

  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('Email is not configured. Password reset link:', resetLink);
    return;
  }

  await transporter.sendMail({
    from: `"CanvasRTC" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Reset your CanvasRTC Password',
    html: `
      <div style="font-family: sans-serif; max-width: 500px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #7c3aed;">Reset Your Password</h2>
        <p style="color: #475569;">You requested a password reset. Click the link below to set a new password:</p>
        <a href="${resetLink}" style="display:inline-block; padding: 10px 20px; background-color: #7c3aed; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 16px 0;">Reset Password</a>
        <p style="color: #94a3b8; font-size: 12px;">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });
}

// 1. REGISTER
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!name || !email || !password) {
      res.status(400).json({ error: 'All fields are required' });
      return;
    }

    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'Enter a valid email address' });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      res.status(400).json({ error: 'Email is already registered' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        isVerified: false,
        avatarUrl: avataaarsUrl(email),
      },
    });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.verificationToken.create({
      data: { token, userId: user.id, expiresAt },
    });

    const setupToken = crypto.randomBytes(32).toString('hex');
    await prisma.verificationToken.create({
      data: {
        token: setupToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    res.status(201).json({
      message: 'Registration successful. Please verify your email.',
      setupToken,
    });

    void sendVerificationEmail(email, token).catch((err: unknown) => {
      console.error('Failed to send verification email:', err);
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error during registration' });
  }
});

router.post('/setup-avatar', async (req: Request, res: Response): Promise<void> => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const avatarUrl = typeof req.body?.avatarUrl === 'string' ? req.body.avatarUrl.trim() : '';

    if (!token || !avatarUrl) {
      res.status(400).json({ error: 'Avatar and setup token are required' });
      return;
    }

    if (!isAllowedAvatarUrl(avatarUrl) || avatarUrl.length > 500) {
      res.status(400).json({ error: 'Choose a valid Avataaars avatar' });
      return;
    }

    const tokenRecord = await prisma.verificationToken.findUnique({
      where: { token },
    });

    if (!tokenRecord || tokenRecord.expiresAt < new Date()) {
      res.status(400).json({ error: 'Avatar setup expired. You can change it later in Settings.' });
      return;
    }

    await prisma.user.update({
      where: { id: tokenRecord.userId },
      data: { avatarUrl },
    });

    await prisma.verificationToken.delete({
      where: { id: tokenRecord.id },
    });

    res.json({ message: 'Avatar saved' });
  } catch (error) {
    console.error('Setup avatar error:', error);
    res.status(500).json({ error: 'Failed to save avatar' });
  }
});

// 2. VERIFY EMAIL
router.post('/verify-email', async (req: Request, res: Response): Promise<void> => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) {
      res.status(400).json({ error: 'Verification token is required' });
      return;
    }

    const tokenRecord = await prisma.verificationToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!tokenRecord || tokenRecord.expiresAt < new Date()) {
      res.status(400).json({ error: 'Invalid or expired verification link' });
      return;
    }

    if (tokenRecord.user.isVerified) {
      await prisma.verificationToken.delete({ where: { id: tokenRecord.id } });
      res.json({ message: 'Email already verified!' });
      return;
    }

    await prisma.user.update({
      where: { id: tokenRecord.userId },
      data: { isVerified: true },
    });

    await prisma.verificationToken.delete({
      where: { id: tokenRecord.id },
    });

    res.json({ message: 'Email successfully verified!' });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

router.post('/resend-verification', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : '';
    if (!email || !isValidEmail(email)) {
      res.status(400).json({ error: 'A valid email address is required' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || user.isVerified) {
      res.json({ message: 'If your account needs verification, a new link has been sent.' });
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.verificationToken.create({
      data: { token, userId: user.id, expiresAt },
    });

    res.json({ message: 'If your account needs verification, a new link has been sent.' });

    void sendVerificationEmail(email, token).catch((err: unknown) => {
      console.error('Failed to resend verification email:', err);
    });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// 3. LOGIN
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      res.status(400).json({ error: 'Invalid email or password' });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      res.status(400).json({ error: 'Invalid email or password' });
      return;
    }

    if (!user.isVerified) {
      res.status(403).json({ error: 'Please verify your email before logging in.' });
      return;
    }

    if (!user.avatarUrl) {
      const avatarUrl = avataaarsUrl(user.email);
      await prisma.user.update({
        where: { id: user.id },
        data: { avatarUrl },
      });
      user.avatarUrl = avatarUrl;
    }

    const token = signAccessToken({
      userId: user.id,
      email: user.email,
    });

    res.json({
      token,
      user: publicUser(user),
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

router.get('/me', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user?.userId },
      select: {
        id: true,
        name: true,
        email: true,
        tier: true,
        avatarUrl: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error('Fetch profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

router.patch('/me', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const avatarUrl = typeof req.body?.avatarUrl === 'string' ? req.body.avatarUrl.trim() : '';

    if (!name || name.length > 60) {
      res.status(400).json({ error: 'Name must be between 1 and 60 characters' });
      return;
    }

    if (!avatarUrl || avatarUrl.length > 500 || !isAllowedAvatarUrl(avatarUrl)) {
      res.status(400).json({ error: 'Choose a valid Avataaars avatar' });
      return;
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { name, avatarUrl },
      select: {
        id: true,
        name: true,
        email: true,
        tier: true,
        avatarUrl: true,
      },
    });

    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// 5. FORGOT PASSWORD (Request Reset Link)
router.post('/forgot-password', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : '';
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    
    // Always return success even if user not found to avoid user enumeration
    if (!user) {
      res.json({ message: 'If an account exists, a reset link has been sent.' });
      return;
    }

    // Generate 1-hour reset token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // Save token linked to user
    await prisma.verificationToken.create({
      data: {
        token,
        userId: user.id,
        expiresAt,
      },
    });

    res.json({ message: 'If an account exists, a reset link has been sent.' });

    void sendPasswordResetEmail(email, token).catch((err: unknown) => {
      console.error('Failed to send password reset email:', err);
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// 6. RESET PASSWORD (Submit New Password)
router.post('/reset-password', async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      res.status(400).json({ error: 'Token and new password are required' });
      return;
    }

    const tokenRecord = await prisma.verificationToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!tokenRecord || tokenRecord.expiresAt < new Date()) {
      res.status(400).json({ error: 'Invalid or expired reset link' });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Update password and clear token
    await prisma.user.update({
      where: { id: tokenRecord.userId },
      data: { passwordHash },
    });

    await prisma.verificationToken.delete({
      where: { id: tokenRecord.id },
    });

    res.json({ message: 'Password has been reset successfully! You can now log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

export default router;