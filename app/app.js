console.log('MISSIONS BUILD v3 — floor picker + switcher');
/* Zaha Missions — staff iPad app.
   The device is never signed in. It reads the board, and writes nothing
   except through submit_check(), which refuses to act without a PIN. */

const TZ = 'Europe/London';

/* This screen must be paired before it can read anything. The key it
   receives travels on every request; without it the database returns
   nothing, so the address alone gives away no part of the operation. */
const TOKEN_KEY = 'missions_device_token';
const AREA_KEY  = 'missions_device_area';
const getTok = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const setTok = t => { try { localStorage.setItem(TOKEN_KEY, t); } catch {} };
const clearTok = () => { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(AREA_KEY); } catch {} };

const makeClient = token => supabase.createClient(window.MISSIONS.url, window.MISSIONS.key,
  token ? { global: { headers: { 'x-device-token': token } } } : undefined);
let db = makeClient(getTok());

/* The iPad's own clock decides what time a record claims to be. A screen
   twenty minutes out would file wrong legal times, so we anchor to the
   server and correct for the difference. */
let CLOCK_OFFSET = 0;              // ms to add to this device's clock
let CLOCK_ANCHORED = false;
const serverNow = () => new Date(Date.now() + CLOCK_OFFSET);

const hhmm = iso => iso ? new Date(iso).toLocaleTimeString('en-GB',
  { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—';
const dayTime = iso => iso ? new Date(iso).toLocaleString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit',
    minute: '2-digit', timeZone: TZ }) : null;
const todayLondon = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let STATE = { stations: [], occ: [], shifts: [] };
let JOB = null;       // the check currently open
let LAST_JOB = null;  // kept so the finish screen knows what was just done

const $ = id => document.getElementById(id);
const sheet = () => $('sheet');
const panel = () => $('panel');

/* ---------------------------------------------------------------- board */

/* Which floor is this iPad? Chosen once and remembered. A switcher lets
   anyone look at the other floor, and it snaps back on its own — leftover
   state on a screen that belongs to nobody is how the wrong list reaches
   the next person. */
const HOME_KEY = 'missions_home_area';
const homeArea = () => { try { return localStorage.getItem(HOME_KEY); } catch { return null; } };
const setHomeArea = id => { try { localStorage.setItem(HOME_KEY, id); } catch {} };
let VIEWING = null;
let REVERT_AT = 0;

function pairScreen(err) {
  $('msg').classList.remove('hide');
  $('msg').innerHTML = `<h2>Set up this screen</h2>
    <p>Type the next unused code from the card kept with this iPad.
       Each code works once — cross it off after you use it.</p>
    ${err ? `<div class="pairerr">${esc(err)}</div>` : ''}
    <input class="paircode" id="pc" placeholder="XXXXXXXX" maxlength="8"
           autocapitalize="characters" autocomplete="off" spellcheck="false">
    <button class="bigbtn" id="pairgo">Set up</button>
    <p class="pairhelp">No codes left? A manager can issue more from the back
       office, wherever they are. If the screen still will not start, use the
       paper log and tell a manager.</p>`;
  const go = async () => {
    const code = ($('pc').value || '').trim().toUpperCase();
    if (code.length < 4) return;
    $('pairgo').textContent = 'Checking…';
    try {
      const probe = makeClient(null);
      const { data, error } = await probe.rpc('pair_device',
        { p_code: code, p_agent: navigator.userAgent });
      if (error) return pairScreen(error.message);
      if (!data.ok) return pairScreen(data.error);
      setTok(data.token);
      try { localStorage.setItem(AREA_KEY, data.area_id); } catch {}
      setHomeArea(data.area_id);
      db = makeClient(data.token);
      VIEWING = null;
      await pingDevice();
      load();
    } catch (e) { pairScreen('Could not reach the system. Check the wifi.'); }
  };
  $('pairgo').onclick = go;
  $('pc').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('pc').focus();
}

/* Checks in, corrects the clock, and learns if this screen has been
   revoked from the back office. */
async function pingDevice() {
  const t = getTok(); if (!t) return;
  try {
    const sent = Date.now();
    const { data, error } = await db.rpc('ping_device', { p_token: t });
    if (error || !data) return;
    if (data.revoked) {
      clearTok();
      db = makeClient(null);
      return pairScreen('This screen has been unlinked by a manager. Enter a new code.');
    }
    if (data.server_time) {
      const rtt = (Date.now() - sent) / 2;
      CLOCK_OFFSET = new Date(data.server_time).getTime() + rtt - Date.now();
      CLOCK_ANCHORED = true;
      const drift = Math.abs(CLOCK_OFFSET);
      const el = $('clockwarn');
      if (el) {
        if (drift > 120000) {
          el.textContent = `This iPad's clock is ${Math.round(drift/60000)} min out — times are being corrected automatically`;
          el.hidden = false;
        } else el.hidden = true;
      }
    }
  } catch {}
}

function backHome() { VIEWING = null; REVERT_AT = 0; load(); }
window.backHome = backHome;

function switchFloor() {
  const others = (STATE.areas || []).filter(a => a.id !== (VIEWING || homeArea()));
  if (!others.length) return;
  VIEWING = others[0].id;
  REVERT_AT = Date.now() + 120000;   // snaps back after two quiet minutes
  load();
}

