'use strict';
/* ExpenseFlow — PWA de gestion de notes de frais. Données 100 % locales (IndexedDB). */

// ---------- constantes ----------
const CATS = {
  meals:    { label: 'Repas & Restauration',  short: 'Alimentation',  icon: 'restaurant',     color: '#10B981', bg: '#d1fae5' },
  travel:   { label: 'Transport',             short: 'Transport',     icon: 'directions_car', color: '#1e3a8a', bg: '#dce1ff' },
  lodging:  { label: 'Hébergement',           short: 'Hébergement',   icon: 'hotel',          color: '#7c3aed', bg: '#ede9fe' },
  supplies: { label: 'Fournitures de bureau', short: 'Fournitures',   icon: 'inventory_2',    color: '#ef9900', bg: '#ffddb8' },
  other:    { label: 'Autre',                 short: 'Autre',         icon: 'receipt_long',   color: '#757682', bg: '#e5eeff' },
};
const STATUS = {
  pending:  { label: 'En attente', cls: 'b-pending' },
  approved: { label: 'Approuvé',   cls: 'b-ok' },
  rejected: { label: 'Refusé',     cls: 'b-ko' },
};
const DEFAULTS = { name: '', budget: 2000, provider: 'local', apiKey: '', model: 'claude-haiku-5-5' };

// ---------- utilitaires ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = n => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n || 0);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtDate = s => parseYmd(s).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const ic = (n, cls = '') => `<span class="ms ${cls}">${n}</span>`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- réglages ----------
const Settings = {
  get() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ef_settings') || '{}') }; }
    catch { return { ...DEFAULTS }; }
  },
  set(patch) {
    try { localStorage.setItem('ef_settings', JSON.stringify({ ...this.get(), ...patch })); } catch { /* stockage indisponible */ }
  },
};

// ---------- base de données ----------
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('expenseflow', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('expenses', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('expenses', mode);
      const rq = fn(t.objectStore('expenses'));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('readonly', s => s.getAll()); },
  put(e) { return this.tx('readwrite', s => s.put(e)); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); },
  clear() { return this.tx('readwrite', s => s.clear()); },
};

let expenses = [];
async function reload() {
  expenses = (await DB.all()).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
}

// ---------- calculs ----------
const counted = list => list.filter(e => e.status !== 'rejected');
const sum = list => list.reduce((t, e) => t + e.amount, 0);
const inRange = (list, from, to) => list.filter(e => e.date >= from && e.date <= to);

function periodRanges(kind) {
  const now = new Date(), today = ymd(now);
  if (kind === 'week') {
    return { from: ymd(addDays(now, -6)), to: today, pFrom: ymd(addDays(now, -13)), pTo: ymd(addDays(now, -7)), days: 7, budgetFactor: 12 / 52, label: 'la semaine précédente' };
  }
  if (kind === 'year') {
    const y = now.getFullYear();
    const start = new Date(y, 0, 1);
    return { from: `${y}-01-01`, to: `${y}-12-31`, pFrom: `${y - 1}-01-01`, pTo: `${y - 1}-12-31`, days: Math.floor((now - start) / 864e5) + 1, budgetFactor: 12, label: "l'année précédente" };
  }
  const y = now.getFullYear(), m = now.getMonth();
  const pm = new Date(y, m - 1, 1);
  return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)), pFrom: ymd(pm), pTo: ymd(new Date(y, m, 0)), days: now.getDate(), budgetFactor: 1, label: 'le mois précédent' };
}

// ---------- rendu / routeur ----------
const app = $('#app');
let currentCleanup = null;

function render({ title, brand, back, right = '', html, nav = true, active = '' }) {
  const S = Settings.get();
  const initial = (S.name || 'E').trim().charAt(0).toUpperCase();
  app.innerHTML = `
    <div class="app">
      <header class="top"><div class="in">
        <div class="row">
          ${back ? `<button class="icon-btn" data-back aria-label="Retour">${ic('arrow_back')}</button>` : ''}
          <h1 class="${brand ? 'brand' : ''}">${esc(title)}</h1>
        </div>
        <div class="row">${right || (brand ? `<a href="#/profile" class="avatar" aria-label="Profil">${esc(initial)}</a>` : '')}</div>
      </div></header>
      <main>${html}</main>
    </div>
    ${nav ? navHtml(active) : ''}`;
  const b = $('[data-back]');
  if (b) b.onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/history'));
  window.scrollTo(0, 0);
}

function navHtml(active) {
  const it = (h, icon, label) => `<a href="#/${h}" class="${active === h ? 'on' : ''}">${ic(icon)}<span>${label}</span></a>`;
  return `<nav class="nav">
    ${it('dashboard', 'dashboard', 'Dashboard')}
    ${it('history', 'history', 'Historique')}
    <a href="#/scan" class="scan" aria-label="Scanner"><b>${ic('qr_code_scanner')}</b><span class="lbl">Scan</span></a>
    ${it('stats', 'query_stats', 'Stats')}
    ${it('profile', 'person', 'Profil')}
  </nav>`;
}

const routes = {};
async function route() {
  if (currentCleanup) { currentCleanup(); currentCleanup = null; }
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const fn = routes[name] || routes.dashboard;
  fn(arg);
}
window.addEventListener('hashchange', route);

// ---------- composants ----------
function rowHtml(e) {
  const c = CATS[e.category] || CATS.other, s = STATUS[e.status] || STATUS.pending;
  return `<a class="item" href="#/expense/${e.id}">
    <div class="row grow"><div class="ico">${ic(c.icon)}</div>
      <div class="grow"><p class="name">${esc(e.merchant)}</p><p class="label">${esc(c.short)} • ${fmtDate(e.date)}</p></div></div>
    <div class="right"><p class="amt">${eur(e.amount)}</p><span class="badge ${s.cls}">${s.label}</span></div>
  </a>`;
}

