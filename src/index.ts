import express from "express";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { config, MCP_SCOPE, MCP_URL } from "./config.js";
import { cleanupExpiredRows, ensureSchema } from "./db.js";
import { buildMcpServer } from "./mcp.js";
import { oauthMetadata, registerOAuthRoutes, verifyMcpAccessToken } from "./oauth.js";

const html = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;line-height:1.65;color:#171717}h1,h2{line-height:1.2}code{background:#f3f3f3;padding:2px 5px;border-radius:4px}a{color:inherit}</style></head>
<body>${body}</body></html>`;

async function main() {
  await ensureSchema();
  await cleanupExpiredRows();

  const allowedHosts = Array.from(new Set([
    config.baseUrl.hostname,
    "localhost",
    "127.0.0.1",
    ...config.extraAllowedHosts,
  ]));

  const app = createMcpExpressApp({
    host: "0.0.0.0",
    allowedHosts,
  });
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (_req, res) => {
    res.type("html").send(html("GA4 MCP", `
      <h1>GA4 MCP</h1>
      <p>Read-only Google Analytics 4 access for MCP clients.</p>
      <p><code>${MCP_URL.toString()}</code></p>
      <p><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/healthz">Health</a></p>
    `));
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.get("/privacy", (_req, res) => {
    res.type("html").send(html("GA4 MCP Privacy Policy", `
      <h1>Privacy Policy</h1>
      <p>GA4 MCP connects your Google account to a read-only Google Analytics 4 MCP service.</p>
      <h2>Data we process</h2>
      <p>We process your Google account identifier, email address, display name, OAuth credentials, and Google Analytics data requested through the MCP tools.</p>
      <h2>How data is used</h2>
      <p>Your information is used only to authenticate you, maintain the connection to Google, and answer GA4 requests that you initiate through an MCP client.</p>
      <h2>Storage</h2>
      <p>Google OAuth credentials are encrypted at rest. MCP access and refresh tokens are stored only as cryptographic hashes. GA4 report results are fetched on demand and are not intentionally persisted by this service.</p>
      <h2>Permissions</h2>
      <p>The service requests the Google Analytics read-only scope and does not request permission to edit your Analytics configuration or data.</p>
      <h2>Revocation</h2>
      <p>You may disconnect the integration from your Google Account permissions page. MCP clients may also revoke their service tokens through the OAuth revocation endpoint.</p>
      <h2>Changes</h2>
      <p>This policy may be updated as the service evolves. The current version is always published at this URL.</p>
    `));
  });

  app.get("/terms", (_req, res) => {
    res.type("html").send(html("GA4 MCP Terms", `
      <h1>Terms of Use</h1>
      <p>GA4 MCP is provided as a read-only interface to Google Analytics 4. You are responsible for ensuring that you have permission to access each Analytics property you query.</p>
      <p>The service is provided without a guarantee of uninterrupted availability or permanent compatibility with Google Analytics, MCP clients, or third-party platforms.</p>
      <p>You must not use the service to bypass access controls, interfere with the service, or access Analytics data you are not authorized to view.</p>
    `));
  });

  // RFC 9728 protected-resource metadata + RFC 8414 authorization-server metadata.
  app.use(mcpAuthMetadataRouter({
    oauthMetadata,
    resourceServerUrl: MCP_URL,
  }));

  registerOAuthRoutes(app);

  const auth = requireBearerAuth({
    verifier: { verifyAccessToken: verifyMcpAccessToken },
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_URL),
  });

  const nodeHandler = toNodeHandler(createMcpHandler(() => buildMcpServer()));
  app.all("/mcp", auth, (req, res) => void nodeHandler(req, res, req.body));

  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`GA4 MCP listening on :${config.port}`);
    console.log(`Public MCP URL: ${MCP_URL}`);
  });

  const cleanupTimer = setInterval(() => {
    void cleanupExpiredRows().catch((error) => console.error("OAuth cleanup failed", error));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
