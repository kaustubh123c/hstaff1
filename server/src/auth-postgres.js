
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { query } from './db-postgres.js';
import { HttpError, forbidden } from './util-postgres.js';

export const signToken = user =>
  jwt.sign(
    { sub: user.id, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

export async function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : null;

  if (!token) {
    return next(new HttpError(401, 'Authentication required'));
  }

  let payload;

  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(
      new HttpError(401, 'Session expired or invalid. Please sign in again.')
    );
  }

  try {
    // Re-check the account on every authenticated request.
    const result = await query(
      `SELECT id, email, role, name, phone, status
       FROM users
       WHERE id = $1`,
      [payload.sub]
    );

    const user = result.rows[0];

    if (!user) {
      return next(new HttpError(401, 'Account no longer exists'));
    }

    if (user.status !== 'Active') {
      return next(new HttpError(403, 'This account is suspended'));
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role)
    ? next()
    : next(forbidden(`Requires role: ${roles.join(' or ')}`));
