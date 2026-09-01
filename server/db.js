require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error(
    '\nMissing DATABASE_URL.\n' +
    'Create a .env file in the project root with a line like:\n' +
    '  DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require\n' +
    'See README.md for how to get one from a free cloud Postgres provider.\n'
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most hosted Postgres providers (Neon, Supabase, Railway, etc.) require
  // SSL and use certificates that aren't in Node's default trust store.
  // A local Postgres (no "sslmode=require" in the URL) skips this.
  ssl: /sslmode=require|neon\.tech|supabase|render\.com|railway\.app/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      age INTEGER NOT NULL,
      gender TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sports (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sport_id TEXT NOT NULL,
      PRIMARY KEY (user_id, sport_id)
    );

    CREATE TABLE IF NOT EXISTS swipes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('like','pass')),
      created_at BIGINT NOT NULL,
      UNIQUE(user_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      UNIQUE(user_a, user_b)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  // --- migration: match requests (pending/accepted) ---
  // These columns didn't exist in earlier versions of the app, where every
  // match was created already-accepted. ADD COLUMN IF NOT EXISTS is safe to
  // run on every startup, including against a database that already has
  // real matches in it.
  await pool.query(`
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS requested_by INTEGER REFERENCES users(id);
  `);
  // Any match row created before this feature existed has no requested_by
  // set. Those were instant matches under the old rules, so treat them as
  // already-accepted rather than retroactively blocking existing chats.
  await pool.query(`
    UPDATE matches SET status = 'accepted' WHERE requested_by IS NULL AND status = 'pending';
  `);

  // --- migration: profile decoration (avatar, color, title, bio, photo) ---
  // Existing accounts get sensible defaults automatically since these
  // columns have DEFAULT values - no backfill needed.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_emoji TEXT NOT NULL DEFAULT '🏅';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color TEXT NOT NULL DEFAULT '#C6FF3D';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_data_url TEXT;
  `);

  // --- migration: photo posts ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      image_data_url TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
  `);
}

module.exports = { pool, initSchema };
