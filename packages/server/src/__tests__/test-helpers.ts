import crypto from 'node:crypto';

export function generateApiKey(): { key: string; hash: string } {
  const key = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return { key, hash };
}

export function generateAgentToken(): { token: string; hash: string } {
  const token = `at_live_${crypto.randomBytes(16).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
}
