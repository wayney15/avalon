CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  invite_token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  host_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'locked', 'archived')),
  active_game_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE room_members (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seat_index INTEGER,
  joined_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  is_host INTEGER NOT NULL CHECK (is_host IN (0, 1)),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE room_spectators (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE games (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'finished', 'unfinished')),
  player_count INTEGER NOT NULL,
  host_user_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT,
  winner TEXT CHECK (winner IS NULL OR winner IN ('good', 'evil')),
  mission_wins_good INTEGER NOT NULL DEFAULT 0,
  mission_wins_evil INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE game_players (
  game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  seat_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  team TEXT NOT NULL CHECK (team IN ('good', 'evil')),
  is_host INTEGER NOT NULL CHECK (is_host IN (0, 1)),
  final_outcome TEXT NOT NULL CHECK (final_outcome IN ('good_win', 'evil_win', 'unfinished')),
  PRIMARY KEY (game_id, user_id)
);

CREATE TABLE game_events (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id TEXT,
  visible_to TEXT NOT NULL CHECK (visible_to IN ('all', 'host', 'evil', 'good', 'self', 'spectators', 'system')),
  subject_user_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (game_id, sequence_no)
);
