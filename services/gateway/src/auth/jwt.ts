import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { unauthorized } from '../errors.js';

export interface TokenPayload {
  /** User id. */
  sub: string;
  email: string;
}

export function signAccessToken(user: { id: string; email: string }): string {
  return jwt.sign({ email: user.email }, config.jwtSecret, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

/** Verify and decode, or throw a 401. */
export function verifyAccessToken(token: string): TokenPayload {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw unauthorized('INVALID_TOKEN', 'Missing or invalid authentication token');
  }

  if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
    throw unauthorized('INVALID_TOKEN', 'Missing or invalid authentication token');
  }

  return { sub: decoded.sub, email: typeof decoded.email === 'string' ? decoded.email : '' };
}