async function load() {
  if (!getTok()) return pairScreen();

  const { data: areas, error: e1 } = await db.from('areas')
    .select('id,name,sort,stations(id,name,sort),shifts(id,name,starts,ends,sort)')
    .order('sort');
  if (e1) {
    if (await loadCached()) { refreshQueueBadge(); return; }
    return fail('Could not reach the database', e1.message);
  }
  // a paired screen always sees areas. Nothing back means the link was
  // revoked or the data is gone — send it round to pairing again.
  if (!areas?.length) {
    if (await loadCached()) { refreshQueueBadge(); return; }
    clearTok(); db = makeClient(null);
    return pairScreen('This screen is no longer linked. Enter a code from the card.');
  }
  STATE.areas = areas;
  if (!homeArea() || !areas.some(a => a.id === homeArea())) {
    let a = null; try { a = localStorage.getItem(AREA_KEY); } catch {}
    setHomeArea(a && areas.some(x => x.id === a) ? a : areas[0].id);
  }

  const area = areas.find(a => a.id === (VIEWING || homeArea()));
  STATE.area = area;

  // testing only: the reset button vanishes once the site has a go-live date
  const { data: site } = await db.from('sites').select('go_live').limit(1);
  STATE.testing = !!site && site.length > 0 && !site[0].go_live;

  STATE.stations = (area.stations || []).sort((a, b) => a.sort - b.sort);
  STATE.shifts = (area.shifts || []).sort((a, b) => a.sort - b.sort);

  if (!STATE.stations.length) {
    const home = areas.find(a => a.id === homeArea());
    $('msg').classList.remove('hide');
    $('msg').innerHTML = `<h2>${esc(area.name)} isn't set up yet</h2>
      <p>No stations have been added for this floor, so there is nothing to show.
         A manager can add them in the back end.</p>
      <button class="bigbtn" onclick="backHome()">Back to ${esc(home ? home.name : 'your floor')}</button>`;
    return;
  }

  // reminders are display-only: no schedule, no missions, nothing to sign
  const { data: rem } = await db.from('checks')
    .select('name,intro,station_id')
    .eq('kind', 'reminder')
    .in('station_id', STATE.stations.map(s => s.id));
  STATE.reminders = rem || [];

  const { data: occ, error: e2 } = await db.from('occurrences')
    .select('id,due_at,status,station_id,check_version_id,checks(id,name,kind,intro,est_minutes)')
    .eq('service_date', todayLondon())
    .in('station_id', STATE.stations.map(s => s.id))
    .order('due_at');
  if (e2) {
    if (await loadCached()) { refreshQueueBadge(); return; }
    return fail('Could not read today’s list', e2.message);
  }

  STATE.occ = occ || [];
  IDB.put('board', { k: 'last', stations: STATE.stations, shifts: STATE.shifts,
                     reminders: STATE.reminders, occ: STATE.occ,
                     date: todayLondon(), at: Date.now() }).catch(() => {});
  $('msg').classList.add('hide');
  render();
}

/* with no signal, draw the last board we saw — as long as it is today's */
async function loadCached() {
  try {
    const c = await IDB.get('board', 'last');
    if (!c || c.date !== todayLondon()) return false;
    STATE.stations = c.stations; STATE.shifts = c.shifts;
    STATE.reminders = c.reminders; STATE.occ = c.occ;
    $('msg').classList.add('hide');
    render();
    return true;
  } catch { return false; }
}

function fail(t, d) {
  $('msg').classList.remove('hide');
  $('msg').innerHTML = `<h2>${esc(t)}</h2><p>${esc(d)}</p>`;
}

function currentShift() {
  const now = new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: TZ });
  return STATE.shifts.find(s => now >= s.starts && now < s.ends);
}

/* The escalation ladder, in one place:
     later  – nothing yet
     soon   – within 30 min of due. Amber, quiet.
     due    – past its time. Clay/red, takes the hero slot.
     late   – 15 min past. Red, pulsing bar, everything else dims.   */
function urgency(o, now) {
  if (o.status !== 'pending' || !o.due_at) return 'later';
  const mins = (new Date(o.due_at) - now) / 60000;
  if (mins <= -15) return 'late';
  if (mins <= 0)   return 'due';
  if (mins <= 120) return 'next';   // the next couple of hours
  return 'later';
}

