/**
 * Cres Ops routes — Knowledge base management + RAG question answering.
 * /api/ops/*
 */
const express = require('express');
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { asyncHandler, AppError } = require('../lib/errors');
const {
  ingestKnowledge,
  searchKnowledge,
  listKnowledge,
  deleteKnowledge,
  getAccessibleKnowledge,
  getRecentAudit,
} = require('../services/knowledgeService');
const { answerQuestion, getGuidedQuestions } = require('../services/ragService');
const { transcribeAudio } = require('../services/voiceLeads');

const router = express.Router();
router.use(authenticate);

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/**
 * POST /api/ops/ask — Ask a question (role-based RAG).
 */
router.post(
  '/ask',
  asyncHandler(async (req, res) => {
    const question = (req.body?.question || '').trim();
    if (!question) throw new AppError('Question required', 400, 'VALIDATION');

    const result = await answerQuestion({
      question,
      userId: req.user.id,
      userRole: req.user.role,
      userName: req.user.name,
    });

    res.json({ ok: true, data: result });
  })
);

/**
 * GET /api/ops/guided — Get role-specific guided questions.
 */
router.get(
  '/guided',
  asyncHandler(async (req, res) => {
    const questions = getGuidedQuestions(req.user.role);
    res.json({ ok: true, data: { role: req.user.role, questions } });
  })
);

/**
 * POST /api/ops/ingest — Admin: add knowledge base entry.
 */
router.post(
  '/ingest',
  requirePermission('settings', 'manage'),
  asyncHandler(async (req, res) => {
    const { title, content, sourceType = 'text', category = 'general', tags = [], accessibleRoles = ['all'] } = req.body || {};
    if (!title || !content) throw new AppError('title and content required', 400, 'VALIDATION');

    const entry = await ingestKnowledge({
      title,
      content,
      sourceType,
      category,
      tags,
      accessibleRoles,
      createdBy: req.user.id,
    });

    res.status(201).json({ ok: true, data: entry });
  })
);

/**
 * POST /api/ops/ingest/voice — Admin: voice-record knowledge entry.
 */
router.post(
  '/ingest/voice',
  requirePermission('settings', 'manage'),
  memUpload.single('audio'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('No audio file', 400, 'VALIDATION');

    const { text: transcript } = await transcribeAudio({
      buffer: req.file.buffer,
      filename: req.file.originalname || 'voice.webm',
      mimetype: req.file.mimetype || 'audio/webm',
    });

    const title = req.body?.title || `Voice note — ${new Date().toLocaleDateString()}`;
    const category = req.body?.category || 'general';
    const accessibleRoles = req.body?.accessibleRoles
      ? JSON.parse(req.body.accessibleRoles)
      : ['all'];

    const entry = await ingestKnowledge({
      title,
      content: transcript,
      sourceType: 'voice',
      category,
      accessibleRoles,
      createdBy: req.user.id,
    });

    res.status(201).json({ ok: true, data: { ...entry, transcript } });
  })
);

/**
 * POST /api/ops/ingest/batch — Admin: ingest multiple entries.
 */
router.post(
  '/ingest/batch',
  requirePermission('settings', 'manage'),
  asyncHandler(async (req, res) => {
    const { entries } = req.body || {};
    if (!Array.isArray(entries) || !entries.length) throw new AppError('entries array required', 400, 'VALIDATION');

    const created = [];
    for (const e of entries) {
      if (!e.title || !e.content) continue;
      const entry = await ingestKnowledge({
        title: e.title,
        content: e.content,
        sourceType: e.sourceType || 'text',
        category: e.category || 'general',
        tags: e.tags || [],
        accessibleRoles: e.accessibleRoles || ['all'],
        createdBy: req.user.id,
      });
      created.push(entry);
    }

    res.status(201).json({ ok: true, data: { count: created.length } });
  })
);

/**
 * GET /api/ops/knowledge — Admin: list all knowledge entries.
 */
router.get(
  '/knowledge',
  requirePermission('settings', 'manage'),
  asyncHandler(async (req, res) => {
    const entries = await listKnowledge({
      category: req.query.category || null,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0,
    });
    res.json({ ok: true, data: entries });
  })
);

/**
 * DELETE /api/ops/knowledge/:id — Admin: delete knowledge entry.
 */
router.delete(
  '/knowledge/:id',
  requirePermission('settings', 'manage'),
  asyncHandler(async (req, res) => {
    await deleteKnowledge(req.params.id);
    res.json({ ok: true, data: { deleted: true } });
  })
);

/**
 * GET /api/ops/context — Get user's accessible knowledge + audit summary.
 */
router.get(
  '/context',
  asyncHandler(async (req, res) => {
    const [knowledge, audit] = await Promise.all([
      getAccessibleKnowledge({ role: req.user.role, limit: 10 }),
      getRecentAudit({ role: req.user.role, limit: 8 }),
    ]);
    res.json({ ok: true, data: { knowledge, audit } });
  })
);

module.exports = router;