// ---------- DASHBOARD ----------
routes.dashboard = function () {
  const S = Settings.get();
  const now = new Date(), key = ymd(now).slice(0, 7);
  const month = expenses.filter(e => e.date.startsWith(key));
  const total = sum(counted(month));
  const pending = sum(month.filter(e => e.status === 'pending'));
  const approved = sum(month.filter(e => e.status === 'approved'));
  const pct = S.budget > 0 ? Math.round(total / S.budget * 100) : 0;
  const monthName = now.toLocaleDateString('fr-FR', { month: 'long' });
  const hello = S.name ? `Bonjour, ${esc(S.name)}` : 'Bonjour';

  const body = expenses.length === 0 ? `
    <section class="mb24"><h2 class="sec mb8">${hello}</h2><p class="muted">Aucune dépense pour le moment.</p></section>
    <div class="card empty">${ic('receipt_long')}
      <h2 class="sec mb8">Commencez par scanner un ticket</h2>
      <p class="muted mb16">Prenez en photo un ticket de caisse : le montant, la date et le commerçant sont lus automatiquement.</p>
      <div class="stack"><a class="btn pri" href="#/scan">${ic('qr_code_scanner')} Scanner un ticket</a>
      <a class="btn ghost" href="#/new">${ic('edit')} Saisie manuelle</a>
      <button class="btn ghost" id="demo">${ic('science')} Charger des données de démo</button></div>
    </div>` : `
    <section class="mb24"><h2 class="sec mb8">${hello}</h2><p class="muted">Voici un aperçu de vos dépenses ce mois-ci.</p></section>
    <div class="card mb16">
      <p class="label mb8">Total dépenses (${esc(monthName)})</p>
      <p class="big">${eur(total)}</p>
      <div class="mt24">
        <div class="row between mb8"><span class="label">Budget mensuel · ${eur(S.budget)}</span><span class="label" style="color:${pct > 100 ? 'var(--err)' : 'var(--sec)'}">${pct}% utilisé</span></div>
        <div class="bar ${pct > 100 ? 'over' : ''}"><i style="width:${Math.min(100, pct)}%"></i></div>
      </div>
    </div>
    <div class="card mb24">
      <p class="label mb16">Statut des remboursements</p>
      <div class="stack">
        <div class="stat-row"><span><i class="dot" style="background:#f59e0b"></i>En attente</span><b style="font-size:20px">${eur(pending)}</b></div>
        <div class="stat-row"><span><i class="dot" style="background:#10b981"></i>Approuvé</span><b style="font-size:20px">${eur(approved)}</b></div>
      </div>
      <a class="link row mt16" style="justify-content:center" href="#/history">Détails complets ${ic('chevron_right', 'xs')}</a>
    </div>
    <section>
      <div class="row between mb16"><h2 class="sec">Dépenses récentes</h2><a class="link" href="#/history">Voir tout</a></div>
      <div class="stack16">${expenses.slice(0, 5).map(rowHtml).join('')}</div>
      <a class="btn ghost mt24" href="#/new">${ic('add')} Saisie manuelle</a>
    </section>`;

  render({ title: 'ExpenseFlow', brand: true, html: body, active: 'dashboard' });
  const d = $('#demo');
  if (d) d.onclick = async () => { await loadDemo(); toast('Données de démo chargées'); route(); };
};

// ---------- HISTORIQUE ----------
const hf = { q: '', week: false, status: null, cat: null };
routes.history = function () {
  const statusKeys = [null, 'pending', 'approved', 'rejected'];
  const catKeys = [null, ...Object.keys(CATS)];
  const html = `
    <div class="search field mb16">${ic('search')}<input id="q" class="inp pl" type="search" placeholder="Rechercher un marchand ou un montant..." value="${esc(hf.q)}"></div>
    <div class="chips mb24">
      <button class="chip ${hf.week || hf.status || hf.cat || hf.q ? 'on' : ''}" id="reset">${ic('tune', 'sm')} Filtres</button>
      <button class="chip ${hf.week ? 'on' : ''}" id="fweek">Cette semaine</button>
      <button class="chip ${hf.status ? 'on' : ''}" id="fstatus">${hf.status ? STATUS[hf.status].label : 'Statut'}</button>
      <button class="chip ${hf.cat ? 'on' : ''}" id="fcat">${hf.cat ? CATS[hf.cat].short : 'Catégories'}</button>
    </div>
    <div id="hlist"></div>`;
  render({ title: 'Historique', brand: false, html, active: 'history' });

  const list = () => {
    const wFrom = ymd(addDays(new Date(), -6));
    const q = hf.q.trim().toLowerCase().replace(',', '.');
    const rows = expenses.filter(e =>
      (!hf.week || e.date >= wFrom) && (!hf.status || e.status === hf.status) && (!hf.cat || e.category === hf.cat) &&
      (!q || e.merchant.toLowerCase().includes(q) || e.amount.toFixed(2).includes(q)));
    const box = $('#hlist');
    if (!rows.length) { box.innerHTML = `<div class="empty">${ic('search_off')}<p class="muted">Aucune dépense ne correspond.</p></div>`; return; }
    const today = ymd(new Date()), yest = ymd(addDays(new Date(), -1));
    const groups = [];
    for (const e of rows) {
      const g = e.date === today ? "Aujourd'hui" : e.date === yest ? 'Hier'
        : cap(parseYmd(e.date).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));
      const last = groups[groups.length - 1];
      if (last && last.g === g) last.rows.push(e); else groups.push({ g, rows: [e] });
    }
    box.innerHTML = groups.map(x => `<h2 class="label group-title">${esc(x.g)}</h2><div class="stack16">${x.rows.map(rowHtml).join('')}</div>`).join('');
  };
  list();
  $('#q').oninput = e => { hf.q = e.target.value; list(); };
  $('#reset').onclick = () => { Object.assign(hf, { q: '', week: false, status: null, cat: null }); routes.history(); };
  $('#fweek').onclick = () => { hf.week = !hf.week; routes.history(); };
  $('#fstatus').onclick = () => { hf.status = statusKeys[(statusKeys.indexOf(hf.status) + 1) % statusKeys.length]; routes.history(); };
  $('#fcat').onclick = () => { hf.cat = catKeys[(catKeys.indexOf(hf.cat) + 1) % catKeys.length]; routes.history(); };
};

