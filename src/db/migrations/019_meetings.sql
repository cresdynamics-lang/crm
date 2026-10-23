-- Meetings: schedule or start, invite by email, join by invitation or host approval.
-- Idempotent. Creates new tables only.

CREATE TABLE IF NOT EXISTS meetings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  host_id       UUID NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'scheduled',  -- scheduled | live | ended
  scheduled_at  TIMESTAMPTZ,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meetings_host ON meetings(host_id);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status, scheduled_at);

CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id    UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL,
  status        VARCHAR(20) NOT NULL,                      -- host | invited | pending | admitted | denied
  invited_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (meeting_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_meeting_participants_user ON meeting_participants(user_id);
