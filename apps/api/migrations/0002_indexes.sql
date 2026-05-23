CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_rooms_code ON rooms(code);
CREATE INDEX idx_rooms_invite_token ON rooms(invite_token);
CREATE INDEX idx_rooms_host_user_id ON rooms(host_user_id);
CREATE INDEX idx_games_room_id_started_at ON games(room_id, started_at DESC);
CREATE INDEX idx_game_events_game_id_sequence_no ON game_events(game_id, sequence_no);
CREATE INDEX idx_room_members_room_id_seat_index ON room_members(room_id, seat_index);
