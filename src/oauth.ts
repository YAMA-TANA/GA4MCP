import type { Express, Request, Response } from "express";
import type { AuthInfo, OAuthMetadata } from "@modelcontextprotocol/server";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { config, MCP_SCOPE, MCP_URL } from "./config.js";
import { db } from "./db.js";
import { hashToken, pkceS256, randomToken } from "./crypto.js";
import { exchangeGoogleCode, googleAuthorizationUrl, upsertGoogleUser } from "./google.js";

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const AUTH_CODE_TTL_SECONDS = 5 * 60;
const TX_TTL_SECONDS = 10 * 60;

export const oauthMetadata = {
  issuer: config.baseUrl.origin,
  authorization_endpoint: new URL("/oauth/authorize", config.baseUrl).toString(),
  token_endpoint: new URL("/oauth/token", config.baseUrl).toString(),
  registration_endpoint: new URL("/oauth/register", config.baseUrl).toString(),
  revocation_endpoint: new URL("/oauth/revoke", config.baseUrl).toString(),
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: [MCP_SCOPE],
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: false,
} as OAuthMetadata;

function sendOAuthError(res: Response, status: number, error: string, description: string) {
  return res.status(status).json({ error, error_description: description });
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function requestedScopes(scopeRaw: unknown): string[] {
  return String(scopeRaw ?? MCP_SCOPE).split(/\s+/).filter(Boolean);
}

function scopeIsAllowed(scopeRaw: unknown): boolean {
  const scopes = requestedScopes(scopeRaw);
  return scopes.length > 0 && scopes.every((scope) => scope === MCP_SCOPE);
}

async function getRegisteredClient(clientId: string) {
  const result = await db.query<{ client_id: string; redirect_uris: string[]; client_name: string | null }>(
    "SELECT client_id, redirect_uris, client_name FROM oauth_clients WHERE client_id = $1",
    [clientId],
  );
  return result.rows[0];
}

function redirectOAuthError(redirectUri: string, state: string | null, error: string, description: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  url.searchParams.set("iss", config.baseUrl.origin);
  return url.toString();
}

async function issueMcpTokens(args: {
  userId: string;
  clientId: string;
  scope: string;
  resource?: string | null;
}) {
  const accessToken = `ga4a_${randomToken(32)}`;
  const refreshToken = `ga4r_${randomToken(40)}`;
  const accessExpiry = new Date(Date.now() + ACCESS_TTL_SECONDS * 1000);
  const refreshExpiry = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO oauth_access_tokens
       (token_hash, user_id, client_id, scope, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [hashToken(accessToken), args.userId, args.clientId, args.scope, args.resource ?? null, accessExpiry],
    );
    await client.query(
      `INSERT INTO oauth_refresh_tokens
       (token_hash, user_id, client_id, scope, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [hashToken(refreshToken), args.userId, args.clientId, args.scope, args.resource ?? null, refreshExpiry],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: args.scope,
  };
}

export function registerOAuthRoutes(app: Express) {
  app.post("/oauth/register", async (req: Request, res: Response) => {
    const redirectUris = req.body?.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 10) {
      return sendOAuthError(res, 400, "invalid_client_metadata", "redirect_uris must contain 1-10 URIs");
    }
    if (!redirectUris.every((uri: unknown) => typeof uri === "string" && isAllowedRedirectUri(uri))) {
      return sendOAuthError(res, 400, "invalid_redirect_uri", "Only HTTPS or loopback HTTP redirect URIs are accepted");
    }
    if (req.body?.token_endpoint_auth_method && req.body.token_endpoint_auth_method !== "none") {
      return sendOAuthError(res, 400, "invalid_client_metadata", "Only public clients (token_endpoint_auth_method=none) are supported");
    }

    const clientId = `mcp_${randomToken(24)}`;
    const clientName = typeof req.body?.client_name === "string" ? req.body.client_name.slice(0, 200) : null;
    await db.query(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3::jsonb)",
      [clientId, clientName, JSON.stringify(redirectUris)],
    );
    return res.status(201).json({
      client_id: clientId,
      client_name: clientName ?? undefined,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: req.body?.application_type ?? "web",
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  });

  app.get("/oauth/authorize", async (req: Request, res: Response) => {
    const clientId = String(req.query.client_id ?? "");
    const redirectUri = String(req.query.redirect_uri ?? "");
    const responseType = String(req.query.response_type ?? "");
    const codeChallenge = String(req.query.code_challenge ?? "");
    const codeChallengeMethod = String(req.query.code_challenge_method ?? "");
    const state = req.query.state == null ? null : String(req.query.state);
    const scope = String(req.query.scope ?? MCP_SCOPE);
    const resource = req.query.resource == null ? null : String(req.query.resource);

    const client = await getRegisteredClient(clientId);
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      return sendOAuthError(res, 400, "invalid_request", "Unknown client or redirect_uri");
    }
    if (responseType !== "code") {
      return res.redirect(redirectOAuthError(redirectUri, state, "unsupported_response_type", "Only response_type=code is supported"));
    }
    if (codeChallengeMethod !== "S256" || !codeChallenge) {
      return res.redirect(redirectOAuthError(redirectUri, state, "invalid_request", "PKCE S256 is required"));
    }
    if (!scopeIsAllowed(scope)) {
      return res.redirect(redirectOAuthError(redirectUri, state, "invalid_scope", `Only ${MCP_SCOPE} is supported`));
    }
    if (resource && resource !== MCP_URL.toString()) {
      return res.redirect(redirectOAuthError(redirectUri, state, "invalid_target", "This token can only target this MCP resource"));
    }

    const transactionId = `tx_${randomToken(32)}`;
    await db.query(
      `INSERT INTO oauth_transactions
       (id, client_id, redirect_uri, client_state, code_challenge, scope, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 * INTERVAL '1 second'))`,
      [transactionId, clientId, redirectUri, state, codeChallenge, scope, resource, TX_TTL_SECONDS],
    );
    return res.redirect(googleAuthorizationUrl(transactionId));
  });

  app.get("/oauth/google/callback", async (req: Request, res: Response) => {
    const transactionId = String(req.query.state ?? "");
    const txResult = await db.query<{
      id: string;
      client_id: string;
      redirect_uri: string;
      client_state: string | null;
      code_challenge: string;
      scope: string;
      resource: string | null;
    }>(
      `DELETE FROM oauth_transactions
       WHERE id = $1 AND expires_at > NOW()
       RETURNING id, client_id, redirect_uri, client_state, code_challenge, scope, resource`,
      [transactionId],
    );
    const tx = txResult.rows[0];
    if (!tx) return sendOAuthError(res, 400, "invalid_request", "OAuth transaction is missing or expired");

    if (req.query.error) {
      return res.redirect(redirectOAuthError(tx.redirect_uri, tx.client_state, "access_denied", String(req.query.error)));
    }
    const googleCode = String(req.query.code ?? "");
    if (!googleCode) {
      return res.redirect(redirectOAuthError(tx.redirect_uri, tx.client_state, "server_error", "Google returned no authorization code"));
    }

    try {
      const googleTokens = await exchangeGoogleCode(googleCode);
      const user = await upsertGoogleUser(googleTokens);
      const mcpCode = `ga4c_${randomToken(32)}`;
      await db.query(
        `INSERT INTO oauth_codes
         (code_hash, user_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 * INTERVAL '1 second'))`,
        [hashToken(mcpCode), user.sub, tx.client_id, tx.redirect_uri, tx.code_challenge, tx.scope, tx.resource, AUTH_CODE_TTL_SECONDS],
      );

      const redirect = new URL(tx.redirect_uri);
      redirect.searchParams.set("code", mcpCode);
      if (tx.client_state) redirect.searchParams.set("state", tx.client_state);
      redirect.searchParams.set("iss", config.baseUrl.origin);
      return res.redirect(redirect.toString());
    } catch (error) {
      const description = error instanceof Error ? error.message : "Google authorization failed";
      return res.redirect(redirectOAuthError(tx.redirect_uri, tx.client_state, "server_error", description));
    }
  });

  app.post("/oauth/token", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");

    const grantType = String(req.body?.grant_type ?? "");
    const clientId = String(req.body?.client_id ?? "");
    if (!clientId || !(await getRegisteredClient(clientId))) {
      return sendOAuthError(res, 401, "invalid_client", "Unknown OAuth client");
    }

    if (grantType === "authorization_code") {
      const code = String(req.body?.code ?? "");
      const redirectUri = String(req.body?.redirect_uri ?? "");
      const verifier = String(req.body?.code_verifier ?? "");
      if (!code || !redirectUri || verifier.length < 43 || verifier.length > 128) {
        return sendOAuthError(res, 400, "invalid_grant", "Missing code, redirect_uri, or valid PKCE verifier");
      }

      const codeResult = await db.query<{
        user_id: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        scope: string;
        resource: string | null;
      }>(
        `DELETE FROM oauth_codes
         WHERE code_hash = $1 AND used = FALSE AND expires_at > NOW()
         RETURNING user_id, client_id, redirect_uri, code_challenge, scope, resource`,
        [hashToken(code)],
      );
      const row = codeResult.rows[0];
      if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri || pkceS256(verifier) !== row.code_challenge) {
        return sendOAuthError(res, 400, "invalid_grant", "Authorization code is invalid, expired, or PKCE validation failed");
      }
      return res.json(await issueMcpTokens({
        userId: row.user_id,
        clientId,
        scope: row.scope,
        resource: row.resource,
      }));
    }

    if (grantType === "refresh_token") {
      const refreshToken = String(req.body?.refresh_token ?? "");
      if (!refreshToken) return sendOAuthError(res, 400, "invalid_grant", "Missing refresh_token");

      const refreshResult = await db.query<{
        user_id: string;
        client_id: string;
        scope: string;
        resource: string | null;
      }>(
        `UPDATE oauth_refresh_tokens
         SET revoked = TRUE
         WHERE token_hash = $1 AND client_id = $2 AND revoked = FALSE AND expires_at > NOW()
         RETURNING user_id, client_id, scope, resource`,
        [hashToken(refreshToken), clientId],
      );
      const row = refreshResult.rows[0];
      if (!row) return sendOAuthError(res, 400, "invalid_grant", "Refresh token is invalid or expired");

      return res.json(await issueMcpTokens({
        userId: row.user_id,
        clientId,
        scope: row.scope,
        resource: row.resource,
      }));
    }

    return sendOAuthError(res, 400, "unsupported_grant_type", "Supported grants: authorization_code, refresh_token");
  });

  app.post("/oauth/revoke", async (req: Request, res: Response) => {
    const token = String(req.body?.token ?? "");
    if (token) {
      const tokenHash = hashToken(token);
      await Promise.all([
        db.query("DELETE FROM oauth_access_tokens WHERE token_hash = $1", [tokenHash]),
        db.query("UPDATE oauth_refresh_tokens SET revoked = TRUE WHERE token_hash = $1", [tokenHash]),
      ]);
    }
    return res.status(200).end();
  });
}

export async function verifyMcpAccessToken(token: string): Promise<AuthInfo> {
  const result = await db.query<{
    user_id: string;
    client_id: string;
    scope: string;
    resource: string | null;
    expires_at: Date;
  }>(
    `SELECT user_id, client_id, scope, resource, expires_at
     FROM oauth_access_tokens
     WHERE token_hash = $1 AND expires_at > NOW()`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token is invalid or expired");
  if (row.resource && row.resource !== MCP_URL.toString()) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token was issued for a different resource");
  }

  return {
    token,
    clientId: row.client_id,
    scopes: row.scope.split(/\s+/).filter(Boolean),
    expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
    resource: MCP_URL,
    extra: { userId: row.user_id },
  };
}
