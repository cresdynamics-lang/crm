class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    this.details = details;
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function errorHandler(err, req, res, _next) {
  // Multer upload errors
  if (err && (err.name === 'MulterError' || err.code === 'LIMIT_FILE_SIZE')) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large (max 20 MB for deliverables, 5 MB for avatars)'
        : err.message || 'Upload failed';
    return res.status(400).json({
      ok: false,
      error: { code: 'UPLOAD_ERROR', message },
    });
  }
  if (err && err.message === 'File type not allowed') {
    return res.status(400).json({
      ok: false,
      error: { code: 'UPLOAD_TYPE', message: err.message },
    });
  }

  // Bad input that reached the database (e.g. "abc" where an id is expected,
  // an impossible date or number) is the caller's mistake: 400, not a crash.
  const PG_BAD_INPUT = {
    '22P02': 'Invalid value (for example a malformed id).',
    '22007': 'Invalid date or time.',
    '22008': 'Date or time out of range.',
    '22003': 'Number out of range.',
    '22001': 'A value is too long.',
    '23502': 'A required value is missing.',
  };
  if (err && typeof err.code === 'string' && PG_BAD_INPUT[err.code]) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: PG_BAD_INPUT[err.code] } });
  }
  // A referenced record that does not exist (foreign key) is also a client error.
  if (err && err.code === '23503') {
    return res.status(409).json({ ok: false, error: { code: 'REFERENCE_NOT_FOUND', message: 'A linked record does not exist.' } });
  }

  const status = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const payload = {
    ok: false,
    error: {
      code,
      message: err.isOperational ? err.message : 'Internal server error',
    },
  };
  if (err.details) payload.error.details = err.details;

  if (process.env.NODE_ENV === 'development' && !err.isOperational) {
    payload.error.detail = err.message;
  }

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.path}`, err);
    // eslint-disable-next-line global-require
    require('./errorLog').logError(err, { kind: 'server-error', req });
  }

  res.status(status).json(payload);
}

function notFound(req, res) {
  res.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.path}` },
  });
}

module.exports = { AppError, asyncHandler, errorHandler, notFound };