// ---------- STATISTIQUES ----------
let statsKind = 'month';
routes.stats = function () {
  const S = Settings.get();
  const r = periodRanges(statsKind);
  const cur = counted(inRange(expenses, r.from, r.to));
  const prev = counted(inRange(expenses, r.pFrom, r.pTo));
  const total = sum(cur), ptotal = sum(prev);
  const delta = ptotal > 0 ? Math.round((total - ptotal) / ptotal * 100) : null;
  const vatTotal = cur.reduce((s, e) => s + (e.vat || 0), 0);
  const budget = S.budget * r.budgetFactor;
  const bpct = budget > 0 ? Math.round(total / budget * 100) : 0;

  const byCat = Object.keys(CATS).map(k => {
    const l = cur.filter(e => e.category === k), p = sum(prev.filter(e => e.category === k));
    const t = sum(l);
    return { k, n: l.length, t, trend: p > 0 ? Math.round((t - p) / p * 100) : null };
  }).filter(c => c.n > 0).sort((a, b) => b.t - a.t);

  let offset = 0;
  const segs = byCat.map(c => {
    const share = total > 0 ? c.t / total * 100 : 0;
    const s = `<circle cx="18" cy="18" r="15.915" fill="transparent" stroke="${CATS[c.k].color}" stroke-width="4.5" stroke-dasharray="${share} ${100 - share}" stroke-dashoffset="${-offset}"></circle>`;
    offset += share; return s;
  }).join('');

  const html = `
    <section class="row mb24" style="justify-content:center">
      <div class="seg">${[['week', 'Hebdo'], ['month', 'Mensuel'], ['year', 'Annuel']].map(([k, l]) => `<button data-k="${k}" class="${statsKind === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    </section>
    <div class="card lg mb16">
      <p class="label mb8">Dépenses totales</p>
      <p class="big">${eur(total)}</p>
      ${delta === null ? '' : `<div class="mt16"><span class="pill-trend ${delta > 0 ? 'up' : ''}">${ic(delta > 0 ? 'trending_up' : 'trending_down', 'xs')} ${Math.abs(delta)}% vs ${r.label}</span></div>`}
      <div class="row between mt24" style="padding-top:24px;border-top:1px solid var(--outv)">
        <div><p class="label">Moyenne journalière</p><p class="sec">${eur(total / r.days)}</p></div>
        <div style="text-align:center"><p class="label">Dont TVA</p><p class="sec">${eur(vatTotal)}</p></div>
        <div class="right"><p class="label">Transactions</p><p class="sec">${cur.length}</p></div>
      </div>
    </div>
    <div class="card lg mb16">
      <h2 class="sec mb24">Par catégorie</h2>
      ${byCat.length ? `
      <div class="donut"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.915" fill="transparent" stroke="#e5eeff" stroke-width="3"></circle>${segs}</svg>
        <div class="mid"><span class="label">Principale</span><span class="sec" style="font-size:24px;color:var(--primary)">${esc(CATS[byCat[0].k].short)}</span></div></div>
      <div class="legend">${byCat.map(c => `<div class="row" style="gap:0"><i class="dot" style="background:${CATS[c.k].color}"></i><span>${esc(CATS[c.k].short)} (${Math.round(c.t / total * 100)}%)</span></div>`).join('')}</div>`
        : `<p class="muted" style="text-align:center">Aucune dépense sur cette période.</p>`}
    </div>
    <div class="card lg mb24">
      <div class="row between mb16"><h2 class="sec">Suivi du budget</h2>
        <span class="pill-trend ${bpct > 100 ? 'up' : ''}">${bpct > 100 ? 'Dépassé' : bpct >= 80 ? 'Attention' : 'Sur la bonne voie'}</span></div>
      <div class="row between mb8 muted"><span>Dépensé : ${eur(total)}</span><span>Objectif : ${eur(budget)}</span></div>
      <div class="bar thick ${bpct > 100 ? 'over' : ''}"><i style="width:${Math.min(100, bpct)}%"></i></div>
    </div>
    <section class="mb24">
      <h2 class="sec mb16">Top catégories</h2>
      <div class="stack">${byCat.map(c => `
        <div class="item" style="cursor:default"><div class="row grow"><div class="cat-ico" style="background:${CATS[c.k].bg};color:${CATS[c.k].color}">${ic(CATS[c.k].icon)}</div>
          <div><p class="sec" style="font-size:18px">${esc(CATS[c.k].short)}</p><p class="muted">${c.n} transaction${c.n > 1 ? 's' : ''}</p></div></div>
          <div class="right"><p class="amt">${eur(c.t)}</p>
          ${c.trend === null ? '' : `<p class="label" style="color:${c.trend > 0 ? 'var(--err)' : 'var(--onsecc)'}">${c.trend > 0 ? '↑' : c.trend < 0 ? '↓' : '='} ${Math.abs(c.trend)}%</p>`}</div></div>`).join('') || '<p class="muted">Rien à afficher.</p>'}</div>
    </section>
    <section class="banner"><p class="sec" style="max-width:220px">Besoin de rapports détaillés ?</p>
      <button id="pdf">Exporter en PDF</button> <button id="csv">Exporter en CSV</button></section>`;

  render({ title: 'Statistiques', brand: false, html, active: 'stats' });
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { statsKind = b.dataset.k; routes.stats(); });
  $('#pdf').onclick = () => window.print();
  $('#csv').onclick = () => exportCsv();
};

// ---------- FORMULAIRE (saisie / validation) ----------
let draft = null;        // dépense en cours d'édition
let draftIsNew = false;

function newDraft(image) {
  return { id: uid(), merchant: '', amount: '', date: ymd(new Date()), category: 'other', status: 'pending', notes: '', vat: '', vatRate: '', image: image || null, ocrSource: null, confidence: null, createdAt: Date.now(), dirty: new Set(), ocr: image ? 'running' : 'none', ocrMsg: '' };
}

routes.new = function () { draft = newDraft(null); draftIsNew = true; location.replace('#/review'); };

routes.expense = function (id) {
  const e = expenses.find(x => x.id === id);
  if (!e) { toast('Dépense introuvable'); location.replace('#/history'); return; }
  draft = { ...e, amount: String(e.amount).replace('.', ','), vat: e.vat != null ? fmtNum(e.vat) : '', vatRate: e.vatRate != null ? String(e.vatRate).replace('.', ',') : '', ocrSource: null, dirty: new Set(), ocr: 'none', ocrMsg: '' };
  draftIsNew = false;
  location.replace('#/review');
};

routes.review = function () {
  if (!draft) { location.replace('#/dashboard'); return; }
  const d = draft;
  const imgUrl = d.image ? URL.createObjectURL(d.image) : null;
  const html = `
    ${imgUrl ? `<section class="mb24"><div class="receipt" id="rcpt"><img src="${imgUrl}" alt="Ticket"><div class="cap">${ic('visibility', 'xs')} Touchez pour agrandir le ticket</div></div></section>` : ''}
    <section class="card lg">
      <div class="mb24"><h2 class="sec" style="color:var(--primary)">Détails de la transaction</h2>
        <p class="muted" id="hint">${draftIsNew ? 'Vérifiez les informations extraites automatiquement.' : 'Modifiez les informations puis enregistrez.'}</p></div>
      <div id="ocrbox"></div>
      <form id="frm" class="stack16" novalidate>
        <label class="f"><span class="label">Commerçant</span>
          <div class="field">${ic('store')}<input class="inp pl" id="merchant" type="text" value="${esc(d.merchant)}" autocomplete="off"></div></label>
        <div class="grid2">
          <label class="f"><span class="label">Montant (€)</span><input class="inp amount" id="amount" type="text" inputmode="decimal" value="${esc(d.amount)}" placeholder="0,00"></label>
          <label class="f"><span class="label">Date</span><input class="inp" id="date" type="date" value="${esc(d.date)}"></label>
        </div>
        <div class="grid2">
          <label class="f"><span class="label">TVA (€)</span><input class="inp" id="vat" type="text" inputmode="decimal" value="${esc(d.vat)}" placeholder="0,00"></label>
          <label class="f"><span class="label">Taux TVA (%)</span><input class="inp" id="vatRate" type="text" inputmode="decimal" value="${esc(d.vatRate)}" placeholder="ex. 10"></label>
        </div>
        <p class="muted" id="ht" style="margin-top:-8px"></p>
        <label class="f"><span class="label">Catégorie</span>
          <div class="field">${ic('category')}<select class="inp pl" id="category">${Object.entries(CATS).map(([k, c]) => `<option value="${k}" ${d.category === k ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>${ic('expand_more', 'r')}</div></label>
        <label class="f"><span class="label">Statut du remboursement</span>
          <div class="field">${ic('payments')}<select class="inp pl" id="status">${Object.entries(STATUS).map(([k, s]) => `<option value="${k}" ${d.status === k ? 'selected' : ''}>${s.label}</option>`).join('')}</select>${ic('expand_more', 'r')}</div></label>
        <label class="f"><span class="label">Notes</span><textarea class="inp" id="notes" placeholder="Motif, projet, participants…">${esc(d.notes)}</textarea></label>
        <div id="conf"></div>
        <div class="stack" style="padding-top:8px">
          <button class="btn pri" type="submit">${ic('check_circle', 'fill')} ${draftIsNew ? 'Valider' : 'Enregistrer'}</button>
          ${d.image ? `<button class="btn ghost" type="button" id="redo">${ic('refresh')} Retravailler</button>` : ''}
          ${draftIsNew ? '' : `<button class="btn danger" type="button" id="del">${ic('delete')} Supprimer</button>`}
        </div>
      </form>
    </section>`;
  render({ title: draftIsNew ? 'Validation de dépense' : 'Détails de la dépense', back: true, html, nav: false });

  paintOcrState();
  ['merchant', 'amount', 'vat', 'vatRate', 'date', 'category', 'status', 'notes'].forEach(k => {
    $('#' + k).addEventListener('input', e => { d[k] = e.target.value; d.dirty.add(k); updateHt(); });
  });
  updateHt();
  const r = $('#rcpt'); if (r) r.onclick = () => openLightbox(imgUrl);
  const redo = $('#redo'); if (redo) redo.onclick = () => { d.dirty.clear(); d.vat = ''; d.vatRate = ''; runOcr(); };
  const del = $('#del'); if (del) del.onclick = async () => {
    if (!confirm('Supprimer définitivement cette dépense ?')) return;
    await DB.del(d.id); await reload(); draft = null; toast('Dépense supprimée'); location.replace('#/history');
  };
  $('#frm').onsubmit = async ev => {
    ev.preventDefault();
    const amount = parseAmount(d.amount);
    if (!d.merchant.trim()) { toast('Indiquez le commerçant'); $('#merchant').focus(); return; }
    if (!(amount > 0)) { toast('Indiquez un montant valide'); $('#amount').focus(); return; }
    if (!d.date) { toast('Indiquez la date'); return; }
    const vat = parseAmount(d.vat), vatRate = parseAmount(d.vatRate);
    if (vat >= amount) { toast('La TVA doit être inférieure au montant'); $('#vat').focus(); return; }
    const rec = { id: d.id, merchant: d.merchant.trim(), amount, vat: vat > 0 ? vat : null, vatRate: vatRate > 0 ? vatRate : null, date: d.date, category: d.category, status: d.status, notes: d.notes.trim(), image: d.image, confidence: d.confidence, createdAt: d.createdAt };
    await DB.put(rec); await reload(); draft = null;
    toast(draftIsNew ? 'Dépense enregistrée' : 'Modifications enregistrées');
    location.replace('#/history');
  };
};

const fmtNum = n => n.toFixed(2).replace('.', ',');
function updateHt() {
  const el = $('#ht'); if (!el || !draft) return;
  const a = parseAmount(draft.amount), v = parseAmount(draft.vat);
  el.textContent = a > 0 && v > 0 && v < a ? `Montant HT : ${eur(a - v)}` : '';
}

function parseAmount(s) { return parseFloat(String(s).replace(/\s/g, '').replace(',', '.')); }

function paintOcrState() {
  const box = $('#ocrbox'), conf = $('#conf');
  if (!box || !draft) return;
  const d = draft;
  box.innerHTML = d.ocr === 'running'
    ? `<div class="ai mb16"><div class="c">${ic('progress_activity', 'spin')}</div><div class="grow"><b>Analyse du ticket…</b><p class="muted" id="ocrmsg">${esc(d.ocrMsg || 'Lecture du texte')}</p></div></div>`
    : d.ocr === 'error' ? `<div class="note warn mb16">${esc(d.ocrMsg)} — vous pouvez saisir les informations à la main.</div>` : '';
  const raw = d.rawText != null
    ? `<details class="note mb16" style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">Texte lu par l’OCR</summary><pre style="white-space:pre-wrap;font:12px/16px monospace;margin-top:8px">${esc(d.rawText.trim() || '(aucun texte détecté)')}</pre></details>` : '';
  conf.innerHTML = raw + (d.confidence != null
    ? `<div class="ai"><div class="c">${ic('auto_awesome')}</div><div class="grow"><div class="row between mb8"><span class="label" style="color:var(--sec)">Fiabilité de la lecture</span><b style="color:var(--sec)">${Math.round(d.confidence)}%</b></div><div class="bar"><i style="width:${Math.round(d.confidence)}%"></i></div></div></div>` : '');
}

function openLightbox(url) {
  const lb = $('#lightbox');
  lb.innerHTML = `<img src="${url}" alt="Ticket">`; lb.hidden = false;
  lb.onclick = () => { lb.hidden = true; lb.innerHTML = ''; };
}

// ---------- OCR ----------
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => rej(new Error('Module OCR indisponible (connexion internet nécessaire la première fois)'));
    document.head.appendChild(s);
  });
}

