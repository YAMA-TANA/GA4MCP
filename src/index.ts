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
    res.json({
      name: "GA4 MCP",
      status: "ok",
      mcp: MCP_URL.toString(),
      oauth: new URL("/.well-known/oauth-authorization-server", config.baseUrl).toString(),
      scope: MCP_SCOPE,
    });
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

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