function render() {
  const now = new Date();
  $('clock').textContent =
    now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ })
    + ' · ' + hhmm(now.toISOString()) + ' · nobody signed in';
  const sh = currentShift();
  $('shiftname').textContent = sh
    ? `${sh.name} shift · ${sh.starts.slice(0, 5)}–${sh.ends.slice(0, 5)}`
    : 'Outside shift hours';

  const away = VIEWING && VIEWING !== homeArea();
  $('areaname').textContent = STATE.area ? STATE.area.name : '—';
  $('areaname').className = 'areaname' + (away ? ' away' : '');
  const vb = $('viewbar');
  if (away) {
    const left = Math.max(0, Math.ceil((REVERT_AT - Date.now()) / 1000));
    const home = (STATE.areas || []).find(a => a.id === homeArea());
    vb.innerHTML = `<b>Looking at ${esc(STATE.area.name)}</b>
      <span>This iPad belongs to ${esc(home ? home.name : 'the other floor')} —
        going back in ${left}s</span>
      <button class="vbtn" onclick="backHome()">Back now</button>`;
    vb.hidden = false;
  } else vb.hidden = true;

  const rbar = $('rembar');
  if (rbar) {
    const r = STATE.reminders || [];
    rbar.querySelector('.remtext').innerHTML = r.length
      ? r.map(x => `<b>${esc(x.name)}</b> — ${esc(x.intro || '')}`).join(' · ')
      : 'No reminders set';
  }

  const rb = $('resetbtn');
  if (rb) rb.style.display = STATE.testing ? '' : 'none';

  const cols = $('cols');
  cols.innerHTML = '';

  STATE.stations.forEach(st => {
    const mine  = STATE.occ.filter(o => o.station_id === st.id);
    const open  = mine.filter(o => o.status === 'pending');
    const shut  = mine.filter(o => o.status !== 'pending');
    const u     = o => urgency(o, now);
    const byTime = (a, b) => ((a.due_at || '9') < (b.due_at || '9') ? -1 : 1);

    const nowG   = open.filter(o => ['due','late'].includes(u(o)) || !o.due_at).sort(byTime);
    const nextG  = open.filter(o => u(o) === 'next').sort(byTime);
    const laterG = open.filter(o => u(o) === 'later').sort(byTime);
    const pct = mine.length ? Math.round(shut.filter(o=>o.status==='done').length / mine.length * 100) : 0;

    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `<div class="chead2">
        <div class="ctop"><span class="cname2">${esc(st.name)}</span>
          <span class="ccount">${shut.filter(o=>o.status==='done').length} / ${mine.length}</span></div>
        <div class="ctrack"><i style="width:${pct}%"></i></div>
      </div>`;

    const sc = document.createElement('div');
    sc.className = 'scroll';

    const rowFor = (o, cls) => {
      const uu = u(o);
      const b = document.createElement('button');
      b.className = 'row2 ' + (cls || '');
      b.innerHTML = `<span class="t2">${o.due_at ? hhmm(o.due_at) : '—'}</span>
        <span class="n2">${esc(o.checks.name)}</span>
        ${['due','late'].includes(uu) || !o.due_at
          ? `<span class="go2">${uu === 'late' ? 'Overdue' : 'Start'}</span>` : ''}`;
      b.onclick = () => openCheck(o);
      return b;
    };
    const group = (label, cls, items, rowCls) => {
      if (!items.length) return;
      sc.insertAdjacentHTML('beforeend',
        `<div class="glab2 ${cls}">${label}<span class="ln"></span></div>`);
      items.forEach(o => sc.appendChild(rowFor(o, rowCls ||
        (urgency(o, now) === 'late' ? 'late' : 'now'))));
    };

    group('Now', 'gnow', nowG);
    group('Next up', 'gnext', nextG, '');
    group('Later today', 'glater', laterG, 'dim');

    if (shut.length) {
      sc.insertAdjacentHTML('beforeend', `<div class="glab2 glater">Done<span class="ln"></span></div>`);
      shut.sort(byTime).forEach(o => sc.insertAdjacentHTML('beforeend',
        `<div class="row2 done"><span class="t2">${o.due_at ? hhmm(o.due_at) : '—'}</span>
         ${o.status === 'done'
           ? '<span class="tick2"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg></span>'
           : '<span class="dot fail"></span>'}
         <span class="n2">${esc(o.checks.name)}</span>
         <span class="rm">${o.status === 'missed' ? 'missed' : o.status === 'expired' ? '' : 'signed'}</span></div>`));
    }
    if (!open.length) {
      sc.insertAdjacentHTML('afterbegin',
        `<div class="glab2 gnext">All done<span class="ln"></span></div>
         <div class="row2 done"><span class="n2">Nothing outstanding on this side.</span></div>`);
    }
    col.appendChild(sc);
    cols.appendChild(col);
  });

  const pending = STATE.occ.filter(o => o.status === 'pending');
  const lates = STATE.occ.filter(o => urgency(o, now) === 'late')
                         .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  cols.classList.toggle('hasLate', lates.length > 0);
  // when everything outstanding is late, dimming communicates nothing
  cols.classList.toggle('allLate', lates.length > 0 && lates.length === pending.length);

  const bar = $('alertbar');
  if (lates.length) {
    const worst = lates[0];
    const mins = Math.round((now - new Date(worst.due_at)) / 60000);
    const station = STATE.stations.find(s => s.id === worst.station_id);
    bar.innerHTML = `<b>${lates.length} overdue</b>
      <span>Oldest: ${esc(worst.checks.name)} · ${esc(station ? station.name : '')} · ${mins} min late</span>
      <button class="cnt">${SHOW_LATE ? 'Hide list' : 'Show all ' + lates.length}</button>`;
    bar.querySelector('.cnt').onclick = () => { SHOW_LATE = !SHOW_LATE; render(); };
    bar.hidden = false;
    drawLateList(lates, now);
  } else { bar.hidden = true; $('latelist').hidden = true; }
}

/* Which ones? Every overdue mission, grouped by station, each one tappable.
   The bar catches the eye; this answers the question it raises. */
let SHOW_LATE = false;

function drawLateList(lates, now) {
  const box = $('latelist');
  if (!SHOW_LATE) { box.hidden = true; return; }
  box.innerHTML = '';
  STATE.stations.forEach(st => {
    const mine = lates.filter(o => o.station_id === st.id);
    if (!mine.length) return;
    box.insertAdjacentHTML('beforeend',
      `<div class="lgrp">${esc(st.name)} — ${mine.length} overdue</div>`);
    mine.forEach(o => {
      const mins = Math.round((now - new Date(o.due_at)) / 60000);
      const b = document.createElement('button');
      b.className = 'laterow';
      b.innerHTML = `<span class="lt">${hhmm(o.due_at)}</span>
        <span class="ln2">${esc(o.checks.name)}</span>
        <span class="lm">${mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + ' min'} late</span>`;
      b.onclick = () => { SHOW_LATE = false; openCheck(o); };
      box.appendChild(b);
    });
  });
  box.hidden = false;
}

/* ------------------------------------------------------------ open a job */

async function openCheck(o) {
  JOB = { occ: o, kind: o.checks.kind, items: [], ticked: new Set(), photos: {}, values: {}, skips: {} };
  sheet().classList.add('open');
  panel().innerHTML = `<div class="phead"><div class="ptitle">${esc(o.checks.name)}</div>
    <p class="pmeta">Loading…</p></div>`;

  const k = JOB.kind;
  const q = k === 'temperature'
    ? db.from('units').select('id,sort,name,limit_kind,limit_c,basis,guidance,guidance_image')
        .eq('check_version_id', o.check_version_id).order('sort')
    : k === 'count'
    ? db.from('count_items').select('id,sort,name,reorder_level,unit_label,guidance,guidance_image')
        .eq('check_version_id', o.check_version_id).order('sort')
    : k === 'incident'
    ? Promise.resolve({ data: [], error: null })
    : db.from('steps').select('id,sort,text,photo_required,guidance,guidance_image')
        .eq('check_version_id', o.check_version_id).order('sort');
  const { data, error } = await q;
  if (error) { panel().innerHTML = `<div class="phead"><div class="ptitle">Could not load</div>
    <p class="pmeta">${esc(error.message)}</p></div>`; return; }

  JOB.items = data || [];
  drawJob();
}