async function runOcr() {
  const d = draft; if (!d || !d.image) return;
  d.ocr = 'running'; d.ocrMsg = ''; if (location.hash === '#/review') paintOcrState();
  const S = Settings.get();
  try {
    let res;
    if (S.provider === 'claude' && S.apiKey) res = await ocrClaude(d.image, S);
    else {
      if (S.provider === 'claude') toast('Clé API absente : lecture locale utilisée');
      res = await ocrLocal(d.ocrSource || d.image, m => { d.ocrMsg = m; const el = $('#ocrmsg'); if (el && draft === d) el.textContent = m; });
    }
    if (draft !== d) return;
    applyOcr(d, res);
    d.ocr = 'done';
  } catch (err) {
    if (draft !== d) return;
    d.ocr = 'error'; d.ocrMsg = err.message || 'Lecture impossible';
  }
  if (location.hash === '#/review' && draft === d) { paintOcrState(); syncForm(); }
}

function applyOcr(d, r) {
  if (!d.dirty.has('merchant') && r.merchant) d.merchant = r.merchant;
  if (!d.dirty.has('amount') && r.amount > 0) d.amount = String(r.amount.toFixed(2)).replace('.', ',');
  if (!d.dirty.has('date') && r.date) d.date = r.date;
  if (!d.dirty.has('category') && r.category && CATS[r.category]) d.category = r.category;
  if (!d.dirty.has('vat')) d.vat = r.vat > 0 ? fmtNum(r.vat) : '';
  if (!d.dirty.has('vatRate')) d.vatRate = r.vatRate > 0 ? String(r.vatRate).replace('.', ',') : '';
  if (r.confidence != null) d.confidence = r.confidence;
  if (r.rawText != null) d.rawText = r.rawText;
}

function syncForm() {
  const d = draft; if (!d) return;
  for (const k of ['merchant', 'amount', 'vat', 'vatRate', 'date', 'category']) { const el = $('#' + k); if (el && !d.dirty.has(k)) el.value = d[k]; }
  updateHt();
}

// ---- prétraitement : trouve le ticket (clair sur fond sombre OU encre sur fond clair), uniformise l'éclairage ----
function otsu(hist, total) {
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sumB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

// seuillage local (image intégrale) : supprime ombres et dégradés d'une photo
function adaptiveBinary(g, w, h) {
  const win = Math.max(25, Math.round(Math.min(w, h) / 8)) | 1, r = win >> 1;
  const iw = w + 1, ii = new Uint32Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += g[y * w + x]; ii[(y + 1) * iw + x + 1] = ii[y * iw + x + 1] + row; }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = ii[y1 * iw + x1] - ii[y0 * iw + x1] - ii[y1 * iw + x0] + ii[y0 * iw + x0];
      out[y * w + x] = g[y * w + x] * (x1 - x0) * (y1 - y0) < s * 0.88 ? 0 : 255;
    }
  }
  return out;
}

