import { config, GOOGLE_CALLBACK_URL, GOOGLE_SCOPE } from "./config.js";
import { db } from "./db.js";
import { decryptSecret, encryptSecret } from "./crypto.js";

export type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
  id_token?: string;
};

type GoogleUserInfo = {
  sub: string;
  email: string;
  name?: string;
};

async function parseGoogleResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(body?.error_description ?? body?.error ?? `Google API ${res.status}`);
  }
  return body as T;
}

export function googleAuthorizationUrl(transactionId: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("redirect_uri", GOOGLE_CALLBACK_URL.toString());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  // Ensures first-time public users receive a refresh token. Existing refresh
  // tokens are preserved server-side if Google omits one on a later consent.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", transactionId);
  return url.toString();
}

export async function exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: GOOGLE_CALLBACK_URL.toString(),
    grant_type: "authorization_code",
  });
  return parseGoogleResponse<GoogleTokenResponse>(await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }));
}

export async function fetchGoogleUser(accessToken: string): Promise<GoogleUserInfo> {
  return parseGoogleResponse<GoogleUserInfo>(await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  }));
}

export async function upsertGoogleUser(tokens: GoogleTokenResponse): Promise<GoogleUserInfo> {
  const user = await fetchGoogleUser(tokens.access_token);
  const existing = await db.query<{ google_refresh_token_enc: string | null }>(
    "SELECT google_refresh_token_enc FROM users WHERE id = $1",
    [user.sub],
  );
  const refreshEnc = tokens.refresh_token
    ? encryptSecret(tokens.refresh_token)
    : existing.rows[0]?.google_refresh_token_enc ?? null;

  if (!refreshEnc) {
    throw new Error("Google did not issue a refresh token. Reconnect and grant consent again.");
  }

  const expiresAt = Date.now() + Math.max(tokens.expires_in - 30, 60) * 1000;
  await db.query(
    `INSERT INTO users
      (id, email, name, google_access_token_enc, google_refresh_token_enc, google_expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       name = EXCLUDED.name,
       google_access_token_enc = EXCLUDED.google_access_token_enc,
       google_refresh_token_enc = EXCLUDED.google_refresh_token_enc,
       google_expires_at = EXCLUDED.google_expires_at,
       updated_at = NOW()`,
    [
      user.sub,
      user.email,
      user.name ?? null,
      encryptSecret(tokens.access_token),
      refreshEnc,
      expiresAt,
    ],
  );
  return user;
}

export async function googleAccessTokenForUser(userId: string): Promise<string> {
  const result = await db.query<{
    google_access_token_enc: string;
    google_refresh_token_enc: string | null;
    google_expires_at: string;
  }>(
    `SELECT google_access_token_enc, google_refresh_token_enc, google_expires_at
     FROM users WHERE id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Google account is no longer connected.");

  if (Number(row.google_expires_at) > Date.now() + 60_000) {
    return decryptSecret(row.google_access_token_enc);
  }
  if (!row.google_refresh_token_enc) {
    throw new Error("Google refresh token is missing. Reconnect the account.");
  }

  const refreshToken = decryptSecret(row.google_refresh_token_enc);
  const body = new URLSearchParams({
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const refreshed = await parseGoogleResponse<GoogleTokenResponse>(await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }));
  const expiresAt = Date.now() + Math.max(refreshed.expires_in - 30, 60) * 1000;
  await db.query(
    `UPDATE users
     SET google_access_token_enc = $2, google_expires_at = $3, updated_at = NOW()
     WHERE id = $1`,
    [userId, encryptSecret(refreshed.access_token), expiresAt],
  );
  return refreshed.access_token;
}
