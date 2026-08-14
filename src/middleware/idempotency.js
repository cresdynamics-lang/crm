const { query } = require('../config/database');
const { AppError } = require('../lib/errors');

/**
 * Idempotency middleware for write operations.
 * Client sends Idempotency-Key header; retries return the cached response
 * instead of double-creating invoices/payments/etc.
 */
async function idempotency(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key) return next();

  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  try {
    const { rows } = await query(
      `SELECT status_code, response FROM idempotency_keys
       WHERE key = $1 AND expires_at > NOW()`,
      [key]
    );

    if (rows[0]?.response) {
      return res.status(rows[0].status_code || 200).json(rows[0].response);
    }

    // Reserve key (conflict if racing)
    try {
      await query(
        `INSERT INTO idempotency_keys (key, user_id, method, path)
         VALUES ($1, $2, $3, $4)`,
        [key, req.user?.id || null, req.method, req.originalUrl]
      );
    } catch (err) {
      if (err.code === '23505') {
        // Another request in flight with same key - brief wait & re-read
        await new Promise((r) => setTimeout(r, 150));
        const again = await query(
          `SELECT status_code, response FROM idempotency_keys WHERE key = $1`,
          [key]
        );
        if (again.rows[0]?.response) {
          return res.status(again.rows[0].status_code || 200).json(again.rows[0].response);
        }
        throw new AppError('Idempotency key in use', 409, 'IDEMPOTENCY_IN_FLIGHT');
      }
      throw err;
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const statusCode = res.statusCode || 200;
      query(
        `UPDATE idempotency_keys
         SET status_code = $2, response = $3
         WHERE key = $1`,
        [key, statusCode, body]
      ).catch((e) => console.error('[idempotency] store failed', e.message));
      return originalJson(body);
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { idempotency };