function grayToCanvas(g, w, h, scale) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'), id = ctx.createImageData(w, h);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) { id.data[o] = id.data[o + 1] = id.data[o + 2] = g[i]; id.data[o + 3] = 255; }
  ctx.putImageData(id, 0, 0);
  if (scale === 1) return c;
  const b = document.createElement('canvas'); b.width = Math.round(w * scale); b.height = Math.round(h * scale);
  b.getContext('2d').drawImage(c, 0, 0, b.width, b.height);
  return b;
}

// retourne deux versions : recadrée sur le ticket (seuil local) et page entière (contraste étiré)
async function prepareImages(blob) {
  const bmp = await createImageBitmap(blob);
  const k0 = Math.min(1, 3500 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k0), h = Math.round(bmp.height * k0);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  const g = new Uint8Array(w * h), hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    const v = (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114) | 0;
    g[i] = v; hist[v]++;
  }
  const pct = q => { let acc = 0; const t = g.length * q; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= t) return v; } return 255; };

  // version « page entière » : contraste étiré
  const lo = pct(0.005), hi = Math.max(lo + 40, pct(0.9));
  const st = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) st[i] = Math.max(0, Math.min(255, ((g[i] - lo) * 255) / (hi - lo)));
  const full = grayToCanvas(st, w, h, Math.min(1, 2600 / Math.max(w, h)));

  // image binaire à seuil local (insensible aux ombres et aux dégradés)
  const bin = adaptiveBinary(g, w, h);

  // 1) zone de papier = plus grande zone claire (cellules de 16 px) ; 2) texte = cellules d'encre entourées d'autres cellules d'encre
  const S = 16, gw = Math.ceil(w / S), gh = Math.ceil(h / S);
  const sumv = new Float32Array(gw * gh), npx = new Uint16Array(gw * gh), ink = new Uint16Array(gw * gh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ci = (y >> 4) * gw + (x >> 4);
    npx[ci]++; sumv[ci] += g[y * w + x];
    if (!bin[y * w + x]) ink[ci]++;
  }
  const thr = otsu(hist, g.length);
  const bright = new Uint8Array(gw * gh);
  for (let i = 0; i < bright.length; i++) bright[i] = npx[i] && sumv[i] / npx[i] > thr ? 1 : 0;
  const seen = new Uint8Array(gw * gh); let comp = [];
  for (let s = 0; s < bright.length; s++) {
    if (!bright[s] || seen[s]) continue;
    const cur = [], stack = [s]; seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(); cur.push(i);
      const cx = i % gw, cy = (i / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const ni = ny * gw + nx;
        if (bright[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
      }
    }
    if (cur.length > comp.length) comp = cur;
  }
  let px0 = 0, py0 = 0, px1 = gw - 1, py1 = gh - 1;
  if (comp.length) {
    px0 = gw; py0 = gh; px1 = -1; py1 = -1;
    for (const i of comp) { const cx = i % gw, cy = (i / gw) | 0; if (cx < px0) px0 = cx; if (cx > px1) px1 = cx; if (cy < py0) py0 = cy; if (cy > py1) py1 = cy; }
  }
  const on = (cx, cy) => cx >= px0 && cx <= px1 && cy >= py0 && cy <= py1 && ink[cy * gw + cx] >= 4;
  let x0 = gw, y0 = gh, x1 = -1, y1 = -1;
  for (let cy = py0; cy <= py1; cy++) for (let cx = px0; cx <= px1; cx++) {
    if (!on(cx, cy)) continue;
    let n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && on(cx + dx, cy + dy)) n++;
    if (n < 4) continue;
    if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
  }
  // page presque entière claire (scan A4) : on se cale sur le texte ; sinon (photo) on garde toute la zone de papier
  const paperShare = (px1 - px0 + 1) * (py1 - py0 + 1) / (gw * gh);
  if (paperShare < 0.8) { x0 = px0; y0 = py0; x1 = px1; y1 = py1; }
  let sx = 0, sy = 0, sw = w, sh = h;
  if (x1 >= 0) {
    const m = 40;
    sx = Math.max(0, x0 * S - m); sy = Math.max(0, y0 * S - m);
    sw = Math.min(w, (x1 + 1) * S + m) - sx; sh = Math.min(h, (y1 + 1) * S + m) - sy;
  }
  if (sw * sh < w * h * 0.02) { sx = 0; sy = 0; sw = w; sh = h; }   // zone trop petite : on garde tout
  const region = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) region[y * sw + x] = g[(sy + y) * w + sx + x];
  // on agrandit le niveau de gris AVANT de seuiller : un petit ticket garde ainsi des caractères lisibles
  const scale = Math.max(1, Math.min(3, 2400 / Math.max(sw, sh), Math.sqrt(12e6 / (sw * sh))));
  const gc = grayToCanvas(region, sw, sh, scale), cw2 = gc.width, ch2 = gc.height;
  const gd = gc.getContext('2d').getImageData(0, 0, cw2, ch2).data, gg = new Uint8Array(cw2 * ch2);
  for (let i = 0; i < gg.length; i++) gg[i] = gd[i * 4];
  return { crop: grayToCanvas(adaptiveBinary(gg, cw2, ch2), cw2, ch2, 1), full, info: { region: [sx, sy, sw, sh], size: [w, h], paper: [px0, py0, px1, py1] } };
}

function rotateCanvas(c, a) {
  if (!a) return c;
  const r = document.createElement('canvas'), flat = a === 180;
  r.width = flat ? c.width : c.height; r.height = flat ? c.height : c.width;
  const x = r.getContext('2d');
  x.translate(r.width / 2, r.height / 2); x.rotate(a * Math.PI / 180);
  x.drawImage(c, -c.width / 2, -c.height / 2);
  return r;
}

// angle d'inclinaison des lignes de texte (profil de projection), en degrés, entre -25 et +25
function estimateSkew(c) {
  const tmp = document.createElement('canvas'); tmp.width = c.width; tmp.height = c.height;
  const tc = tmp.getContext('2d', { willReadFrequently: true });
  tc.drawImage(c, 0, 0);
  const full = tc.getImageData(0, 0, c.width, c.height).data;
  const f = Math.max(1, Math.ceil(Math.max(c.width, c.height) / 800));       // bloc de f×f pixels : « encre » s'il contient un pixel sombre
  const w = Math.ceil(c.width / f), h = Math.ceil(c.height / f), blocks = new Uint8Array(w * h);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (full[(y * c.width + x) * 4] < 128) blocks[((y / f) | 0) * w + ((x / f) | 0)] = 1;
  const xs = [], ys = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (blocks[y * w + x]) { xs.push(x); ys.push(y); }  if (xs.length < 200) return 0;
  const step = Math.max(1, Math.floor(xs.length / 40000)), diag = Math.ceil(Math.hypot(w, h));
  const score = deg => {
    const t = deg * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t), bins = new Float32Array(2 * diag + 2);
    for (let i = 0; i < xs.length; i += step) bins[Math.round(ys[i] * cs - xs[i] * sn) + diag]++;
    let q = 0; for (let i = 0; i < bins.length; i++) q += bins[i] * bins[i];
    return q;
  };
  let best = 0, bs = -1;
  for (let a = -25; a <= 25; a += 1) { const v = score(a); if (v > bs) { bs = v; best = a; } }
  for (let a = best - 1; a <= best + 1; a += 0.25) { const v = score(a); if (v > bs) { bs = v; best = a; } }
  return best;
}

