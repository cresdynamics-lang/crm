/**
 * Click-to-reveal sign-in password.
 *
 * The welcome email contains a private link, not the password. Opening the link shows a button;
 * clicking it shows the password once (it stays visible for 15 minutes so a refresh does not lose it),
 * then it is erased. If the person changes their password first, the link stops working and they use
 * "Forgot password".
 */
const crypto = require('crypto');
const config = require('../config');
const { query } = require('../config/database');
const { AppError } = require('../lib/errors');

const LINK_DAYS = 7;
const VISIBLE_AFTER_REVEAL_MS = 15 * 60 * 1000;

const key = () => crypto.createHash('sha256').update(`cred-reveal:${config.jwt.secret}`).digest(); // 32 bytes
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

/** "ggxxxxxx64@gmail.com" -> "gg.....64@gmail.com": enough to jog memory, not enough to guess the address. */
function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  const head = local.slice(0, local.length >= 6 ? 2 : 1);
  const tail = local.length >= 6 ? local.slice(-2) : '';
  return `${head}.....${tail}@${domain}`;
}

function publicRoot() {
  return (process.env.PUBLIC_WEB_URL || process.env.APP_URL || 'https://cresos.cresdynamics.com').replace(/\/$/, '');
}

/** Store the password (encrypted) and return the private link for the email. */
async function createReveal({ userId, password }) {
  const { rows: u } = await query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  if (!u[0]) throw new AppError('User not found', 404, 'NOT_FOUND');
  const token = crypto.randomBytes(32).toString('hex');
  await query(`UPDATE credential_reveals SET secret_enc = NULL, wiped_at = NOW() WHERE user_id = $1 AND wiped_at IS NULL`, [userId]);
  await query(
    `INSERT INTO credential_reveals (user_id, token_hash, secret_enc, pw_fingerprint, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval)`,
    [userId, sha(token), encrypt(password), sha(u[0].password_hash), String(LINK_DAYS)]
  );
  return { token, url: `${publicRoot()}/welcome/${token}` };
}

async function load(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) throw new AppError('This link is not valid', 404, 'NOT_FOUND');
  const { rows } = await query(
    `SELECT r.*, u.name, u.email, u.password_hash, u.status
       FROM credential_reveals r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = $1`,
    [sha(token)]
  );
  const r = rows[0];
  if (!r) throw new AppError('This link is not valid', 404, 'NOT_FOUND');
  const now = Date.now();
  const gone =
    r.wiped_at ||
    !r.secret_enc ||
    new Date(r.expires_at).getTime() < now ||
    (r.revealed_at && now - new Date(r.revealed_at).getTime() > VISIBLE_AFTER_REVEAL_MS) ||
    r.status !== 'active' ||
    sha(r.password_hash) !== r.pw_fingerprint;
  if (gone) {
    if (!r.wiped_at) await query(`UPDATE credential_reveals SET secret_enc = NULL, wiped_at = NOW() WHERE id = $1`, [r.id]);
    return { r, usable: false };
  }
  return { r, usable: true };
}

/** What the page may show before the click: a first name and a hint, never the password. */
async function status(token) {
  const { r, usable } = await load(token);
  if (!usable) return { valid: false };
  return { valid: true, firstName: String(r.name || '').trim().split(/\s+/)[0] || 'there', emailHint: maskEmail(r.email) };
}

/** The click: show the password. Visible for 15 minutes from the first click, then erased. */
async function reveal(token) {
  const { r, usable } = await load(token);
  if (!usable) throw new AppError('This link has expired or was already used. Use "Forgot password" on the sign-in page.', 410, 'GONE');
  const password = decrypt(r.secret_enc);
  if (!r.revealed_at) await query(`UPDATE credential_reveals SET revealed_at = NOW() WHERE id = $1`, [r.id]);
  const left = r.revealed_at ? Math.max(0, VISIBLE_AFTER_REVEAL_MS - (Date.now() - new Date(r.revealed_at).getTime())) : VISIBLE_AFTER_REVEAL_MS;
  return { password, emailHint: maskEmail(r.email), secondsLeft: Math.round(left / 1000) };
}

/** Erase anything past its time (called from the ops scheduler). */
async function wipeExpired() {
  const { rowCount } = await query(
    `UPDATE credential_reveals SET secret_enc = NULL, wiped_at = NOW()
      WHERE wiped_at IS NULL AND (expires_at < NOW() OR revealed_at < NOW() - INTERVAL '15 minutes')`
  );
  return { wiped: rowCount };
}

module.exports = { createReveal, status, reveal, wipeExpired, maskEmail, LINK_DAYS };
