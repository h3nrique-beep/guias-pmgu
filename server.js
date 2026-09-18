const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8081);
const MODULES = [
  'Ajuste de honorários', 'Ajuste de exame laboratorial', 'Ajuste de exame de imagem',
  'Glosa de honorário médico', 'Glosa de taxa', 'Glosa de material', 'Glosa de medicamento',
  'Glosa de exame de imagem', 'Glosa de exame laboratorial', 'Glosa de nutrição', 'Glosa de OPME', 'Glosa de fisioterapia',
];
const sessions = new Map();
const db = new DatabaseSync(path.join(ROOT, 'data', 'guias.db'));

db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS guides (number INTEGER PRIMARY KEY, ocs TEXT NOT NULL, patient TEXT NOT NULL, billed TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS guide_items (id INTEGER PRIMARY KEY, guide_number INTEGER NOT NULL, module TEXT NOT NULL, specification TEXT NOT NULL, specialty TEXT NOT NULL DEFAULT '', crm TEXT NOT NULL DEFAULT '', justification TEXT NOT NULL, amount TEXT NOT NULL, FOREIGN KEY (guide_number) REFERENCES guides(number));`);
for (const [table, column] of [['guides', 'specialty'], ['guides', 'crm'], ['guide_items', 'specialty'], ['guide_items', 'crm']]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
}
db.exec(`UPDATE guide_items SET specialty=COALESCE((SELECT specialty FROM guides WHERE number=guide_number), '') WHERE specialty='';
  UPDATE guide_items SET crm=COALESCE((SELECT crm FROM guides WHERE number=guide_number), '') WHERE crm='';`);

function hash(password, salt = crypto.randomBytes(16)) {
  return `${salt.toString('base64')}:${crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('base64')}`;
}
function passwordMatches(password, saved) {
  const [salt, value] = String(saved || '').split(':');
  if (!salt || !value) return false;
  return crypto.timingSafeEqual(crypto.pbkdf2Sync(password, Buffer.from(salt, 'base64'), 120000, 32, 'sha256'), Buffer.from(value, 'base64'));
}
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', hash('admin123'));

const escape = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
const isHonor = (module) => module.includes('honorário');
const cookie = (request, name) => Object.fromEntries((request.headers.cookie || '').split(';').map((part) => part.trim().split('=')))[name];
const json = (response, status, value, headers = {}) => response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(value));
const fail = (response, status, message) => json(response, status, { error: message });
const authenticated = (request) => { const session = sessions.get(cookie(request, 'PMGU_SESSION')); return session && session.expires > Date.now() ? session : null; };
const query = (request) => new URL(request.url, `http://${request.headers.host}`).searchParams;

function body(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => { data += chunk; if (data.length > 1_000_000) request.destroy(); });
    request.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Dados inválidos.')); } });
    request.on('error', reject);
  });
}
function guide(id) {
  const data = db.prepare('SELECT number, ocs, patient, billed FROM guides WHERE number=?').get(id);
  if (!data) return null;
  data.items = db.prepare('SELECT module, specification, specialty, crm, justification, amount FROM guide_items WHERE guide_number=? ORDER BY id').all(id).map((item) => ({ ...item, amount: Number(item.amount) }));
  data.billed = Number(data.billed);
  return data;
}
function listGuides() { return db.prepare('SELECT number, ocs, patient, billed, created_at FROM guides ORDER BY number DESC LIMIT 100').all().map((item) => ({ ...item, billed: Number(item.billed) })); }
function totals(items, billed) {
  const glosa = items.filter((item) => item.module.startsWith('Glosa')).reduce((sum, item) => sum + Number(item.amount), 0);
  const ajuste = items.filter((item) => item.module.startsWith('Ajuste')).reduce((sum, item) => sum + Number(item.amount), 0);
  return { glosa, ajuste, auditado: Number(billed) - glosa - ajuste };
}
function reportPage(data) { return reportPageBody(data).replace('</head>', '<style>@page{size:A4;margin:11.09mm 9.42mm 14.94mm 10.81mm}*{box-sizing:border-box}body{width:auto!important;margin:0!important;padding:0!important}table{max-width:100%!important}h3{text-transform:uppercase!important;border:1px solid #000;border-bottom:0;margin:12px 0 0!important;padding:2px}h3+table{margin-top:0!important}table:not(.summary){table-layout:fixed}table:not(.summary) th:nth-child(1),table:not(.summary) td:nth-child(1){width:5.25%}table:not(.summary) th:nth-child(2),table:not(.summary) td:nth-child(2){width:37.22%}table:not(.summary) th:nth-child(3),table:not(.summary) td:nth-child(3){width:46.84%}table:not(.summary) th:nth-child(4),table:not(.summary) td:nth-child(4){width:10.69%}</style></head>'); }
function reportPageBody(data) {
  const summary = totals(data.items, data.billed);
  const sections = ['Ajuste', 'Glosa'].map((prefix) => {
    const groups = MODULES.filter((module) => module.startsWith(prefix)).map((module) => [module, data.items.filter((item) => item.module === module)]).filter(([, items]) => items.length);
    if (!groups.length) return '';
    return `<h2>RELATÓRIO DE ${prefix.toUpperCase()}</h2>${groups.map(([module, items]) => {
      const honor = isHonor(module); const total = items.reduce((sum, item) => sum + Number(item.amount), 0); const label = module === 'Ajuste de honorários' ? 'Honorários - Ajuste' : module.toUpperCase();
      return `<h3>${escape(label)}</h3><table><thead><tr><th>Item</th><th>Especificação</th><th>Justificativa</th><th>${prefix}</th></tr></thead><tbody>${items.map((item, index) => { const details = [item.specification, honor && item.specialty, honor && item.crm ? `CRM: ${item.crm}` : ''].filter(Boolean).join(' - '); return `<tr><td>${index + 1}</td><td>${escape(details)}</td><td>${escape(item.justification).replaceAll('\n', '<br>')}</td><td class="money">${money(item.amount)}</td></tr>`; }).join('')}</tbody><tfoot><tr><th colspan="3">Total de ${escape(label)}</th><th class="money">${money(total)}</th></tr></tfoot></table>`;
    }).join('')}`;
  }).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Glosa e Ajuste</title><style>body{width:190mm;margin:0 auto;padding:9mm;font:9pt 'Times New Roman',serif;color:#000}.official{text-align:center;font:700 8pt Arial;line-height:1.2;margin-bottom:9px}.official img{display:block;width:24px;max-height:32px;object-fit:contain;margin:auto}.identity{font-weight:700;line-height:1.35}h2,h3{text-align:center}h2{font-size:12pt;margin:18px 0 8px}h3{font-size:10pt;margin:12px 0 4px}table{border-collapse:collapse;width:100%;margin:6px 0 12px}th,td{border:1px solid #000;padding:3px;vertical-align:top;text-align:left}th{text-align:center}.summary{table-layout:fixed}.summary th:nth-child(1),.summary td:nth-child(1){width:14.35%}.summary th:nth-child(2),.summary td:nth-child(2){width:14.35%}.summary th:nth-child(3),.summary td:nth-child(3){width:11.67%}.summary th:nth-child(4),.summary td:nth-child(4){width:14.91%}.summary th:nth-child(5),.summary td:nth-child(5){width:44.72%}.summary td{height:54px}.observation{font-size:8pt}.money{text-align:right;white-space:nowrap}tfoot th{text-align:right}@media print{body{margin:0}}</style></head><body><div class="official"><img src="/template-logo.png" alt="Exército Brasileiro">MINISTÉRIO DA DEFESA<br>EXÉRCITO BRASILEIRO<br>CMDO 15ª BDA INF MEC</div><p class="identity">OCS: ${escape(data.ocs)}<br>PACIENTE: ${escape(data.patient)}<br>GUIA Nº: ${escape(data.number)}</p><table class="summary"><thead><tr><th>Valor<br>Apresentado</th><th>Glosa</th><th>Ajuste</th><th>Valor<br>Auditado</th><th>Observação</th></tr></thead><tbody><tr><td class="money">${money(data.billed)}</td><td class="money">${money(summary.glosa)}</td><td class="money">${money(summary.ajuste)}</td><td class="money">${money(summary.auditado)}</td><td class="observation">Com relação às glosas e possíveis recursos, favor cumprir rigorosamente os prazos e procedimentos previstos nas cláusulas 7.1.21 até a cláusula 7.1.31 do Termo de Contrato celebrado entre as partes.</td></tr></tbody></table>${sections}<p style="margin-top:26px">Quartel em Cascavel-PR, ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}</p><div style="display:flex;gap:20px;margin-top:38px;font:9pt Arial"><div style="width:45%;border-top:1px solid;text-align:center;padding-top:4px">Médico Auditor da Seção de Auditoria de Contas Médicas</div><div style="width:45%;border-top:1px solid;text-align:center;padding-top:4px">Enfermeira Auditora da Seção de Auditoria de Contas Médicas</div></div><script>window.print()</script></body></html>`;
}
function save(data) {
  const ocs = String(data.ocs || '').trim(), patient = String(data.patient || '').trim(), billed = Number(data.billed || 0);
  if (!ocs || !patient) throw new Error('Informe OCS e paciente.');
  if (!Number.isFinite(billed) || billed < 0) throw new Error('Valor apresentado inválido.');
  if (!Array.isArray(data.items) || !data.items.length) throw new Error('Inclua pelo menos um item.');
  const items = data.items.map((item) => {
    const module = String(item.module || ''); const amount = Number(item.amount || 0);
    if (!MODULES.includes(module) || !String(item.specification || '').trim() || !String(item.justification || '').trim() || !Number.isFinite(amount) || amount < 0) throw new Error('Preencha os campos obrigatórios de cada item.');
    return { module, specification: String(item.specification).trim(), specialty: isHonor(module) ? String(item.specialty || '').trim() : '', crm: isHonor(module) ? String(item.crm || '').trim() : '', justification: String(item.justification).trim(), amount: amount.toFixed(2) };
  });
  db.exec('BEGIN');
  try {
    let id = Number(data.number || 0);
    if (id) db.prepare('UPDATE guides SET ocs=?, patient=?, billed=? WHERE number=?').run(ocs, patient, billed.toFixed(2), id);
    else id = Number(db.prepare('INSERT INTO guides (ocs, patient, billed) VALUES (?, ?, ?) RETURNING number').get(ocs, patient, billed.toFixed(2)).number);
    db.prepare('DELETE FROM guide_items WHERE guide_number=?').run(id);
    const insert = db.prepare('INSERT INTO guide_items (guide_number, module, specification, specialty, crm, justification, amount) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const item of items) insert.run(id, item.module, item.specification, item.specialty, item.crm, item.justification, item.amount);
    db.exec('COMMIT'); return guide(id);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function serve(response, file, type) { response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(fs.readFileSync(file)); }

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`); const pathname = url.pathname;
    if (pathname === '/styles.css') return serve(response, path.join(ROOT, 'public', 'styles.css'), 'text/css; charset=utf-8');
    if (pathname === '/app.js') return serve(response, path.join(ROOT, 'public', 'app.js'), 'application/javascript; charset=utf-8');
    if (pathname === '/template-logo.png') return serve(response, path.join(ROOT, 'public', 'template-logo.png'), 'image/png');
    if (pathname === '/pmgu-csc.png') return serve(response, path.join(ROOT, 'public', 'pmgu-csc.png'), 'image/png');
    if (pathname === '/sisglosa.jpg') return serve(response, path.join(ROOT, 'public', 'sisglosa.jpg'), 'image/jpeg');
    if (pathname === '/' || pathname === '/index.html') return serve(response, path.join(ROOT, 'public', 'index.html'), 'text/html; charset=utf-8');
    if (pathname === '/api/login' && request.method === 'POST') { const data = await body(request); const saved = db.prepare('SELECT password_hash FROM users WHERE username=?').get(String(data.username || '')); if (!saved || !passwordMatches(String(data.password || ''), saved.password_hash)) return fail(response, 401, 'Usuário ou senha inválidos.'); const id = crypto.randomUUID(); sessions.set(id, { username: data.username, expires: Date.now() + 8 * 60 * 60 * 1000 }); return json(response, 200, { username: data.username }, { 'Set-Cookie': `PMGU_SESSION=${id}; HttpOnly; SameSite=Lax; Path=/` }); }
    if (pathname === '/api/logout' && request.method === 'POST') { sessions.delete(cookie(request, 'PMGU_SESSION')); return json(response, 200, {}, { 'Set-Cookie': 'PMGU_SESSION=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/' }); }
    const session = authenticated(request); if (!session) return fail(response, 401, 'Sessão expirada.');
    if (pathname === '/api/session') return json(response, 200, { username: session.username });
    if (pathname === '/api/guides' && request.method === 'GET') return json(response, 200, listGuides());
    if (pathname === '/api/guides' && request.method === 'POST') return json(response, 201, save(await body(request)));
    if (pathname === '/api/options/ocs') return json(response, 200, db.prepare("SELECT DISTINCT ocs FROM guides WHERE trim(ocs)<>'' ORDER BY ocs").all().map((row) => row.ocs));
    if (pathname === '/api/options/specifications') return json(response, 200, db.prepare('SELECT DISTINCT specification FROM guide_items WHERE module=? ORDER BY specification').all(url.searchParams.get('module') || '').map((row) => row.specification));
    if (pathname === '/api/users' && request.method === 'POST') { const data = await body(request); if (!/^[A-Za-z0-9._-]{3,40}$/.test(data.username || '') || String(data.password || '').length < 6) return fail(response, 400, 'Usuário: 3–40 caracteres; senha: mínimo 6 caracteres.'); try { db.prepare('INSERT INTO users (username,password_hash) VALUES (?,?)').run(data.username, hash(data.password)); return json(response, 201, {}); } catch { return fail(response, 409, 'Usuário já existe.'); } }
    const match = pathname.match(/^\/api\/guides\/(\d+)(\/report)?$/); if (match) { const data = guide(Number(match[1])); if (!data) return fail(response, 404, 'Guia não encontrada.'); if (match[2]) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(reportPage(data)); } if (request.method === 'GET') return json(response, 200, data); if (request.method === 'DELETE') { db.prepare('DELETE FROM guide_items WHERE guide_number=?').run(data.number); db.prepare('DELETE FROM guides WHERE number=?').run(data.number); return json(response, 200, {}); } }
    return fail(response, 404, 'Rota não encontrada.');
  } catch (error) { console.error(error); return fail(response, 400, error.message || 'Não foi possível concluir a operação.'); }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Guias PMGU moderno: http://localhost:${PORT}`));
