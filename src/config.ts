export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  baseUrl: new URL(requiredEnv("PUBLIC_BASE_URL")),
  databaseUrl: requiredEnv("DATABASE_URL"),
  googleClientId: requiredEnv("GOOGLE_CLIENT_ID"),
  googleClientSecret: requiredEnv("GOOGLE_CLIENT_SECRET"),
  encryptionKeyBase64: requiredEnv("TOKEN_ENCRYPTION_KEY_BASE64"),
  extraAllowedHosts: (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
};

export const MCP_SCOPE = "ga4.read";
export const GOOGLE_SCOPE = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/analytics.readonly",
].join(" ");

export const MCP_URL = new URL("/mcp", config.baseUrl);
export const GOOGLE_CALLBACK_URL = new URL("/oauth/google/callback", config.baseUrl);
