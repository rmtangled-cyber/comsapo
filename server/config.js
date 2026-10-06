// All runtime configuration comes from environment variables.
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const config = {
    production,
    port: int(env.PORT, 3000),
    appUrl: (env.APP_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/$/, ''),
    dbFile: env.DATABASE_FILE || 'data/comsapo.db',

    model: env.COMSAPO_MODEL || 'claude-opus-5-5',
    // Hard stop for AI spend per UTC day (USD). 0 disables the guard.
    dailyBudgetUsd: num(env.AI_DAILY_BUDGET_USD, 20),

    rateLimits: {
      loginPerIp15Min: int(env.LOGIN_RATE_LIMIT, 20),
      loginMailsPerEmailHour: int(env.LOGIN_MAIL_RATE_LIMIT, 5),
      aiMessagesPer10Min: int(env.AI_RATE_LIMIT, 40),
    },

    plans: {
      free: { talksPerMonth: int(env.FREE_TALKS_PER_MONTH, 2) },
      plus: { talksPerMonth: int(env.PLUS_TALKS_PER_MONTH, 30) },
    },

    mail: {
      resendApiKey: env.RESEND_API_KEY || '',
      from: env.MAIL_FROM || 'comsapo <no-reply@example.com>',
    },

    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || '',
      priceId: env.STRIPE_PRICE_ID || '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
      priceLabel: env.PLUS_PRICE_LABEL || '月額 680円（税込）',
    },
  };
  config.billingEnabled = Boolean(config.stripe.secretKey && config.stripe.priceId && config.stripe.webhookSecret);
  return config;
}

// Refuse to boot a production instance that would silently misbehave.
export function assertProductionReady(config, env = process.env) {
  if (!config.production) return;
  const missing = [];
  if (!env.APP_URL?.startsWith('https://')) missing.push('APP_URL (https://...)');
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) missing.push('ANTHROPIC_API_KEY');
  if (!config.mail.resendApiKey) missing.push('RESEND_API_KEY');
  if (!env.MAIL_FROM) missing.push('MAIL_FROM');
  if (missing.length) throw new Error(`本番起動に必要な環境変数が未設定です: ${missing.join(', ')}`);
}
