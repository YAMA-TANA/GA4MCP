import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  checkGa4Compatibility,
  getGa4Metadata,
  listGa4Properties,
  runGa4RealtimeReport,
  runGa4Report,
  tabularizeReport,
} from "./ga4.js";

const dateRangeSchema = z.object({
  startDate: z.string().describe('YYYY-MM-DD or GA4 relative date such as "28daysAgo"'),
  endDate: z.string().describe('YYYY-MM-DD, "today", or "yesterday"'),
  name: z.string().optional(),
});

const looseObject = z.record(z.string(), z.unknown());

function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function userIdFromContext(ctx: any): string {
  const userId = ctx.http?.authInfo?.extra?.userId;
  if (typeof userId !== "string" || !userId) throw new Error("Authenticated Google user is missing");
  return userId;
}

export function buildMcpServer() {
  const server = new McpServer({
    name: "GA4 MCP",
    version: "0.1.0",
    description: "Read-only Google Analytics 4 reporting through the GA4 Data API.",
  });

  server.registerTool(
    "list_ga4_properties",
    {
      description: "List GA4 properties accessible to the connected Google account.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      try {
        return ok({ properties: await listGa4Properties(userIdFromContext(ctx)) });
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "get_ga4_metadata",
    {
      description: "List available GA4 dimensions and metrics, including custom definitions, for a property.",
      inputSchema: z.object({ propertyId: z.string().min(1) }),
    },
    async ({ propertyId }, ctx) => {
      try {
        const metadata = await getGa4Metadata(userIdFromContext(ctx), propertyId);
        return ok({ metadata });
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "check_ga4_compatibility",
    {
      description: "Check whether GA4 dimensions and metrics are compatible before running a report.",
      inputSchema: z.object({
        propertyId: z.string().min(1),
        dimensions: z.array(z.string()).default([]),
        metrics: z.array(z.string()).min(1),
      }),
    },
    async ({ propertyId, dimensions, metrics }, ctx) => {
      try {
        const compatibility = await checkGa4Compatibility(userIdFromContext(ctx), propertyId, dimensions, metrics);
        return ok({ compatibility });
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "run_ga4_report",
    {
      description: "Run a flexible GA4 Data API report. Use metadata/compatibility tools when field names are uncertain.",
      inputSchema: z.object({
        propertyId: z.string().min(1),
        dateRanges: z.array(dateRangeSchema).min(1).max(4),
        dimensions: z.array(z.string()).max(9).default([]),
        metrics: z.array(z.string()).min(1).max(10),
        dimensionFilter: looseObject.optional(),
        metricFilter: looseObject.optional(),
        orderBys: z.array(looseObject).optional(),
        limit: z.number().int().min(1).max(100000).default(100),
        offset: z.number().int().min(0).default(0),
        keepEmptyRows: z.boolean().default(false),
      }),
    },
    async (args, ctx) => {
      try {
        return ok(tabularizeReport(await runGa4Report(userIdFromContext(ctx), args)));
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "run_ga4_realtime_report",
    {
      description: "Query current GA4 realtime activity.",
      inputSchema: z.object({
        propertyId: z.string().min(1),
        dimensions: z.array(z.string()).default([]),
        metrics: z.array(z.string()).min(1),
        dimensionFilter: looseObject.optional(),
        metricFilter: looseObject.optional(),
        limit: z.number().int().min(1).max(100000).default(100),
      }),
    },
    async (args, ctx) => {
      try {
        return ok(tabularizeReport(await runGa4RealtimeReport(userIdFromContext(ctx), args)));
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "ga4_overview",
    {
      description: "Get a compact GA4 overview for a date range: users, sessions, views, engagement, and key events.",
      inputSchema: z.object({
        propertyId: z.string().min(1),
        startDate: z.string().default("28daysAgo"),
        endDate: z.string().default("yesterday"),
      }),
    },
    async ({ propertyId, startDate, endDate }, ctx) => {
      try {
        const result = await runGa4Report(userIdFromContext(ctx), {
          propertyId,
          dateRanges: [{ startDate, endDate }],
          dimensions: [],
          metrics: [
            "activeUsers",
            "newUsers",
            "sessions",
            "screenPageViews",
            "engagementRate",
            "averageSessionDuration",
            "keyEvents",
          ],
          limit: 1,
        });
        return ok(tabularizeReport(result));
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "ga4_top_pages",
    {
      description: "Return top pages by views with active users for a date range.",
      inputSchema: z.object({
        propertyId: z.string().min(1),
        startDate: z.string().default("28daysAgo"),
        endDate: z.string().default("yesterday"),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    },
    async ({ propertyId, startDate, endDate, limit }, ctx) => {
      try {
        const result = await runGa4Report(userIdFromContext(ctx), {
          propertyId,
          dateRanges: [{ startDate, endDate }],
          dimensions: ["pagePath", "pageTitle"],
          metrics: ["screenPageViews", "activeUsers"],
          orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
          limit,
        });
        return ok(tabularizeReport(result));
      } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "ga4_traffic_sources",
    {
      description: "Return session acquisition channels, sources, and media for a date range.",
      inputSchema: z.object({
        propertyId: z.string().min(1),
        startDate: z.string().default("28daysAgo"),
        endDate: z.string().default("yesterday"),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    },
    async ({ propertyId, startDate, endDate, limit }, ctx) => {
      try {
        const result = await runGa4Report(userIdFromContext(ctx), {
          propertyId,
          dateRanges: [{ startDate, endDate }],
          dimensions: ["sessionDefaultChannelGroup", "sessionSource", "sessionMedium"],
          metrics: ["sessions", "activeUsers", "engagedSessions", "keyEvents"],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit,
        });
        return ok(tabularizeReport(result));
      } catch (error) { return failure(error); }
    },
  );

  return server;
}
