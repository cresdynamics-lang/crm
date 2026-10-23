/**
 * Uploaded files (/uploads/...) are no longer public.
 *
 * <img> tags and download links cannot send the Bearer token, so signing in
 * also sets a separate httpOnly cookie ("cres_fs") scoped to /uploads only.
 * Scripts cannot read it, and it carries nothing but the user id.
 *
 *   avatars    any signed-in user
 *   documents  staff; a client only for documents shared with them on their own projects
 *   reports    staff only
 *   anything else: staff only
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../config/database');
const { findActiveUserById } = require('../services/authService');

const COOKIE = 'cres_fs';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Give this browser access to /uploads for the signed-in user. */
function setFileCookie(res, userId) {
  const token = jwt.sign({ sub: userId, aud: 'files' }, config.jwt.secret, { expiresIn: Math.floor(MAX_AGE_MS / 1000) });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/uploads',
    maxAge: MAX_AGE_MS,
  });
}

function clearFileCookie(res) {
  res.clearCookie(COOKIE, { path: '/uploads' });
}

async function fileAccess(req, res, next) {
  try {
    const token = readCookie(req, COOKIE);
    if (!token) return res.status(401).send('Sign in to view this file.');
    let payload;
    try {
      payload = jwt.verify(token, config.jwt.secret, { audience: 'files' });
    } catch {
      return res.status(401).send('Your session expired. Sign in again to view this file.');
    }
    const user = await findActiveUserById(payload.sub);
    if (!user || user.status !== 'active') return res.status(401).send('Sign in to view this file.');

    const rel = decodeURIComponent(req.path); // e.g. /documents/123-abc.pdf
    if (rel.includes('..')) return res.status(400).send('Bad path');
    const folder = rel.split('/')[1];
    const isClient = user.role_name === 'client';

    if (folder === 'avatars') return next();
    if (!isClient) return next(); // staff
    if (folder === 'documents') {
      const { rows } = await query(
        `SELECT 1 FROM project_documents d
         JOIN projects p ON p.id = d.project_id
         JOIN clients c ON c.id = p.client_id
         WHERE d.file_path = $1 AND d.shared_with_client = TRUE AND c.user_id = $2
         LIMIT 1`,
        [`/uploads${rel}`, user.id]
      );
      if (rows[0]) return next();
    }
    return res.status(403).send('You do not have access to this file.');
  } catch (err) {
    return next(err);
  }
}

module.exports = { fileAccess, setFileCookie, clearFileCookie };
