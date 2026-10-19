// Local quoter dashboard. Polls /api/state once a second; the only action is Stop (token-guarded POST).
'use strict';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const STATUS = { starting: 'запуск', running: 'котирує', paused: 'пауза', frozen: 'заморожено', halted: 'зупинено ризиком', stopping: 'зупиняється', stopped: 'зупинено', offline: 'немає зв’язку' };
const BAND_LABEL = { 1: '0–5 bps', 2: '5–10 bps', 3: '10–20 bps' };
const BAND_WEIGHT = { 1: '×1.00', 2: '×0.25', 3: '×0.10' };
const CAP = 100000;
let token = null, mode = null, failures = 0, stopping = false;

const fmt = (v, d = 2) => v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (v, d = 0) => v === null || v === undefined ? '—' : (Number(v) < 0 ? '−$' : '$') + fmt(Math.abs(Number(v)), d);
const short = (v) => v >= 1e6 ? `$${fmt(v / 1e6, 2)}M` : v >= 1e3 ? `$${fmt(v / 1e3, 1)}k` : `$${fmt(v, 0)}`;
const time = (t) => new Date(t).toLocaleTimeString('uk-UA', { hour12: false });
const ago = (ms) => ms < 1000 ? `${Math.round(ms)} мс` : ms < 60000 ? `${(ms / 1000).toFixed(1)} с` : `${Math.round(ms / 60000)} хв`;
const span = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} год ${m} хв` : m ? `${m} хв ${s % 60} с` : `${s} с`; };
function text(id, value, cls) { const el = $(id); el.textContent = value; if (cls !== undefined) el.className = `v ${cls}`; }
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v; else node.setAttribute(k, v);
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}
function svg(tag, attrs) { const node = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; }
const signClass = (v) => v === null || v === undefined || v === 0 ? '' : v > 0 ? 'pos' : 'neg';

async function session() {
  const response = await fetch('/api/session', { cache: 'no-store' });
  if (!response.ok) throw new Error(`session ${response.status}`);
  token = (await response.json()).token;
}

async function poll() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const state = await response.json();
    failures = 0;
    render(state);
  } catch {
    if (++failures >= 2) offline();
  } finally {
    setTimeout(poll, 1000);
  }
}

function offline() {
  const pill = $('status');
  pill.dataset.state = 'offline'; pill.textContent = STATUS.offline;
  $('reason').textContent = 'процес quoter не відповідає';
  const banner = $('banner');
  banner.hidden = false; banner.dataset.kind = 'offline';
  banner.textContent = stopping ? 'Процес зупинено. Панель більше не оновлюється.' : 'Немає зв’язку з процесом quoter. Перевірте термінал.';
  $('stop').disabled = true;
}

function render(s) {
  mode = s.mode;
  document.title = `${s.instrument.symbol} · ${STATUS[s.status] ?? s.status} · Perps Quoter`;
  $('symbol').textContent = s.instrument.symbol;
  const m = $('mode'); m.dataset.mode = s.mode; m.textContent = s.mode === 'live' ? 'LIVE' : 'DRY-RUN';
  const pill = $('status'); pill.dataset.state = s.status; pill.textContent = STATUS[s.status] ?? s.status;
  $('reason').textContent = s.statusReason || (s.notes || []).join('; ');
  $('route').textContent = s.egress.primary;
  $('stop').disabled = stopping || s.status === 'stopping' || s.status === 'stopped';
  const banner = $('banner');
  banner.hidden = false; banner.dataset.kind = s.mode;
  banner.textContent = s.mode === 'live'
    ? 'LIVE: реальні ордери на біржі. Зупинка знімає всі ордери на інструменті й вимикає autoCancel.'
    : 'DRY-RUN: симуляція на живих даних біржі. Ордери не надсилаються, позиції й PnL немає.';
  renderKpis(s);
  renderChart(s.history, s.now);
  renderLadder(s);
  renderBands(s.metrics);
  renderAlerts(s.alerts || []);
  renderSystem(s);
  renderFills(s);
}

function renderKpis(s) {
  const mk = s.market, mt = s.metrics;
  text('k-mid', mk.mid ?? '—');
  $('k-mid-s').textContent = mk.mid ? `спред ${fmt(mk.spreadBps, 2)} bps · ${mk.ageMs === null ? '—' : ago(mk.ageMs)} · ${mk.status}` : mk.status;
  text('k-up', mt.samples ? `${fmt(mt.uptime * 100, 1)}%` : '—', mt.samples ? (mt.uptime >= 0.99 ? 'pos' : mt.uptime < 0.9 ? 'neg' : '') : '');
  $('k-up-s').textContent = `${mt.samples ?? 0} знімків з ${new Date(mt.periodStart).toISOString().slice(11, 16)} UTC`;
  text('k-ls', fmt(mt.avgLiquidityScore, 0));
  $('k-ls-s').textContent = `bid ${fmt(mt.sideScores?.bid, 0)} · ask ${fmt(mt.sideScores?.ask, 0)}`;
  text('k-raw', mt.estRawScore === null ? '—' : fmt(mt.estRawScore, 1));
  $('k-raw-s').textContent = mt.makerSharePct === null ? (s.mode === 'live' ? 'maker share ще не прочитано' : 'maker share невідомий у dry-run') : `maker share 7d ${fmt(mt.makerSharePct, 2)}%`;
  const a = s.account;
  if (a) {
    text('k-pos', usd(a.positionUsd, 0), signClass(a.positionUsd));
    $('k-pos-s').textContent = `${a.positionQty} · ліміт ${usd(s.limits.maxPositionUsd)}`;
    text('k-pnl', usd(a.dailyPnl, 2), signClass(a.dailyPnl));
    $('k-pnl-s').textContent = `стоп −${usd(s.limits.maxDailyLossUsd)} · маржа ${usd(a.availableMargin)}`;
  } else {
    text('k-pos', '—', ''); $('k-pos-s').textContent = 'симуляція без позиції';
    text('k-pnl', '—', ''); $('k-pnl-s').textContent = 'симуляція без PnL';
  }
}

function renderChart(history, now) {
  const chart = $('chart'); chart.replaceChildren();
  const W = 1000, H = 260, windowMs = 600000, t0 = now - windowMs;
  const pts = history.filter((p) => p.t >= t0);
  const values = pts.flatMap((p) => [p.mid, p.bid, p.ask, p.ourBid, p.ourAsk, p.mid && p.mid * 1.0005, p.mid && p.mid * 0.9995]).filter((v) => typeof v === 'number');
  for (let i = 1; i < 4; i++) chart.append(svg('line', { class: 'g-line', x1: 0, x2: W, y1: (H * i) / 4, y2: (H * i) / 4 }));
  $('ax-l').textContent = '−10 хв';
  if (!values.length) { $('ax-hi').textContent = ''; $('ax-lo').textContent = ''; return; }
  let lo = Math.min(...values), hi = Math.max(...values);
  const pad = (hi - lo) * 0.08 || hi * 0.0002; lo -= pad; hi += pad;
  const x = (t) => ((t - t0) / windowMs) * W, y = (v) => H - ((v - lo) / (hi - lo)) * H;
  const path = (key, step) => {
    let d = '', open = false;
    for (const p of pts) {
      const v = typeof key === 'function' ? key(p) : p[key];
      if (typeof v !== 'number') { open = false; continue; }
      const X = x(p.t).toFixed(1), Y = y(v).toFixed(1);
      if (!open) { d += `M${X},${Y}`; open = true; } else d += step ? `H${X}V${Y}` : `L${X},${Y}`;
    }
    return d;
  };
  // ±5 bps envelope around mid (band 1)
  const withMid = pts.filter((p) => typeof p.mid === 'number');
  if (withMid.length > 1) {
    const upper = withMid.map((p) => `${x(p.t).toFixed(1)},${y(p.mid * 1.0005).toFixed(1)}`);
    const lower = withMid.slice().reverse().map((p) => `${x(p.t).toFixed(1)},${y(p.mid * 0.9995).toFixed(1)}`);
    chart.append(svg('path', { class: 'a-band', d: `M${upper.join('L')}L${lower.join('L')}Z` }));
  }
  chart.append(svg('path', { class: 'l-mkt', d: path('bid') }), svg('path', { class: 'l-mkt', d: path('ask') }));
  chart.append(svg('path', { class: 'l-mid', d: path('mid') }));
  chart.append(svg('path', { class: 'l-bid', d: path('ourBid', true) }), svg('path', { class: 'l-ask', d: path('ourAsk', true) }));
  $('ax-hi').textContent = fmt(hi, hi > 1000 ? 1 : 3);
  $('ax-lo').textContent = fmt(lo, lo > 1000 ? 1 : 3);

  const strip = $('strip'); strip.replaceChildren();
  const cells = history.slice(-600), offset = 600 - cells.length;
  let ok = 0;
  for (let i = 0; i < cells.length;) {
    let j = i; while (j < cells.length && cells[j].q === cells[i].q) j++;
    strip.append(svg('rect', { x: offset + i, y: 0, width: j - i, height: 10, class: cells[i].q ? 's-ok' : 's-no' }));
    if (cells[i].q) ok += j - i;
    i = j;
  }
  if (offset) strip.append(svg('rect', { x: 0, y: 0, width: offset, height: 10, class: 's-none' }));
  $('strip-pct').textContent = cells.length ? `${fmt((ok / cells.length) * 100, 1)}% за ${fmt(cells.length / 60, 1)} хв` : '';
}

function stateTag(row, liveMode) {
  if (!liveMode) return row.target ? el('span', { class: 'tag', text: 'симуляція' }) : el('span', { class: 'tag bad', text: 'пропущено' });
  const live = row.live;
  if (!live) return el('span', { class: row.target ? 'tag wait' : 'tag', text: row.target ? 'очікує' : '—' });
  if (live.inFlight) return el('span', { class: 'tag wait', text: 'в дорозі' });
  if (live.status === 'open' || live.status === 'accepted') return el('span', { class: 'tag ok', text: live.status === 'open' ? 'у книзі' : 'прийнято' });
  return el('span', { class: 'tag bad', text: live.status });
}

function renderLadder(s) {
  const body = $('ladder'); body.replaceChildren();
  const liveMode = s.mode === 'live';
  const rows = s.ladder.slice();
  const asks = rows.filter((r) => r.side === 'ask').sort((a, b) => b.level - a.level);
  const bids = rows.filter((r) => r.side === 'bid').sort((a, b) => a.level - b.level);
  const line = (r) => {
    const shown = liveMode && r.live ? r.live : null;
    const price = shown ? shown.price : r.target?.price ?? '—';
    const qty = shown ? shown.rest : r.target?.qty ?? '—';
    const notional = shown ? Number(shown.price) * Number(shown.rest) : r.target?.notional;
    const dist = shown ? shown.distBps : r.target?.distBps;
    const priceCell = el('td', { class: 'r' }, price);
    if (shown && r.target && r.target.price !== shown.price) priceCell.append(el('span', { class: 'target', text: `ціль ${r.target.price}` }));
    return el('tr', { class: r.side },
      el('td', { text: `${r.side === 'bid' ? 'BID' : 'ASK'} L${r.level}` }),
      el('td', { class: `b${r.band}`, text: BAND_LABEL[r.band] }),
      priceCell, el('td', { class: 'r', text: qty }), el('td', { class: 'r', text: notional === undefined ? '—' : usd(notional) }),
      el('td', { class: 'r', text: dist === null || dist === undefined ? '—' : fmt(dist, 2) }),
      el('td', {}, stateTag(r, liveMode)));
  };
  for (const r of asks) body.append(line(r));
  body.append(el('tr', { class: 'midrow' }, el('td', { colspan: '7', text: s.market.mid ? `mid ${s.market.mid} · bid ${s.market.bid} / ask ${s.market.ask}` : 'немає ринкових даних' })));
  for (const r of bids) body.append(line(r));
  $('ladder-aside').textContent = `сесія ${s.session}${s.skewBps ? ` · skew ${fmt(s.skewBps, 2)} bps` : ''}`;
  $('ladder-note').textContent = liveMode ? 'Показано ордери, які тримає біржа. «Ціль» — нова ціна, якщо ордер ще не переставлено.' : 'Цільова сітка, розрахована на живому стакані. На біржу нічого не надсилається.';
}

function renderBands(mt) {
  const root = $('bands'); root.replaceChildren();
  for (const band of [1, 2, 3]) {
    const bid = mt.avgBidByBand?.[band - 1] ?? 0, ask = mt.avgAskByBand?.[band - 1] ?? 0;
    const obid = mt.avgOtherBookBidByBand?.[band - 1] ?? 0, oask = mt.avgOtherBookAskByBand?.[band - 1] ?? 0;
    const bar = (side, v, other) => {
      const fill = el('i'); fill.style.width = `${Math.min(100, (v / CAP) * 100).toFixed(1)}%`;
      return el('div', { class: `bar ${side}`, title: `${side} ${usd(v)} з ${usd(CAP)}; інші ${usd(other)}` }, fill, el('span', { text: `${short(v)} / $100k · інші ${short(other)}` }));
    };
    root.append(el('div', { class: 'band-row' },
      el('div', { class: 'lbl' }, BAND_LABEL[band], el('small', { text: `вага ${BAND_WEIGHT[band]}` })),
      bar('bid', bid, obid), bar('ask', ask, oask)));
  }
}

function renderAlerts(alerts) {
  const list = $('alerts'); list.replaceChildren();
  $('alerts-aside').textContent = alerts.length ? `${alerts.length}` : '';
  if (!alerts.length) { list.append(el('li', { class: 'empty', text: 'Подій немає' })); return; }
  for (const a of alerts.slice(0, 40)) {
    const detail = a.detail && a.detail !== '{}' ? a.detail : '';
    list.append(el('li', { 'data-level': a.level }, el('time', { text: time(a.t) }), el('span', { class: 'm', text: a.msg }), detail ? el('span', { class: 'd', text: detail }) : null));
  }
}

function renderSystem(s) {
  const root = $('system'); root.replaceChildren();
  const add = (k, v) => root.append(el('dt', { text: k }), el('dd', { text: v }));
  add('Інструмент', `${s.instrument.symbol} · id ${s.instrument.id} · ${s.instrument.category}`);
  add('Працює', span(s.now - s.startedAt));
  add('Публічні потоки', s.egress.feeds.join(' | ') || '—');
  add('Дані', `${s.market.status} · ${s.market.ageMs === null ? '—' : ago(s.market.ageMs)}`);
  add('Dead man’s switch', s.deadmanDeadline ? `спрацює через ${span(s.deadmanDeadline - s.now)}, якщо процес зупиниться` : s.mode === 'live' ? 'не активний' : 'не потрібен у dry-run');
  if (s.credentialExpiresAt) add('Proxy-ключ', `спливає ${new Date(s.credentialExpiresAt).toLocaleString('uk-UA')}`);
  add('Виконання', s.metrics.fills ? `${s.metrics.fills} · maker $${fmt(s.metrics.makerVolume, 0)} · комісії ${usd(s.metrics.fees, 2)}` : '0');
}

function renderFills(s) {
  const body = $('fills'); body.replaceChildren();
  if (!s.fills.length) { body.append(el('tr', {}, el('td', { colspan: '5', class: 'empty', text: s.mode === 'live' ? 'Виконань ще не було' : 'У dry-run виконань немає' }))); return; }
  for (const f of s.fills) body.append(el('tr', { class: f.side === 'long' ? 'bid' : 'ask' },
    el('td', { text: time(f.t) }), el('td', { text: f.side === 'long' ? 'купівля' : 'продаж' }), el('td', { class: 'r', text: f.price }), el('td', { class: 'r', text: f.qty }), el('td', { class: 'r', text: usd(f.fee, 4) })));
}

$('stop').addEventListener('click', async () => {
  const question = mode === 'live'
    ? 'Зупинити live-котирування? Буде виконано cancelAll на інструменті, перевірено відкриті ордери й вимкнено autoCancel. Позиція залишиться.'
    : 'Зупинити dry-run?';
  if (!window.confirm(question)) return;
  $('stop').disabled = true; stopping = true;
  try {
    if (!token) await session();
    const response = await fetch('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json', 'x-quoter-token': token }, body: JSON.stringify({ confirm: true }) });
    if (!response.ok) throw new Error((await response.json()).error || String(response.status));
  } catch (error) {
    stopping = false; $('stop').disabled = false;
    window.alert(`Не вдалося зупинити: ${error.message}`);
  }
});

session().then(() => { $('stop').disabled = false; }).catch(() => {}).finally(poll);