function deskewCanvas(c, deg) {
  const t = deg * Math.PI / 180, cs = Math.abs(Math.cos(t)), sn = Math.abs(Math.sin(t));
  const r = document.createElement('canvas');
  r.width = Math.round(c.width * cs + c.height * sn); r.height = Math.round(c.width * sn + c.height * cs);
  const x = r.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, r.width, r.height);
  x.translate(r.width / 2, r.height / 2); x.rotate(-t);
  x.drawImage(c, -c.width / 2, -c.height / 2);
  return r;
}
// reconstitue les lignes du ticket à partir de la position des mots (libellé et prix sur la même ligne, même s'ils sont éloignés)
function rowsFromWords(words) {
  const ws = (words || []).filter(w => w.text && w.text.trim() && w.confidence > 25 && w.bbox);
  if (!ws.length) return '';
  const hs = ws.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b), med = hs[hs.length >> 1] || 20;
  ws.sort((a, b) => (a.bbox.y0 + a.bbox.y1) - (b.bbox.y0 + b.bbox.y1));
  const rows = [];
  for (const w of ws) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2, r = rows[rows.length - 1];
    if (r && Math.abs(cy - r.cy) < med * 0.6) { r.w.push(w); r.cy = r.w.reduce((s, x) => s + (x.bbox.y0 + x.bbox.y1) / 2, 0) / r.w.length; }
    else rows.push({ cy, w: [w] });
  }
  return rows.map(r => r.w.sort((a, b) => a.bbox.x0 - b.bbox.x0).map(x => x.text.trim()).join(' ')).join('\n');
}
async function ocrLocal(blob, onMsg) {
  onMsg('Chargement du moteur OCR…');
  if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  onMsg('Préparation de l’image…');
  const prep = await prepareImages(blob);
  const worker = await Tesseract.createWorker('fra', 1, {
    logger: m => { if (m.status === 'recognizing text') onMsg(`Lecture du texte… ${Math.round((m.progress || 0) * 100)}%`); else if (m.status) onMsg('Préparation (langue française)…'); },
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    let overall = null;
    for (const variant of [prep.crop, prep.full]) {
      let best = null;
      // essaie l'orientation d'origine puis les rotations (ticket scanné ou photographié de travers)
      for (const angle of [0, 90, 270, 180]) {
        if (angle) onMsg(`Test de l’orientation (${angle}°)…`);
        const turned = rotateCanvas(variant, angle), skew = estimateSkew(turned);
        const { data } = await worker.recognize(Math.abs(skew) >= 0.5 ? deskewCanvas(turned, skew) : turned);
        const good = data.words
          ? data.words.filter(w => w.confidence > 70 && w.text.replace(/[^A-Za-zÀ-ÿ0-9]/g, '').length >= 3).length
          : (data.text.match(/[A-Za-zÀ-ÿ0-9]{3,}/g) || []).length * data.confidence / 100;
        if (!best || good > best.good) best = { data, good };
        if (good >= 12) break;
      }
      const text = rowsFromWords(best.data.words) || best.data.text;
      const out = parseReceipt(text);
      out.confidence = best.data.confidence;
      out.rawText = text;
      out.score = (out.amount > 0 ? 2 : 0) + (out.merchant ? 1 : 0) + (out.date ? 1 : 0);
      if (!overall || out.score > overall.score) overall = out;
      if (out.amount > 0 && out.score >= 3) break;      // résultat convaincant : inutile d'essayer l'autre version
      onMsg('Seconde tentative de lecture…');
    }
    return overall;
  } finally { worker.terminate(); }
}

const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const AMT_RE = /(?<![\d,.])(\d{1,3}(?:[ .]\d{3})+|\d+)\s?[,.]\s?(\d{2})(?!\d|[./]\d)/g;
const amountsOf = line => [...line.matchAll(AMT_RE)].map(m => parseFloat(m[1].replace(/[ .]/g, '') + '.' + m[2])).filter(n => n > 0 && n < 100000);
const MONTHS = ['janv', 'fevr', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sept', 'oct', 'nov', 'dec'];

function parseReceipt(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const L = lines.map(raw => ({ raw, n: norm(raw) }));

  // --- montant : mots-clés fiables d'abord, jamais les lignes de solde / sous-total / TVA ---
  const bad = /solde|sous.?total|dont|\btva\b|t\.v\.a|rendu|monnaie|remise|reduction|fidelite|economie|hors taxe|\bht\b/;
  const pick = (re, next) => {
    for (let i = 0; i < L.length; i++) {
      if (!re.test(L[i].n) || bad.test(L[i].n)) continue;
      let a = amountsOf(L[i].raw);
      if (!a.length && next && L[i + 1]) a = amountsOf(L[i + 1].raw);
      if (a.length) return a[a.length - 1];
    }
    return 0;
  };
  let amount = pick(/net a payer|a payer|total ttc|montant ttc|total a regler|a regler|montant du|montant paye|net payer/, true)
    || pick(/\btotal\b/, false)
    || pick(/\b(cb|carte|visa|mastercard|especes|cheque|paiement)\b/, false);
  if (!amount) {
    const all = L.filter(x => !bad.test(x.n)).flatMap(x => amountsOf(x.raw));
    amount = all.length ? Math.max(...all) : 0;
  }

  // --- TVA : taux (%) et montant, dans les lignes qui suivent le mot TVA ---
  let vat = null, vatRate = null;
  const ti = L.findIndex(x => /\btva\b|t\.v\.a/.test(x.n));
  if (ti >= 0 && amount > 0) {
    const found = [];
    const rateRe = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%/;
    for (let i = ti; i < Math.min(L.length, ti + 6); i++) {
      const rm = L[i].n.match(rateRe);
      if (!rm) continue;
      const rate = parseFloat(rm[1].replace(',', '.'));
      if (!(rate > 0 && rate <= 25)) continue;
      let c = amountsOf(L[i].raw.replace(rateRe, ' '));
      if (!c.length && L[i + 1]) c = amountsOf(L[i + 1].raw);
      c = c.filter(v => v < amount * 0.3);
      if (c.length) found.push({ rate, c });
    }
    if (found.length === 1) {
      const { rate, c } = found[0], exp = amount * rate / (100 + rate);
      vat = c.reduce((a, b) => (Math.abs(b - exp) < Math.abs(a - exp) ? b : a));
      vatRate = rate;
    } else if (found.length > 1) {
      vat = found.reduce((s, f) => s + Math.min(...f.c), 0);
    }
    if (vat != null) vat = Math.round(vat * 100) / 100;
  }

  // --- date : numérique (08/10/2026) ou en toutes lettres (08 octobre 2026) ---
  const t = norm(text), cands = [];
  const m1 = t.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})\b/);
  if (m1) cands.push({ i: m1.index, d: +m1[1], m: +m1[2], y: +m1[3] });
  const m2 = t.match(new RegExp(`(\\d{1,2})\\s*(${MONTHS.join('|')})[a-z]*\\.?\\s*(\\d{4})`));
  if (m2) cands.push({ i: m2.index, d: +m2[1], m: MONTHS.indexOf(m2[2]) + 1, y: +m2[3] });
  let date = null;
  cands.sort((a, b) => a.i - b.i);
  for (const c of cands) {
    const y = c.y < 100 ? c.y + 2000 : c.y;
    if (c.m >= 1 && c.m <= 12 && c.d >= 1 && c.d <= 31 && y >= 2000 && y <= new Date().getFullYear() + 1) { date = `${y}-${pad(c.m)}-${pad(c.d)}`; break; }
  }

  // --- commerçant : première vraie ligne de texte (pas une adresse, un numéro, une date…) ---
  const skip = /ticket|facture|\btel\b|www|siret|siren|caisse|merci|badge|etablissement|n°|^le (lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)|\b(rue|avenue|bd|boulevard|place|chemin|route|impasse)\b/;
  const merchant = (lines.slice(0, 10).find(l => (l.match(/[A-Za-zÀ-ÿ]/g) || []).length >= 4 && !/^\d/.test(l) && !skip.test(norm(l))) || '')
    .replace(/[^A-Za-zÀ-ÿ0-9 '&.\-]/g, '').trim().slice(0, 40);

  let category = 'other';
  if (/restaurant|brasserie|bistro|cafe|boulangerie|pizz|burger|sandwich|menu|boisson|plat|dessert|cantine|\bself\b|repas|convention|traiteur/.test(t)) category = 'meals';
  else if (/sncf|train|taxi|uber|peage|essence|carburant|gazole|parking|autoroute|totalenergies|station|billet/.test(t)) category = 'travel';
  else if (/hotel|ibis|novotel|nuit|chambre|airbnb/.test(t)) category = 'lodging';
  else if (/papeterie|bureau|fourniture|cartouche|stylo|office|cahier/.test(t)) category = 'supplies';
  return { merchant, amount, date, category, vat, vatRate };
}

async function ocrClaude(blob, S) {
  const b64 = await blobToBase64(blob);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': S.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({
      model: S.model, max_tokens: 400,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: 'Lis ce ticket de caisse. Réponds uniquement par un objet JSON : {"merchant": string, "amount": nombre (total TTC payé), "date": "AAAA-MM-JJ" ou null, "vat": nombre (montant total de TVA) ou null, "vat_rate": nombre (taux en %) ou null, "category": "meals"|"travel"|"lodging"|"supplies"|"other", "confidence": nombre entre 0 et 1}. Ignore les soldes de compte et sous-totaux : amount est le net à payer.' },
      ] }],
    }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`API Claude : ${j.error?.message || r.status}`);
  }
  const j = await r.json();
  const txt = (j.content || []).map(c => c.text || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Réponse illisible de l’API');
  const o = JSON.parse(m[0]);
  return { merchant: o.merchant || '', amount: Number(o.amount) || 0, date: /^\d{4}-\d{2}-\d{2}$/.test(o.date || '') ? o.date : null, category: o.category, vat: Number(o.vat) > 0 ? Number(o.vat) : null, vatRate: Number(o.vat_rate) > 0 ? Number(o.vat_rate) : null, confidence: o.confidence != null ? o.confidence * 100 : null };
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const f = new FileReader();
    f.onload = () => res(String(f.result).split(',')[1]);
    f.onerror = () => rej(f.error);
    f.readAsDataURL(blob);
  });
}

