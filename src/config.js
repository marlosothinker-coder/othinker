export function loadConfig(env = process.env) {
  const missing = ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'SUPPORT_EMAIL'].filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  return {
    apiKey: env.SHOPIFY_API_KEY,
    apiSecret: env.SHOPIFY_API_SECRET,
    supportEmail: env.SUPPORT_EMAIL,
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? './data/app.sqlite',
  };
}