function drawJob() {
  const o = JOB.occ, k = JOB.kind;
  if (k === 'incident') return drawIncident();
  const body = k === 'temperature' ? JOB.items.map(drawUnit).join('')
             : k === 'count'       ? JOB.items.map(drawCount).join('')
             :                       JOB.items.map((x,i) => drawStep(x,i)).join('');
  const total = JOB.items.length;
  const doneN = k === 'temperature'
    ? Object.keys(JOB.values).length + Object.keys(JOB.skips).length
    : k === 'count' ? Object.keys(JOB.values).length
    : JOB.ticked.size;
  const ready = doneN === total;
  const isTemp = k === 'temperature';

  // A checklist can ALWAYS be signed off. Refusing until every box is
  // ticked does not produce complete checks — it produces ticked boxes
  // for jobs nobody did. Anything missed has to carry a reason instead.
  const isList = k === 'checklist';
  const canSign = isList ? doneN > 0 || total === 0 : ready;
  const missing = total - doneN;

  panel().innerHTML = `
    <div class="jprog">
      <button class="pback">← Back</button>
      <div class="jtop"><b>${esc(o.checks.name)}</b>
        <span>${doneN} / ${total}</span></div>
      <div class="ctrack"><i style="width:${total ? Math.round(doneN/total*100) : 0}%"></i></div>
    </div>
    ${o.checks.intro ? `<div class="pintro">${esc(o.checks.intro)}</div>` : ''}
    <div class="pbody">${body}</div>
    <div class="pfoot">
      <button class="signbtn ${canSign ? '' : 'off'}" ${canSign ? '' : 'disabled'}>
        ${!canSign ? `${missing} still to ${isTemp ? 'read' : k === 'count' ? 'count' : 'do'}`
          : missing > 0 ? `Sign off — ${missing} not done`
          : 'Sign off with your PIN'}
      </button>
    </div>`;

  panel().querySelector('.pback').onclick = closeSheet;
  panel().querySelectorAll('[data-tick]').forEach(b => b.onclick = () => tick(b.dataset.tick));
  panel().querySelectorAll('[data-photo]').forEach(b => b.onclick = () => takePhoto(b.dataset.photo));
  panel().querySelectorAll('[data-guide]').forEach(b => b.onclick = () =>
    $('g' + b.dataset.guide).classList.toggle('open'));
  panel().querySelectorAll('[data-unit]').forEach(b => b.onclick = () => keypad(b.dataset.unit));
  panel().querySelectorAll('[data-count]').forEach(b => b.onclick = () => countPad(b.dataset.count));
  const s = panel().querySelector('.signbtn:not(.off)');
  if (s) s.onclick = () => askPin();
}

function drawStep(x, i) {
  const on = JOB.ticked.has(x.id);
  const shot = JOB.photos[x.id];
  const needs = x.photo_required && !shot;
  const has = x.guidance || x.guidance_image;
  return `<div class="step2 ${on ? 'on' : ''}">
      <span class="snum">${i + 1}</span>
      <button class="sbox ${on ? 'on' : ''} ${needs ? 'cam' : ''}" ${needs ? 'disabled' : `data-tick="${x.id}"`}>
        ${on ? '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>' : ''}
      </button>
      <span class="stx2">${esc(x.text)}</span>
      ${x.photo_required ? (shot
        ? `<span class="shot">Photo ✓</span>`
        : `<button class="scam" data-photo="${x.id}">Photo</button>`) : ''}
      ${has ? `<button class="pqs" data-guide="${x.id}">?</button>` : ''}
    </div>
    ${has ? `<div class="guide" id="g${x.id}">
        ${x.guidance ? `<p>${esc(x.guidance)}</p>` : ''}
        ${x.guidance_image ? `<img src="${esc(x.guidance_image)}" alt="How to do this" loading="lazy">` : ''}
      </div>` : ''}`;
}

function drawUnit(u) {
  const v = JOB.values[u.id];
  const sk = JOB.skips[u.id];
  if (sk) return `<button class="unit skip" data-unit="${u.id}">
      <span class="uname">${esc(u.name)}</span>
      <span class="ulim">${esc(sk)}</span>
      <span class="uval">n/a</span>
    </button>`;
  const has = v !== undefined;
  const pass = has && (u.limit_kind === 'max' ? v <= u.limit_c : v >= u.limit_c);
  return `<button class="unit ${has ? (pass ? 'pass' : 'fail') : ''}" data-unit="${u.id}">
      <span class="uname">${esc(u.name)}</span>
      <span class="ulim">${u.limit_kind === 'min' ? 'at least' : 'no more than'} ${u.limit_c}°C</span>
      <span class="uval">${has ? v + '°' : 'tap'}</span>
    </button>
    ${u.guidance_image ? `<img class="guideimg" src="${esc(u.guidance_image)}" alt="" loading="lazy">` : ''}`;
}

function tick(id) {
  JOB.ticked.has(id) ? JOB.ticked.delete(id) : JOB.ticked.add(id);
  drawJob();
}

/* -------------------------------------------------------------- photos */

function takePhoto(stepId) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    toast('Saving photo…');
    try {
      const blob = await shrink(f);
      const path = `${JOB.occ.id}/${stepId}-${Date.now()}.jpg`;
      JOB.pendingPhotos = JOB.pendingPhotos || [];

      if (navigator.onLine) {
        const { error } = await db.storage.from('evidence').upload(path, blob,
          { contentType: 'image/jpeg' });
        // offline mid-shot: keep the image and send it with the record later
        if (error) JOB.pendingPhotos.push({ stepId, path, blob });
      } else {
        JOB.pendingPhotos.push({ stepId, path, blob });
      }
      JOB.photos[stepId] = path;
      if (stepId !== 'incident') JOB.ticked.add(stepId);
      toast('');
      drawJob();
    } catch (e) { toast(''); alert('Photo did not save: ' + e.message); }
  };
  inp.click();
}

