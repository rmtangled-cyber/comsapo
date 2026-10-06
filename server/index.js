import path from 'node:path';
import { createStore } from './store.js';
import { createAI } from './ai.js';
import { createApp } from './app.js';

const store = createStore(process.env.DATA_FILE || path.resolve('data', 'db.json'));
// Busy flags guard in-flight AI calls; a restart means nothing is in flight.
for (const talk of Object.values(store.db.talks)) {
  for (const p of Object.values(talk.participants)) p.busy = false;
  if (talk.status === 'synthesizing') {
    talk.status = 'error';
    talk.error = 'サーバー再起動により中断されました。再実行してください。';
  }
}
const ai = createAI();
const app = createApp({ store, ai });
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`comsapo listening on http://localhost:${port} (AI: ${ai.mode})`);
});
