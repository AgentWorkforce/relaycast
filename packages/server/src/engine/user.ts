import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { users, organizations, orgMemberships, emailVerifications, sessions } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { hashToken } from '../middleware/auth.js';

type Db = ReturnType<typeof getDb>;

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    key,
    256,
  );
  const hash = Buffer.from(derived);
  return `pbkdf2:${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    key,
    256,
  );
  const hash = Buffer.from(derived);
  const storedHash = Buffer.from(hashHex, 'hex');
  if (storedHash.length !== hash.length) return false;
  return crypto.timingSafeEqual(hash, storedHash);
}

function generateVerificationCode(): string {
  return String(crypto.randomInt(100000, 999999));
}

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function signup(
  db: Db,
  input: { name: string; email: string; password: string },
) {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email));
  if (existing) {
    const err = new Error('An account with this email already exists');
    Object.assign(err, { code: 'email_already_exists', status: 409 });
    throw err;
  }

  const userId = generateId();
  const passwordHash = await hashPassword(input.password);

  const [user] = await db
    .insert(users)
    .values({
      id: userId,
      email: input.email,
      name: input.name,
      passwordHash,
    })
    .returning();

  // Create verification code
  const code = generateVerificationCode();
  const verificationId = generateId();
  await db.insert(emailVerifications).values({
    id: verificationId,
    email: input.email,
    code,
    userId,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });

  return {
    user_id: userId,
    verification_code: code,
    email: input.email,
    created_at: user.createdAt.toISOString(),
  };
}

export async function verifyEmail(
  db: Db,
  input: { user_id: string; code: string },
) {
  const [verification] = await db
    .select()
    .from(emailVerifications)
    .where(eq(emailVerifications.userId, input.user_id));

  if (!verification) {
    const err = new Error('No pending verification found');
    Object.assign(err, { code: 'verification_not_found', status: 404 });
    throw err;
  }

  if (verification.expiresAt < new Date()) {
    const err = new Error('Verification code has expired');
    Object.assign(err, { code: 'verification_expired', status: 410 });
    throw err;
  }

  if (verification.code !== input.code) {
    const err = new Error('Invalid verification code');
    Object.assign(err, { code: 'invalid_code', status: 400 });
    throw err;
  }

  await db
    .update(users)
    .set({ emailVerified: true })
    .where(eq(users.id, input.user_id));

  await db
    .delete(emailVerifications)
    .where(eq(emailVerifications.userId, input.user_id));

  return { verified: true };
}

export async function login(
  db: Db,
  input: { email: string; password: string },
) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email));

  if (!user) {
    const err = new Error('Invalid email or password');
    Object.assign(err, { code: 'invalid_credentials', status: 401 });
    throw err;
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    const err = new Error('Invalid email or password');
    Object.assign(err, { code: 'invalid_credentials', status: 401 });
    throw err;
  }

  // Get user's orgs
  const memberships = await db
    .select()
    .from(orgMemberships)
    .where(eq(orgMemberships.userId, user.id));

  let activeOrgId: string | null = null;
  const orgs: { id: string; name: string; role: string }[] = [];

  for (const m of memberships) {
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, m.organizationId));
    if (org) {
      orgs.push({ id: org.id, name: org.name, role: m.role });
      if (!activeOrgId) activeOrgId = org.id;
    }
  }

  // Create session
  const sessionId = generateSessionToken();
  await db.insert(sessions).values({
    id: sessionId,
    userId: user.id,
    activeOrgId,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  return {
    user_id: user.id,
    session_token: sessionId,
    organizations: orgs,
  };
}

export async function getSessionUser(db: Db, sessionId: string) {
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId));

  if (!session || session.expiresAt < new Date()) {
    return null;
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId));

  if (!user) return null;

  let activeOrg = null;
  if (session.activeOrgId) {
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, session.activeOrgId));
    activeOrg = org || null;
  }

  return { user, activeOrg, sessionId: session.id };
}

export async function switchOrg(db: Db, sessionId: string, userId: string, orgId: string) {
  // Verify user is a member of this org
  const [membership] = await db
    .select()
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.userId, userId),
        eq(orgMemberships.organizationId, orgId),
      ),
    );

  if (!membership) {
    const err = new Error('You are not a member of this organization');
    Object.assign(err, { code: 'not_a_member', status: 403 });
    throw err;
  }

  await db
    .update(sessions)
    .set({ activeOrgId: orgId })
    .where(eq(sessions.id, sessionId));

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId));

  return org;
}

export async function deleteSession(db: Db, sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function getUser(db: Db, userId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    email_verified: user.emailVerified,
    name: user.name,
    created_at: user.createdAt.toISOString(),
  };
}

export async function getUserOrgs(db: Db, userId: string) {
  const memberships = await db
    .select()
    .from(orgMemberships)
    .where(eq(orgMemberships.userId, userId));

  const result: { id: string; name: string; plan: string; role: string }[] = [];
  for (const m of memberships) {
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, m.organizationId));
    if (org) {
      result.push({ id: org.id, name: org.name, plan: org.plan, role: m.role });
    }
  }
  return result;
}