// keep evidence photos small — the retention sums assume ~150KB each
function shrink(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const max = 1200, s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? res(b) : rej(new Error('could not compress')), 'image/jpeg', 0.7);
    };
    img.onerror = () => rej(new Error('could not read the image'));
    img.src = URL.createObjectURL(file);
  });
}

/* ------------------------------------------------------ temperature pad */

function keypad(unitId) {
  const u = JOB.items.find(x => x.id === unitId);
  let buf = '';
  const ov = document.createElement('div');
  ov.className = 'ov';
  const draw = () => {
    const v = parseFloat(buf);
    const has = buf !== '' && !isNaN(v);
    const pass = has && (u.limit_kind === 'max' ? v <= u.limit_c : v >= u.limit_c);
    ov.innerHTML = `<div class="pad">
      <div class="padh">
        <div class="padname">${esc(u.name)}</div>
        <div class="padlim">${u.limit_kind === 'min' ? 'Must be at least' : 'Must be no more than'} ${u.limit_c}°C</div>
        <div class="padnum">${buf === '' ? '—' : esc(buf)}<small>°C</small></div>
        ${has ? `<div class="verdict ${pass ? 'pass' : 'fail'}">${pass ? 'In range' : 'Out of range'}</div>` : ''}
      </div>
      <div class="keys">
        ${'123456789'.split('').map(n => `<button class="key" data-k="${n}">${n}</button>`).join('')}
        <button class="key" data-k="-">−</button>
        <button class="key" data-k="0">0</button>
        <button class="key" data-k=".">.</button>
        <button class="key wide" data-k="del">⌫</button>
        <button class="key save ${has ? '' : 'off'}" data-k="ok" ${has ? '' : 'disabled'}>Save</button>
      </div>
      <button class="padna">Not out today</button>
      <button class="padcancel">Cancel</button>
    </div>`;
    ov.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
      const k = b.dataset.k;
      if (k === 'del') buf = buf.slice(0, -1);
      else if (k === 'ok') { JOB.values[unitId] = parseFloat(buf); ov.remove(); drawJob(); return; }
      else if (k === '-') buf = buf.startsWith('-') ? buf.slice(1) : '-' + buf;
      else if (k === '.' && buf.includes('.')) { /* one only */ }
      else buf += k;
      draw();
    });
    ov.querySelector('.padcancel').onclick = () => ov.remove();
    ov.querySelector('.padna').onclick = () => {
      ov.innerHTML = `<div class="pad">
        <div class="padh">
          <div class="padname">${esc(u.name)}</div>
          <div class="padlim">Why is there nothing to measure?</div>
        </div>
        <div class="reasons">
          ${['Sold out','Not on the menu today','Not out yet','Equipment off']
            .map(r => `<button class="opt" data-r="${esc(r)}">${esc(r)}</button>`).join('')}
        </div>
        <button class="padcancel">Back</button></div>`;
      ov.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
        JOB.skips[unitId] = b.dataset.r;
        delete JOB.values[unitId];
        ov.remove(); drawJob();
      });
      ov.querySelector('.padcancel').onclick = () => draw();
    };
  };
  draw();
  document.body.appendChild(ov);
}

/* ----------------------------------------------------------- PIN + send */

/* Four digits while testing. Change PIN_LENGTH back to 6 — and add a
   lockout — before this carries real records. */
const PIN_LENGTH = 4;

function askPin(onDone) {
  let buf = '';
  const ov = document.createElement('div');
  ov.className = 'ov';
  const draw = (err) => {
    ov.innerHTML = `<div class="pad pin">
      <div class="padh">
        <div class="padlim">Who is signing this off?</div>
        <div class="padname">Enter your ${PIN_LENGTH}-digit PIN</div>
        <div class="dots">${Array.from({length: PIN_LENGTH}, (_, i) => i).map(i =>
          `<span class="dot2 ${i < buf.length ? 'on' : ''}"></span>`).join('')}</div>
        ${err ? `<div class="verdict fail">${esc(err)}</div>` : ''}
      </div>
      <div class="keys">
        ${'123456789'.split('').map(n => `<button class="key" data-k="${n}">${n}</button>`).join('')}
        <button class="key ghost" data-k="cancel">Cancel</button>
        <button class="key" data-k="0">0</button>
        <button class="key" data-k="del">⌫</button>
      </div></div>`;
    ov.querySelectorAll('[data-k]').forEach(b => b.onclick = async () => {
      const k = b.dataset.k;
      if (k === 'cancel') return ov.remove();
      if (k === 'del') { buf = buf.slice(0, -1); return draw(); }
      if (buf.length >= PIN_LENGTH) return;
      buf += k; draw();
      if (buf.length === PIN_LENGTH) {
        ov.querySelector('.padh').innerHTML = '<div class="padname">Checking…</div>';
        const res = onDone ? await onDone(buf) : await submit(buf);
        if (res && res.error) { buf = ''; draw(res.error); }
        else ov.remove();
      }
    });
  };
  draw();
  document.body.appendChild(ov);
}

