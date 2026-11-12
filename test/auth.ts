import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import 'dotenv/config';

export type TestIdentity = { sub: string; email: string };

export type SignOverrides = {
  issuer?: string;
  audience?: string;
  exp?: string | number;
  email?: string;
  omitEmail?: boolean;
};

const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for tests`);
  return value;
};

export const newIdentity = (label = 'user'): TestIdentity => {
  const sub = randomUUID();
  return { sub, email: `${label}-${sub}@test.cz` };
};

export async function createTestAuth() {
  const issuer = requireEnv('KEYCLOAK_ISSUER');
  const audience = requireEnv('KEYCLOAK_AUDIENCE');

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig',
  };

  const jwks = createLocalJWKSet({ keys: [jwk] });

  const signToken = (
    identity: TestIdentity,
    overrides: SignOverrides = {},
  ): Promise<string> => {
    const email = overrides.email ?? identity.email;

    return new SignJWT(overrides.omitEmail ? {} : { email })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(identity.sub)
      .setIssuer(overrides.issuer ?? issuer)
      .setAudience(overrides.audience ?? audience)
      .setIssuedAt()
      .setExpirationTime(overrides.exp ?? '5m')
      .sign(privateKey);
  };

  const authHeader = async (
    identity: TestIdentity,
    overrides?: SignOverrides,
  ) => ({ authorization: `Bearer ${await signToken(identity, overrides)}` });

  return { jwks, signToken, authHeader };
}
