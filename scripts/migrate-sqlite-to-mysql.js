const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const mysql = require('mysql2/promise');

if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) throw new Error('Defina DB_HOST, DB_USER, DB_PASSWORD e DB_NAME antes de migrar.');

(async () => {
  const source = new DatabaseSync(path.join(__dirname, '..', 'data', 'guias.db'), { readOnly: true });
  const target = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  await target.beginTransaction();
  try {
    for (const row of source.prepare('SELECT id, username, password_hash FROM users').all()) await target.execute('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), password_hash=VALUES(password_hash)', Object.values(row));
    for (const row of source.prepare('SELECT number, ocs, patient, billed, specialty, crm, created_at FROM guides').all()) await target.execute('INSERT INTO guides (number, ocs, patient, billed, specialty, crm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE ocs=VALUES(ocs), patient=VALUES(patient), billed=VALUES(billed), specialty=VALUES(specialty), crm=VALUES(crm)', Object.values(row));
    for (const row of source.prepare('SELECT id, guide_number, module, specification, specialty, crm, justification, amount FROM guide_items').all()) await target.execute('INSERT INTO guide_items (id, guide_number, module, specification, specialty, crm, justification, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE guide_number=VALUES(guide_number), module=VALUES(module), specification=VALUES(specification), specialty=VALUES(specialty), crm=VALUES(crm), justification=VALUES(justification), amount=VALUES(amount)', Object.values(row));
    await target.commit();
    console.log('Migração concluída.');
  } catch (error) { await target.rollback(); throw error; } finally { await target.end(); source.close(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