async function submit(pin) {
  const k = JOB.kind;
  const args = { p_pin: pin, p_occurrence: JOB.occ.id };
  if (k === 'count') {
    args.p_counts = Object.entries(JOB.values).map(([item_id, qty]) => ({ item_id, qty }));
  } else if (k === 'incident') {
    args.p_what = JOB.what; args.p_severity = JOB.sev;
    if (JOB.photos.incident) args.p_photo = JOB.photos.incident;
  } else if (k === 'temperature') {
    args.p_readings = [
      ...Object.entries(JOB.values).map(([unit_id, value]) => ({ unit_id, value })),
      ...Object.entries(JOB.skips).map(([unit_id, reason]) => ({ unit_id, skipped: true, reason }))
    ];
  } else {
    args.p_steps = JOB.items.map(x => JOB.ticked.has(x.id)
      ? { step_id: x.id, done: true, photo: JOB.photos[x.id] || null }
      : { step_id: x.id, done: false });
  }
  // when it ACTUALLY happened. Survives a late sync — the server keeps
  // both this and its own arrival time.
  args.p_recorded_at = serverNow().toISOString();

  if (!navigator.onLine) {
    await queueSubmission(args, JOB.pendingPhotos || []);
    markDoneLocally();
    closeSheet();
    celebrate({ signed_by: 'Saved on this iPad', was_late: false }, false, true);
    return {};
  }

  let data, error;
  try {
    ({ data, error } = await db.rpc('submit_check', args));
  } catch (e) { error = e; }

  // a network failure is not a refusal — hold it rather than lose it
  if (error && (!navigator.onLine || /fetch|network|failed/i.test(error.message || ''))) {
    await queueSubmission(args, JOB.pendingPhotos || []);
    markDoneLocally();
    closeSheet();
    celebrate({ signed_by: 'Saved on this iPad', was_late: false }, false, true);
    return {};
  }
  if (error) return { error: error.message };
  if (!data.ok) {
    if (/already/i.test(data.error)) {
      await load();
      closeSheet();
      toast('Someone else already signed that one off');
      setTimeout(() => toast(''), 3500);
      return {};
    }
    return { error: data.error };
  }

  const o = STATE.occ.find(x => x.id === JOB.occ.id);
  if (o) o.status = 'done';
  render();

  if (data.failures && data.failures.length) { corrective(data.failures, 0, data); return; }
  closeSheet(); celebrate(data);
}

/* --------------------------------------------------- corrective action */

