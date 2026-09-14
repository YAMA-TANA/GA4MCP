import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const db = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes("localhost") || config.databaseUrl.includes("127.0.0.1")
    ? undefined
    : { rejectUnauthorized: false },
});

export async function ensureSchema(): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      google_access_token_enc TEXT NOT NULL,
      google_refresh_token_enc TEXT,
      google_expires_at BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT,
      redirect_uris JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_transactions (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      client_state TEXT,
      code_challenge TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_access_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_oauth_transactions_expiry ON oauth_transactions(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_access_tokens_expiry ON oauth_access_tokens(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry ON oauth_refresh_tokens(expires_at)`,
  ];

  for (const sql of statements) await db.query(sql);
}

export async function cleanupExpiredRows(): Promise<void> {
  await db.query("DELETE FROM oauth_transactions WHERE expires_at < NOW() - INTERVAL '1 hour'");
  await db.query("DELETE FROM oauth_codes WHERE expires_at < NOW() - INTERVAL '1 day'");
  await db.query("DELETE FROM oauth_access_tokens WHERE expires_at < NOW() - INTERVAL '1 day'");
  await db.query("DELETE FROM oauth_refresh_tokens WHERE expires_at < NOW() - INTERVAL '7 days'");
}