// réduit l'image pour limiter le stockage et accélérer l'OCR
async function downscale(source, maxSide = 2000) {
  const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
  const w = bmp.width || bmp.videoWidth, h = bmp.height || bmp.videoHeight;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
}

async function handleImage(source) {
  try {
    const big = source instanceof Blob ? source : await downscale(source, 3500);
    const blob = await downscale(big);
    draft = newDraft(blob); draftIsNew = true; draft.ocrSource = big;
    location.hash = '#/review';
    runOcr();
  } catch { toast('Image illisible'); }
}

// ---------- SCANNER ----------
routes.scan = async function () {
  let stream = null, torchOn = false;
  app.innerHTML = `
    <div class="cam">
      <header><button class="ib" id="x" aria-label="Fermer">${ic('close')}</button><h1>Scanner un ticket</h1><button class="ib" id="torch" aria-label="Flash">${ic('flash_off')}</button></header>
      <div class="view"><video id="vid" playsinline muted autoplay></video>
        <div class="nocam" id="nocam" hidden><div>${ic('no_photography')}<p class="mt16">Caméra indisponible dans ce contexte.<br>Utilisez le bouton de capture pour prendre une photo avec l'appareil du téléphone, ou choisissez une image.</p></div></div>
        <div class="frame"><i></i><i></i><i></i><i></i></div>
        <div class="tip"><p>Cadrez le ticket sur une surface sombre</p></div></div>
      <footer>
        <button class="side" id="gal">${ic('photo_library', 'fill')}<span>Galerie</span></button>
        <button class="shutter" id="shut" aria-label="Prendre la photo"><i></i></button>
        <a class="side" href="#/new">${ic('edit')}<span>Manuel</span></a>
      </footer>
      <input type="file" id="fgal" accept="image/*" hidden>
      <input type="file" id="fcam" accept="image/*" capture="environment" hidden>
    </div>
    <div class="flashfx" id="fx"></div>`;

  const stop = () => { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; };
  currentCleanup = stop;
  $('#x').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/dashboard'));
  $('#gal').onclick = () => $('#fgal').click();
  $('#fgal').onchange = e => e.target.files[0] && handleImage(e.target.files[0]);
  $('#fcam').onchange = e => e.target.files[0] && handleImage(e.target.files[0]);

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    $('#vid').srcObject = stream;
  } catch { $('#nocam').hidden = false; $('#torch').style.visibility = 'hidden'; }

  $('#torch').onclick = async () => {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || !(track.getCapabilities && track.getCapabilities().torch)) { toast('Flash non disponible'); return; }
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); $('#torch').innerHTML = ic(torchOn ? 'flash_on' : 'flash_off'); } catch { toast('Flash non disponible'); }
  };

  $('#shut').onclick = () => {
    const v = $('#vid');
    if (stream && v.videoWidth) {
      const fx = $('#fx'); fx.style.opacity = 1; setTimeout(() => (fx.style.opacity = 0), 150);
      handleImage(v);
    } else $('#fcam').click();
  };
};