function corrective(fails, i, sub) {
  const f = fails[i];
  const started = f.started_at ? dayTime(f.started_at) : null;
  const basis = {
    last_pass_today:  'last confirmed good today',
    last_check_today: 'last checked today',
    shift_start:      'no earlier check today — since the shift opened',
    staff:            'you said',
    unknown:          'not known'
  }[f.started_basis] || '';
  let food = '', qty = '', act = '', override = null;

  const draw = () => {
    panel().innerHTML = `
      <div class="alert">
        <div class="alertt">${esc(f.unit)} is out of range — ${f.value}°C</div>
        <div class="alerts">Limit is ${f.limit}°C. This has to be recorded before you carry on.</div>
      </div>
      <div class="pbody">
        <p class="calead">The law needs six things. <b>We already know four.</b></p>
        <div class="known">
          <div><span>When it started</span><b>${started ? esc(started) : 'Not known'}</b>
            <i>${esc(basis)}</i><button class="tiny" id="fix">Change</button></div>
          <div><span>How far out</span><b>${Math.abs(f.value - f.limit).toFixed(1)}°C ${f.limit_kind === 'min' ? 'below' : 'above'}</b></div>
          <div><span>Who found it</span><b>${esc(sub.signed_by)}</b><i>just now</i></div>
          <div><span>Back to normal</span><b>Re-check in 30 minutes</b></div>
        </div>
        <div class="ask"><span class="asklab">What food, and how much?</span>
          <div class="opts" id="foods">
            ${['Prepped salads', 'Dairy', 'Raw meat', esc(f.unit)].map(x =>
              `<button class="opt ${food === x ? 'on' : ''}" data-f="${esc(x)}">${esc(x)}</button>`).join('')}
          </div>
          <input class="inp" id="qty" placeholder="How much? e.g. one full tray" value="${esc(qty)}">
        </div>
        <div class="ask"><span class="asklab">What did you do?</span>
          <div class="opts" id="acts">
            ${['Binned it', 'Moved to another unit', 'Reheated', 'Called engineer'].map(x =>
              `<button class="opt ${act === x ? 'on' : ''}" data-a="${esc(x)}">${esc(x)}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="pfoot">
        <button class="signbtn ${food && act ? '' : 'off'}" ${food && act ? '' : 'disabled'}>
          ${food && act ? 'Save record with your PIN' : 'Answer both questions'}
        </button>
      </div>`;
    panel().querySelectorAll('[data-f]').forEach(b => b.onclick = () => { food = b.dataset.f; draw(); });
    panel().querySelectorAll('[data-a]').forEach(b => b.onclick = () => { act = b.dataset.a; draw(); });
    panel().querySelector('#qty').oninput = e => qty = e.target.value;
    $('fix').onclick = () => {
      const t = prompt('When was it last definitely fine? e.g. 13:00', '');
      if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return;
      const d = new Date(); const [h, m] = t.split(':');
      d.setHours(+h, +m, 0, 0); override = d.toISOString(); draw();
    };
    const s = panel().querySelector('.signbtn:not(.off)');
    if (s) s.onclick = () => askPin(async pin => {
      const { data, error } = await db.rpc('submit_corrective', {
        p_pin: pin, p_reading: f.reading_id, p_food: food,
        p_quantity: qty || 'not stated', p_action: act, p_started_at: override
      });
      if (error) return { error: error.message };
      if (!data.ok) return { error: data.error };
      if (i + 1 < fails.length) { corrective(fails, i + 1, sub); return; }
      closeSheet(); celebrate(sub, true);
    });
  };
  draw();
}

/* ------------------------------------------------------------ finishing */

function celebrate(sub, hadFailure, offline) {
  const J = JOB || LAST_JOB;
  const st = STATE.stations.find(x => x.id === (J ? J.occ.station_id : null))
          || STATE.stations[0];
  const name = J ? J.occ.checks.name : '';
  const now = serverNow();
  const mine = STATE.occ.filter(o => st && o.station_id === st.id);
  const doneN = mine.filter(o => o.status === 'done').length;
  const next = mine.filter(o => o.status === 'pending')
    .sort((a, b) => ((a.due_at || '9') < (b.due_at || '9') ? -1 : 1))[0];

  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.innerHTML = `<div class="donebox doneb">
    <div class="tickc ${offline ? 'offl' : hadFailure ? 'warn' : ''}">
      <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg></div>
    <h2 style="font-size:23px">${offline ? 'Saved on this iPad' : esc(name)}</h2>
    <p>${offline
        ? 'No connection. It will send itself when the wifi is back, and the record will show '
          + hhmm(now.toISOString()) + ' — the time you did it.'
        : 'Signed by ' + esc(sub.signed_by) + ' at ' + hhmm(now.toISOString())
          + (sub.was_late ? ' · ' + sub.minutes_late + ' min late' : '')}</p>
    ${sub.steps_missed ? `<p class="warnline">${sub.steps_done} of ${sub.steps_total} done —
        the rest recorded as not done. A manager has been told.</p>` : ''}
    ${hadFailure ? '<p class="warnline">Recorded as a failure. A manager has been alerted.</p>' : ''}
    ${st ? `<p style="font-size:13px;font-weight:500;color:var(--pass);margin-top:6px">
        ${doneN} of ${mine.length} done on ${esc(st.name)}</p>` : ''}
    ${next ? `<div class="donen">
        <div class="donelab">Due next</div>
        <button class="row2 now" id="gonext" style="margin:0">
          <span class="t2">${next.due_at ? hhmm(next.due_at) : '—'}</span>
          <span class="n2">${esc(next.checks.name)}</span>
          <span class="go2">Start</span></button>
        <div class="doneor">or go back to the board</div>
      </div>` : `<div class="donen"><div class="donelab">Nothing left on this side</div></div>`}
  </div>`;
  document.body.appendChild(ov);
  const go = ov.querySelector('#gonext');
  if (go) go.onclick = () => { ov.remove(); openCheck(next); };
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  setTimeout(() => { if (document.body.contains(ov)) ov.remove(); }, 9000);
}

function markDoneLocally() {
  const o = STATE.occ.find(x => x.id === JOB.occ.id);
  if (o) o.status = 'done';
  render();
}

function closeSheet() { LAST_JOB = JOB; sheet().classList.remove('open'); JOB = null; }
function toast(t) {
  let el = $('toast');
  if (!t) { el && el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = t;
}

const swb = $('switchbtn');
if (swb) swb.onclick = switchFloor;

sheet().onclick = e => { if (e.target.id === 'sheet') closeSheet(); };

/* The iPad stays on all day, so the board has to refresh itself.
   Three ways, because a wall-mounted screen nobody touches must not
   quietly show yesterday:
     - the clock reruns every 30s
     - the data reloads every 2 min, and immediately if the date changed
     - a live subscription reacts to anything signed off elsewhere     */
let SEEN_DAY = todayLondon();

setInterval(() => {
  if (VIEWING && Date.now() > REVERT_AT && !JOB) return backHome();
  if (VIEWING && !JOB) render();   // keep the countdown honest
  if (JOB) return;                 // never yank the screen out from under someone
  if (todayLondon() !== SEEN_DAY) { SEEN_DAY = todayLondon(); load(); return; }
  render();
}, 30000);

setInterval(() => { if (!JOB) load(); }, 120000);

db.channel('board')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'occurrences' },
      () => { if (!JOB) load(); })
  .subscribe();

load();


/* ---- testing only ---- */
const resetBtn = $('resetbtn');
if (resetBtn) resetBtn.onclick = async () => {
  if (!confirm('Put today\'s missions back to the start and delete today\'s test records?')) return;
  toast('Resetting…');
  const { data, error } = await db.rpc('reset_today');
  toast('');
  if (error) return alert(error.message);
  if (!data.ok) return alert(data.error);
  await load();
  toast(`Reset — ${data.missions_reopened} missions reopened`);
  setTimeout(() => toast(''), 2500);
};


/* ------------------------------------------------------------- counts */

function drawCount(it) {
  const q = JOB.values[it.id];
  const has = q !== undefined;
  const low = has && it.reorder_level != null && q < it.reorder_level;
  return `<button class="unit ${has ? (low ? 'fail' : 'pass') : ''}" data-count="${it.id}">
      <span class="uname">${esc(it.name)}</span>
      <span class="ulim">${it.reorder_level != null
        ? 'order below ' + it.reorder_level + (it.unit_label ? ' ' + esc(it.unit_label) : '')
        : (it.unit_label ? esc(it.unit_label) : '')}</span>
      <span class="uval">${has ? q : 'tap'}</span>
    </button>`;
}

function countPad(itemId) {
  const it = JOB.items.find(x => x.id === itemId);
  let buf = '';
  const ov = document.createElement('div');
  ov.className = 'ov';
  const draw = () => {
    const q = parseInt(buf, 10);
    const has = buf !== '' && !isNaN(q);
    const low = has && it.reorder_level != null && q < it.reorder_level;
    ov.innerHTML = `<div class="pad">
      <div class="padh">
        <div class="padname">${esc(it.name)}</div>
        <div class="padlim">${it.reorder_level != null
          ? 'Re-order below ' + it.reorder_level + (it.unit_label ? ' ' + esc(it.unit_label) : '')
          : 'How many on the shelf?'}</div>
        <div class="padnum">${buf === '' ? '—' : esc(buf)}</div>
        ${has ? `<div class="verdict ${low ? 'fail' : 'pass'}">${low ? 'Running low — add to the order' : 'Enough in stock'}</div>` : ''}
      </div>
      <div class="keys">
        ${'123456789'.split('').map(n => `<button class="key" data-k="${n}">${n}</button>`).join('')}
        <button class="key" data-k="del">⌫</button>
        <button class="key" data-k="0">0</button>
        <button class="key save ${has ? '' : 'off'}" data-k="ok" ${has ? '' : 'disabled'}>Save</button>
      </div>
      <button class="padcancel">Cancel</button></div>`;
    ov.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
      const kk = b.dataset.k;
      if (kk === 'del') buf = buf.slice(0, -1);
      else if (kk === 'ok') { JOB.values[itemId] = parseInt(buf, 10); ov.remove(); drawJob(); return; }
      else buf += kk;
      draw();
    });
    ov.querySelector('.padcancel').onclick = () => ov.remove();
  };
  draw();
  document.body.appendChild(ov);
}

/* ---------------------------------------------------------- incidents */

function drawIncident() {
  const o = JOB.occ;
  JOB.sev = JOB.sev || 'low';
  JOB.what = JOB.what || '';
  const ready = JOB.what.trim().length > 3;
  panel().innerHTML = `
    <div class="phead">
      <button class="pback">← Back</button>
      <div class="ptitle">${esc(o.checks.name)}</div>
      <p class="pmeta">Reported whenever it happens · never overdue</p>
    </div>
    ${o.checks.intro ? `<div class="pintro">${esc(o.checks.intro)}</div>` : ''}
    <div class="pbody">
      <div class="ask"><span class="asklab">How serious is it?</span>
        <div class="opts">
          ${[['low','Minor'],['medium','Needs attention'],['high','Urgent']].map(([v, l]) =>
            `<button class="opt ${JOB.sev === v ? 'on' : ''}" data-sev="${v}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="ask"><span class="asklab">What happened?</span>
        <textarea class="inp ta" id="what" placeholder="Say it plainly — what, where, and anything you did about it">${esc(JOB.what)}</textarea>
      </div>
      <div class="ask"><span class="asklab">Photo</span>
        ${JOB.photos.incident
          ? `<div class="shotrow">Photo attached ✓</div>`
          : `<button class="needphoto" data-photo="incident">Take photo</button>`}
      </div>
    </div>
    <div class="pfoot">
      <button class="signbtn ${ready ? '' : 'off'}" ${ready ? '' : 'disabled'}>
        ${ready ? 'Report it with your PIN' : 'Describe what happened'}
      </button>
    </div>`;
  panel().querySelector('.pback').onclick = closeSheet;
  panel().querySelectorAll('[data-sev]').forEach(b => b.onclick = () => { JOB.sev = b.dataset.sev; drawIncident(); });
  panel().querySelector('#what').oninput = e => {
    JOB.what = e.target.value;
    const btn = panel().querySelector('.signbtn');
    const ok = JOB.what.trim().length > 3;
    btn.classList.toggle('off', !ok); btn.disabled = !ok;
    btn.textContent = ok ? 'Report it with your PIN' : 'Describe what happened';
    if (ok) btn.onclick = () => askPin();
  };
  panel().querySelectorAll('[data-photo]').forEach(b => b.onclick = () => takePhoto('incident'));
  const sgn = panel().querySelector('.signbtn:not(.off)');
  if (sgn) sgn.onclick = () => askPin();
}

/* ================================================================
   OFFLINE
   The wall iPad must keep working with no signal. Three parts:
     - a service worker so the app opens at all
     - a queue in IndexedDB so a signed record is never lost
     - a stamped time, so a record that syncs late still says when it
       actually happened
   ================================================================ */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

const IDB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('missions', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('board')) d.createObjectStore('board', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => res(out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    put:  (store, v) => tx(store, 'readwrite', s => s.put(v)),
    all:  (store)    => tx(store, 'readonly',  s => s.getAll()),
    del:  (store, k) => tx(store, 'readwrite', s => s.delete(k)),
    get:  (store, k) => tx(store, 'readonly',  s => s.get(k))
  };
})();

let ONLINE = navigator.onLine;
let QUEUED = 0;

async function refreshQueueBadge() {
  try {
    const q = await IDB.all('queue');
    QUEUED = q.length;
  } catch { QUEUED = 0; }
  const el = $('netstate');
  if (!el) return;
  if (!ONLINE) {
    el.hidden = false;
    el.className = 'netstate off';
    el.textContent = QUEUED
      ? `No connection — ${QUEUED} saved on this iPad, will send when back online`
      : 'No connection — checks will be saved here and sent when back online';
  } else if (QUEUED) {
    el.hidden = false;
    el.className = 'netstate sync';
    el.textContent = `Sending ${QUEUED} saved ${QUEUED === 1 ? 'check' : 'checks'}…`;
  } else {
    el.hidden = true;
  }
}

window.addEventListener('online',  () => { ONLINE = true;  refreshQueueBadge(); flushQueue(); load(); });
window.addEventListener('offline', () => { ONLINE = false; refreshQueueBadge(); });

/* a submission that could not reach the server, kept until it can */
async function queueSubmission(args, photoBlobs) {
  const id = 'q' + Date.now() + Math.random().toString(16).slice(2);
  await IDB.put('queue', { id, args, photoBlobs: photoBlobs || [], at: Date.now() });
  await refreshQueueBadge();
  return id;
}

async function flushQueue() {
  if (!navigator.onLine) return;
  let items = [];
  try { items = await IDB.all('queue'); } catch { return; }
  for (const it of items) {
    try {
      const args = { ...it.args };
      // photos were held as blobs; upload them now and swap in the paths
      for (const ph of it.photoBlobs || []) {
        const { error } = await db.storage.from('evidence')
          .upload(ph.path, ph.blob, { contentType: 'image/jpeg' });
        if (error && !/exists/i.test(error.message)) throw error;
        if (ph.stepId === 'incident') args.p_photo = ph.path;
        else if (args.p_steps) {
          const st = args.p_steps.find(s => s.step_id === ph.stepId);
          if (st) st.photo = ph.path;
        }
      }
      const { data, error } = await db.rpc('submit_check', args);
      if (error) throw error;
      // a rejection from the server is final — keeping it would retry forever
      await IDB.del('queue', it.id);
      if (data && data.ok === false) console.warn('queued item refused:', data.error);
    } catch (e) {
      break;   // still unreachable; leave the rest for next time
    }
  }
  await refreshQueueBadge();
  if (navigator.onLine) load();
}

setInterval(flushQueue, 30000);
setInterval(pingDevice, 180000);     // every 3 min: last seen, clock, revocation
pingDevice();
refreshQueueBadge();
flushQueue();
