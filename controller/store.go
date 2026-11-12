package main

// PostgreSQL holds two things only: the "one task per issue" guarantee and an
// append-only history. The state of a running task lives in the Task
// resource's status; if the two ever disagree, the Task resource wins.

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct{ pool *pgxpool.Pool }

func NewStore(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	s := &Store{pool: pool}
	return s, s.migrate(ctx)
}

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS tasks (
  repo       text        NOT NULL,
  issue      bigint      NOT NULL,
  task       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo, issue)
);
CREATE TABLE IF NOT EXISTS task_events (
  id      bigserial   PRIMARY KEY,
  task    text        NOT NULL,
  phase   text        NOT NULL,
  message text        NOT NULL DEFAULT '',
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task, id);`)
	return err
}

// Claim records that an issue is being handled. It returns false when the
// issue was already claimed, so the same issue is never picked up twice.
func (s *Store) Claim(ctx context.Context, repo string, issue int64, task string) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`INSERT INTO tasks (repo, issue, task) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		repo, issue, task)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (s *Store) Event(ctx context.Context, task, phase, message string) {
	// History is best effort: a failed insert must not stall a task.
	_, _ = s.pool.Exec(ctx,
		`INSERT INTO task_events (task, phase, message) VALUES ($1, $2, $3)`, task, phase, message)
}
