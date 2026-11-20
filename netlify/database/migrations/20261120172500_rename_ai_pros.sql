-- Rename AI leaderboard pros r_orbit and r_seok
UPDATE wallgo_entries
SET name = '幽影壁壘', norm_key = '幽影壁壘'
WHERE id = 'r_orbit' AND is_ai = TRUE;

UPDATE wallgo_entries
SET name = '絕境圍城', norm_key = '絕境圍城'
WHERE id = 'r_seok' AND is_ai = TRUE;

UPDATE wallgo_meta
SET version = version + 1,
    updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
WHERE id = 1;
