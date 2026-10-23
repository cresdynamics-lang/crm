/**
 * Director (and Admin) live website-traffic analytics.
 * Reads the public website's site_visits table via the read-only
 * websiteDb pool. All timelines bucketed in East African Time
 * (Africa/Nairobi) and every payload carries an as-of timestamp.
 */
const express = require('express');
const { wQuery, wQueryRows, websiteDbAvailable, respondIfDisconnected } = require('../config/websiteDb');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { asyncHandler } = require('../lib/errors');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('director', 'admin'));

const EAT = 'Africa/Nairobi';
const PERIODS = {
  d3: { label: '3 days', days: 3 },
  w1: { label: '1 week', days: 7 },
  m1: { label: '1 month', days: 30 },
  m3: { label: '3 months', days: 91 },
  m6: { label: '6 months', days: 183 },
};

router.get('/health', asyncHandler(async (_req, res) => {
  const status = await websiteDbAvailable();
  res.json({
    ok: true,
    connected: status.status === 'up',
    message: status.status === 'up' ? 'Connected' : 'Not connected yet',
    data: status,
  });
}));

/**
 * Summary + growth vs previous period + EAT day/hour series.
 */
router.get('/summary', asyncHandler(async (req, res) => {
  if (await respondIfDisconnected(res, { series: [], devices: [], topPages: [], geo: [] })) return;
  const period = req.query.period || 'm1';
  const days = PERIODS[period]?.days || 30;
  const bucket = days <= 7 ? 'hour' : 'day';
  const fmt = { hour: 'YYYY-MM-DD"T"HH24:00', day: 'YYYY-MM-DD' }[bucket];

  const [current, previous, series, devices, topPages, geo] = await Promise.all([
    wQueryRows(
      `SELECT COUNT(*)::bigint AS visits,
              COUNT(DISTINCT visitor_hash)::bigint AS visitors,
              COUNT(DISTINCT ip)::bigint AS unique_ips,
              COUNT(*) FILTER (WHERE visited_at >= now() - interval '5 minutes')::bigint AS live_now,
              MAX(visited_at) AS last_visit
       FROM site_visits
       WHERE visited_at >= now() - $1::interval`,
      [`${days} days`]
    ),
    wQueryRows(
      `SELECT COUNT(*)::bigint AS visits,
              COUNT(DISTINCT visitor_hash)::bigint AS visitors
       FROM site_visits
       WHERE visited_at >= now() - ($1::text || ' days')::interval
         AND visited_at <  now() - ($2::text || ' days')::interval`,
      [String(days * 2), String(days)]
    ),
    wQueryRows(
      `SELECT to_char(date_trunc('${bucket}', visited_at AT TIME ZONE $2), '${fmt}') AS bucket,
              COUNT(*)::bigint AS visits,
              COUNT(DISTINCT visitor_hash)::bigint AS visitors
       FROM site_visits
       WHERE visited_at >= now() - $1::interval
       GROUP BY 1 ORDER BY 1`,
      [`${days} days`, EAT]
    ),
    wQueryRows(
      `SELECT COALESCE(device_type, 'unknown') AS device_type, COUNT(*)::bigint AS count
       FROM site_visits WHERE visited_at >= now() - $1::interval
       GROUP BY 1 ORDER BY count DESC`,
      [`${days} days`]
    ),
    wQueryRows(
      `SELECT path, COUNT(*)::bigint AS count
       FROM site_visits WHERE visited_at >= now() - $1::interval
       GROUP BY path ORDER BY count DESC LIMIT 10`,
      [`${days} days`]
    ),
    wQueryRows(
      `SELECT COALESCE(city, 'Other') AS city,
              COALESCE(country_code, '') AS country_code,
              COUNT(*)::bigint AS count
       FROM site_visits WHERE visited_at >= now() - $1::interval
       GROUP BY 1, 2 ORDER BY count DESC LIMIT 15`,
      [`${days} days`]
    ),
  ]);

  const cur = current[0];
  const prev = previous[0] || {};
  const pct = (curVisit, prevVisit) =>
    prevVisit > 0 ? Math.round(((curVisit - prevVisit) / prevVisit) * 100) : 0;

  res.json({
    ok: true,
    data: {
      asOf: new Date().toISOString(),
      timezone: EAT,
      period,
      bucket,
      current: {
        visits: Number(cur.visits),
        visitors: Number(cur.visitors),
        uniqueIps: Number(cur.unique_ips),
        liveNow: Number(cur.live_now),
        lastVisit: cur.last_visit,
      },
      previous: {
        visits: Number(prev.visits),
        visitors: Number(prev.visitors),
      },
      growth: {
        visitsPct: cur.visits > 0 ? pct(Number(cur.visits), Number(prev.visits)) : 0,
        visitorsPct: cur.visitors > 0 ? pct(Number(cur.visitors), Number(prev.visitors)) : 0,
      },
      series: series.map((s) => ({ bucket: s.bucket, visits: Number(s.visits), visitors: Number(s.visitors) })),
      devices,
      topPages,
      geo,
    },
  });
}));

/**
 * Live feed - the most recent site visits (last 15 min), EAT timestamps.
 */
router.get('/live', asyncHandler(async (req, res) => {
  if (await respondIfDisconnected(res, { total: 0, visits: [] })) return;
  const rows = await wQueryRows(
    `SELECT path,
            COALESCE(city, '') AS city,
            COALESCE(country_code, '') AS country_code,
            device_type,
            to_char(visited_at AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI:SS') AS at_eat
     FROM site_visits
     WHERE visited_at >= now() - interval '15 minutes'
     ORDER BY visited_at DESC
     LIMIT 25`,
    [EAT]
  );
  const { rows: count } = await wQuery(
    `SELECT COUNT(*)::bigint AS n
     FROM site_visits WHERE visited_at >= now() - interval '15 minutes'`
  );
  res.json({ ok: true, data: { asOf: new Date().toISOString(), timezone: EAT, total: Number(count[0].n), visits: rows } });
}));

module.exports = router;