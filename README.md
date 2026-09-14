# GA4 MCP

A read-only Google Analytics 4 MCP server with per-user Google OAuth.

The MCP server acts as its own OAuth 2.1 resource/authorization server. During authorization it delegates identity and GA4 consent to Google, stores Google refresh tokens encrypted, and issues opaque MCP access/refresh tokens to the MCP client.

## What it exposes

- `list_ga4_properties`
- `get_ga4_metadata`
- `check_ga4_compatibility`
- `run_ga4_report`
- `run_ga4_realtime_report`
- `ga4_overview`
- `ga4_top_pages`
- `ga4_traffic_sources`

All GA4 access uses only:

`https://www.googleapis.com/auth/analytics.readonly`

## OAuth architecture

```text
MCP client / ChatGPT
        |
        | OAuth 2.1 + PKCE
        v
      GA4 MCP
        |
        | Google OAuth
        v
Google Analytics Data API
```

The Google access/refresh token is never returned to the MCP client. MCP access and refresh tokens are opaque random values; only SHA-256 hashes of them are stored. Google tokens are encrypted at rest with AES-256-GCM.

## Requirements

- Node.js 20+
- PostgreSQL
- A Google Cloud OAuth Web Application
- Google Analytics Data API enabled
- Google Analytics Admin API enabled

## Google Cloud setup

Create an OAuth 2.0 Client ID of type **Web application**.

Add this redirect URI, replacing the host with your deployment domain:

```text
https://YOUR_DOMAIN/oauth/google/callback
```

Enable:

- Google Analytics Data API
- Google Analytics Admin API

Configure the OAuth consent screen. Public use of the Analytics read-only scope may require Google OAuth app verification before opening the service broadly.

## Environment

Copy `.env.example` and configure:

```text
PORT=3000
PUBLIC_BASE_URL=https://YOUR_DOMAIN
DATABASE_URL=postgres://...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
TOKEN_ENCRYPTION_KEY_BASE64=...
```

Generate the encryption key with:

```bash
openssl rand -base64 32
```

`PUBLIC_BASE_URL` must be the exact public HTTPS origin. The MCP URL is automatically `${PUBLIC_BASE_URL}/mcp`.

## Run locally

```bash
npm install
npm run dev
```

For a real OAuth callback, use an HTTPS tunnel or a deployed HTTPS domain and register that callback URL in Google Cloud.

## Production deploy

The repository contains a `Dockerfile`, so it can be deployed to services such as Railway, Render, Fly.io, Cloud Run, or another container host. Attach PostgreSQL and set the environment variables above.

The server creates its required tables on startup.

## MCP authorization endpoints

- MCP endpoint: `/mcp`
- Protected Resource Metadata: `/.well-known/oauth-protected-resource/mcp`
- Authorization Server Metadata: `/.well-known/oauth-authorization-server`
- Dynamic Client Registration: `/oauth/register`
- Authorization endpoint: `/oauth/authorize`
- Token endpoint: `/oauth/token`
- Revocation endpoint: `/oauth/revoke`
- Google callback: `/oauth/google/callback`

The OAuth flow requires Authorization Code + PKCE S256. Dynamic Client Registration is provided for MCP clients that still use DCR. MCP 2026-07-28 deprecates DCR in favor of Client ID Metadata Documents, so CIMD support is a sensible follow-up before treating this as a generic long-term MCP identity provider.

## Security notes

- GA4 access is read-only.
- PKCE S256 is mandatory.
- OAuth authorization codes are short-lived and one-time use.
- MCP access tokens expire after one hour.
- MCP refresh tokens rotate and expire after 30 days.
- Google refresh tokens are encrypted at rest.
- MCP access/refresh tokens are stored only as hashes.
- Redirect URIs must be HTTPS, except loopback HTTP for local clients.
- Access tokens are bound to this MCP resource when a `resource` parameter is supplied.

## Before public launch

1. Deploy behind HTTPS.
2. Use managed PostgreSQL with backups.
3. Configure the Google OAuth consent screen and verification.
4. Add a real privacy policy and terms page for your domain.
5. Test the full login flow with at least two separate Google accounts.
6. Verify that one account can never read another account's GA4 properties.
7. Add rate limiting on `/oauth/register`, `/oauth/token`, and `/mcp`.
8. Add monitoring for Google token refresh failures and OAuth errors without logging tokens.

## License

No license has been selected yet.
