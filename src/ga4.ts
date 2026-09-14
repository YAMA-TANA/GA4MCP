import { googleAccessTokenForUser } from "./google.js";

async function googleJson<T>(userId: string, url: string, init: RequestInit = {}): Promise<T> {
  const accessToken = await googleAccessTokenForUser(userId);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(body?.error?.message ?? body?.error_description ?? `Google API ${res.status}`);
  }
  return body as T;
}

export async function listGa4Properties(userId: string) {
  const properties: any[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await googleJson<any>(userId, url.toString());
    for (const account of body.accountSummaries ?? []) {
      for (const property of account.propertySummaries ?? []) {
        properties.push({
          account: account.account,
          accountDisplayName: account.displayName,
          property: property.property,
          propertyId: String(property.property ?? "").replace("properties/", ""),
          displayName: property.displayName,
          propertyType: property.propertyType,
          parent: property.parent,
        });
      }
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  return properties;
}

export async function getGa4Metadata(userId: string, propertyId: string) {
  return googleJson<any>(
    userId,
    `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}/metadata`,
  );
}

export async function checkGa4Compatibility(
  userId: string,
  propertyId: string,
  dimensions: string[],
  metrics: string[],
) {
  return googleJson<any>(
    userId,
    `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:checkCompatibility`,
    {
      method: "POST",
      body: JSON.stringify({
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
        compatibilityFilter: "COMPATIBLE",
      }),
    },
  );
}

export type RunReportInput = {
  propertyId: string;
  dateRanges: Array<{ startDate: string; endDate: string; name?: string }>;
  dimensions: string[];
  metrics: string[];
  dimensionFilter?: Record<string, unknown>;
  metricFilter?: Record<string, unknown>;
  orderBys?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
  keepEmptyRows?: boolean;
};

export async function runGa4Report(userId: string, input: RunReportInput) {
  const body: Record<string, unknown> = {
    dateRanges: input.dateRanges,
    dimensions: input.dimensions.map((name) => ({ name })),
    metrics: input.metrics.map((name) => ({ name })),
    limit: Math.min(Math.max(input.limit ?? 100, 1), 100000),
    offset: Math.max(input.offset ?? 0, 0),
    keepEmptyRows: input.keepEmptyRows ?? false,
    returnPropertyQuota: true,
  };
  if (input.dimensionFilter) body.dimensionFilter = input.dimensionFilter;
  if (input.metricFilter) body.metricFilter = input.metricFilter;
  if (input.orderBys) body.orderBys = input.orderBys;

  return googleJson<any>(
    userId,
    `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(input.propertyId)}:runReport`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function runGa4RealtimeReport(userId: string, input: {
  propertyId: string;
  dimensions: string[];
  metrics: string[];
  dimensionFilter?: Record<string, unknown>;
  metricFilter?: Record<string, unknown>;
  limit?: number;
}) {
  const body: Record<string, unknown> = {
    dimensions: input.dimensions.map((name) => ({ name })),
    metrics: input.metrics.map((name) => ({ name })),
    limit: Math.min(Math.max(input.limit ?? 100, 1), 100000),
    returnPropertyQuota: true,
  };
  if (input.dimensionFilter) body.dimensionFilter = input.dimensionFilter;
  if (input.metricFilter) body.metricFilter = input.metricFilter;

  return googleJson<any>(
    userId,
    `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(input.propertyId)}:runRealtimeReport`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function tabularizeReport(response: any) {
  const dimensionHeaders = (response.dimensionHeaders ?? []).map((x: any) => x.name);
  const metricHeaders = (response.metricHeaders ?? []).map((x: any) => x.name);
  const rows = (response.rows ?? []).map((row: any) => {
    const output: Record<string, string> = {};
    dimensionHeaders.forEach((name: string, index: number) => {
      output[name] = row.dimensionValues?.[index]?.value ?? "";
    });
    metricHeaders.forEach((name: string, index: number) => {
      output[name] = row.metricValues?.[index]?.value ?? "";
    });
    return output;
  });
  return {
    columns: [...dimensionHeaders, ...metricHeaders],
    rows,
    rowCount: response.rowCount ?? rows.length,
    totals: response.totals,
    maximums: response.maximums,
    minimums: response.minimums,
    metadata: response.metadata,
    propertyQuota: response.propertyQuota,
  };
}
