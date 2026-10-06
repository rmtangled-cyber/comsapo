// Minimal JSON-file persistence. Good enough for the MVP; swap for a real DB later.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = () => ({ users: {}, relationships: {}, talks: {}, memories: {} });

export function createStore(file) {
  let db = EMPTY();
  if (file && fs.existsSync(file)) {
    db = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }

  let pending = null;
  function save() {
    if (!file) return;
    // Coalesce bursts of writes into one atomic rename.
    if (pending) return;
    pending = setImmediate(() => {
      pending = null;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, file);
    });
  }

  return { db, save };
}

export const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
