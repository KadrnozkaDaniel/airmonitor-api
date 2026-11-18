import { createHash, randomBytes } from 'node:crypto';

export const API_PREFIX_KEY = 'amk_';

export const hashApiKey = (key: string) =>
  createHash('sha256').update(key).digest('hex');

export const generateApiKey = (): { key: string; hash: string } => {
  const key = API_PREFIX_KEY + randomBytes(32).toString('base64url');

  return { key, hash: hashApiKey(key) };
};
