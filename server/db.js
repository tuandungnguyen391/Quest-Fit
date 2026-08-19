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
  
  await pool.query(`
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS requested_by INTEGER REFERENCES users(id);
  `);

  await pool.query(`
    UPDATE matches SET status = 'accepted' WHERE requested_by IS NULL AND status = 'pending';
  `);
}

module.exports = { pool, initSchema };