// ---------- PROFIL ----------
routes.profile = function () {
  const S = Settings.get();
  const html = `
    <section class="card lg mb16 stack16">
      <h2 class="sec">Profil et budget</h2>
      <label class="f"><span class="label">Prénom</span><input class="inp" id="name" value="${esc(S.name)}" placeholder="Votre prénom"></label>
      <label class="f"><span class="label">Budget mensuel (€)</span><input class="inp" id="budget" inputmode="decimal" value="${esc(String(S.budget).replace('.', ','))}"></label>
    </section>
    <section class="card lg mb16 stack16">
      <h2 class="sec">Lecture des tickets (OCR)</h2>
      <label class="f"><span class="label">Moteur</span>
        <div class="field"><select class="inp" id="provider">
          <option value="local" ${S.provider === 'local' ? 'selected' : ''}>Local (gratuit, sans compte)</option>
          <option value="claude" ${S.provider === 'claude' ? 'selected' : ''}>Claude (API, plus précis)</option>
        </select>${ic('expand_more', 'r')}</div></label>
      <div id="claudeOpts" ${S.provider === 'claude' ? '' : 'hidden'} class="stack16">
        <label class="f"><span class="label">Clé API Anthropic</span><input class="inp" id="apiKey" type="password" autocomplete="off" value="${esc(S.apiKey)}" placeholder="sk-ant-…"></label>
        <label class="f"><span class="label">Modèle</span><input class="inp" id="model" value="${esc(S.model)}"></label>
        <p class="note warn">La clé est conservée uniquement dans ce navigateur et les images des tickets sont envoyées à Anthropic. Réservé à un usage personnel.</p>
      </div>
      <p class="muted">Le moteur local télécharge son module de lecture (français) lors du premier scan, puis le conserve.</p>
    </section>
    <section class="card lg mb16 stack">
      <h2 class="sec mb8">Données</h2>
      <p class="muted mb8">${expenses.length} dépense${expenses.length > 1 ? 's' : ''} stockée${expenses.length > 1 ? 's' : ''} sur cet appareil.</p>
      <button class="btn ghost" id="csv">${ic('table_view')} Exporter en CSV</button>
      <button class="btn ghost" id="bk">${ic('download')} Sauvegarde complète (JSON)</button>
      <button class="btn ghost" id="rs">${ic('upload')} Restaurer une sauvegarde</button>
      <input type="file" id="rsf" accept="application/json,.json" hidden>
      <button class="btn ghost" id="demo">${ic('science')} Ajouter des données de démo</button>
      <button class="btn danger" id="wipe">${ic('delete_forever')} Tout effacer</button>
    </section>
    <p class="muted" style="text-align:center">ExpenseFlow · données stockées localement</p>`;
  render({ title: 'Profil', brand: false, html, active: 'profile' });

  const bind = (id, key, fmt = v => v) => $('#' + id).addEventListener('change', e => { Settings.set({ [key]: fmt(e.target.value) }); toast('Enregistré'); });
  bind('name', 'name', v => v.trim());
  bind('budget', 'budget', v => { const n = parseAmount(v); return n > 0 ? n : DEFAULTS.budget; });
  bind('apiKey', 'apiKey', v => v.trim());
  bind('model', 'model', v => v.trim() || DEFAULTS.model);
  $('#provider').addEventListener('change', e => { Settings.set({ provider: e.target.value }); $('#claudeOpts').hidden = e.target.value !== 'claude'; });
  $('#csv').onclick = exportCsv;
  $('#bk').onclick = backup;
  $('#rs').onclick = () => $('#rsf').click();
  $('#rsf').onchange = e => e.target.files[0] && restore(e.target.files[0]);
  $('#demo').onclick = async () => { await loadDemo(); toast('Données de démo ajoutées'); routes.profile(); };
  $('#wipe').onclick = async () => {
    if (!confirm('Effacer toutes les dépenses de cet appareil ? Cette action est définitive.')) return;
    await DB.clear(); await reload(); toast('Données effacées'); routes.profile();
  };
};

// ---------- export / sauvegarde ----------
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function exportCsv() {
  if (!expenses.length) { toast('Aucune dépense à exporter'); return; }
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Commerçant', 'Montant TTC', 'TVA', 'Taux TVA', 'Montant HT', 'Catégorie', 'Statut', 'Notes'].map(q).join(';')];
  for (const e of [...expenses].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([e.date, e.merchant, e.amount.toFixed(2).replace('.', ','), e.vat != null ? fmtNum(e.vat) : '', e.vatRate != null ? String(e.vatRate).replace('.', ',') : '', e.vat != null ? fmtNum(e.amount - e.vat) : '', CATS[e.category]?.label, STATUS[e.status]?.label, e.notes].map(q).join(';'));
  }
  download(`expenseflow-${ymd(new Date())}.csv`, new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
}

async function backup() {
  const data = [];
  for (const e of expenses) data.push({ ...e, image: e.image ? await blobToDataUrl(e.image) : null });
  download(`expenseflow-sauvegarde-${ymd(new Date())}.json`, new Blob([JSON.stringify({ app: 'expenseflow', version: 1, settings: { ...Settings.get(), apiKey: '' }, expenses: data })], { type: 'application/json' }));
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = () => rej(f.error); f.readAsDataURL(blob); });
}

async function restore(file) {
  try {
    const j = JSON.parse(await file.text());
    if (j.app !== 'expenseflow' || !Array.isArray(j.expenses)) throw new Error();
    for (const e of j.expenses) {
      const img = e.image ? await (await fetch(e.image)).blob() : null;
      await DB.put({ ...e, image: img });
    }
    if (j.settings) Settings.set({ ...j.settings, apiKey: Settings.get().apiKey });
    await reload(); toast(`${j.expenses.length} dépenses restaurées`); routes.profile();
  } catch { toast('Fichier de sauvegarde invalide'); }
}

async function loadDemo() {
  const t = new Date();
  const d = n => ymd(addDays(t, -n));
  const demo = [
    ['Air France', 845, 'travel', 'approved', 6], ['Le Bistrot Parisien', 42.5, 'meals', 'pending', 3],
    ['Fournitures Bureau Pro', 128.3, 'supplies', 'approved', 5], ['Uber France', 18.9, 'travel', 'rejected', 4],
    ['Ibis Budget Lyon', 89, 'lodging', 'approved', 9], ['SNCF Voyageurs', 156, 'travel', 'approved', 11],
    ['Le Petit Bistro', 42, 'meals', 'approved', 1], ['Office Depot', 115.9, 'supplies', 'rejected', 1],
    ['Brasserie du Port', 36.8, 'meals', 'pending', 0], ['Taxi G7', 24.5, 'travel', 'pending', 0],
    ['Boulangerie Martin', 12.4, 'meals', 'approved', 14], ['Hôtel du Parc', 210, 'lodging', 'approved', 21],
  ];
  for (const [merchant, amount, category, status, ago] of demo) {
    await DB.put({ id: uid(), merchant, amount, category, status, date: d(ago), notes: '', image: null, confidence: null, createdAt: Date.now() - ago });
  }
  await reload();
}

// ---------- démarrage ----------
(async function init() {
  try {
    await DB.open();
    await reload();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch {
    app.innerHTML = '<main style="padding:32px"><h2 class="sec">Stockage indisponible</h2><p class="muted mt16">Le navigateur bloque le stockage local (navigation privée ?). L’application ne peut pas fonctionner.</p></main>';
    return;
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  route();
})();
