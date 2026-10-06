import { loadConfig, assertProductionReady } from './config.js';
import { openDb } from './db.js';
import { createAI, AIError } from './ai.js';
import { createMailer } from './mailer.js';
import { createBilling } from './billing.js';
import { createApp } from './app.js';

const config = loadConfig();
assertProductionReady(config);

const repo = openDb(config.dbFile);
repo.resetInFlight();

const startOfUtcDay = () => `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
const ai = createAI({
  model: config.model,
  guard() {
    if (config.dailyBudgetUsd > 0 && repo.costSince(startOfUtcDay()) >= config.dailyBudgetUsd) {
      console.error('AI daily budget reached');
      throw new AIError('ただいまAIの利用が集中しています。時間をおいて再度お試しください。');
    }
  },
  onUsage: (u) => repo.recordUsage(u),
});

const app = createApp({
  repo,
  ai,
  config,
  mailer: createMailer(config),
  billing: createBilling(config, repo),
  // Local development without a mail service: show the login link on screen.
  exposeLoginLink: !config.production && !config.mail.resendApiKey,
});
const server = app.listen(config.port, () => {
  console.log(`comsapo listening on ${config.appUrl} (port ${config.port}, AI: ${ai.mode}, billing: ${config.billingEnabled ? 'on' : 'off'})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => {
    repo.close();
    process.exit(0);
  }));
}
