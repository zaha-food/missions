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
// on a one-station screen the open task lives ON the board, not in a pop-up
let INLINE_EL = null;
const panel = () => (JOB && JOB.inline && INLINE_EL) ? INLINE_EL : $('panel');

/* Is someone in the middle of something? Then the screen must not be
   redrawn underneath them. A task open on the board is not "busy" — its
   ticks are kept, and redrawing leaves it exactly as it was. */
function busy() {
  return !!document.querySelector('.ov') || !!(JOB && (!JOB.inline || JOB.hold));
}

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
  const { data: site } = await db.from('sites').select('go_live,opens_at').limit(1);
  STATE.testing = !!site && site.length > 0 && !site[0].go_live;

  STATE.stations = (area.stations || []).sort((a, b) => a.sort - b.sort);
  // A screen can belong to ONE station — the guides' iPad, the makers'
  // iPad. Set remotely in Devices; empty means the whole floor.
  const { data: scr } = await db.rpc('my_screen');
  const wasSolo = STATE.solo;
  STATE.solo = null;
  if (!VIEWING && scr && scr.station_id) {
    const only = STATE.stations.find(s => s.id === scr.station_id);
    if (only) { STATE.stations = [only]; STATE.solo = only.id; }
  }
  // switched back to the whole floor: the task open on the board goes with it
  if (wasSolo && !STATE.solo && JOB && JOB.inline) JOB = null;
  STATE.shifts = (area.shifts || []).sort((a, b) => a.sort - b.sort);
  STATE.opensAt = site && site[0] ? site[0].opens_at : null;

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
    .select('id,due_at,appears_at,status,station_id,check_version_id,checks(id,name,kind,intro,est_minutes)')
    .eq('service_date', todayLondon())
    .in('station_id', STATE.stations.map(s => s.id))
    .order('due_at');
  if (e2) {
    if (await loadCached()) { refreshQueueBadge(); return; }
    return fail('Could not read today’s list', e2.message);
  }

  STATE.occ = occ || [];
  pruneDrafts();
  const lists = [...new Set(STATE.occ.filter(o => o.checks.kind === 'checklist').map(o => o.check_version_id))];
  STATE.estByVer = {};
  if (lists.length) {
    const { data: se } = await db.from('steps').select('check_version_id,est_minutes').in('check_version_id', lists);
    (se || []).forEach(x => { if (x.est_minutes) STATE.estByVer[x.check_version_id] =
      (STATE.estByVer[x.check_version_id] || 0) + x.est_minutes; });
  }
  // who signed each done task, and how much of it is really done —
  // a part-done task stays on the board until its last line is finished
  const { data: dn } = await db.rpc('board_done', { p_date: todayLondon() });
  STATE.done = {};
  (dn || []).forEach(d => STATE.done[d.occurrence_id] = d);
  IDB.put('board', { k: 'last', stations: STATE.stations, shifts: STATE.shifts,
    opensAt: STATE.opensAt, done: STATE.done, solo: STATE.solo, estByVer: STATE.estByVer,
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
    STATE.stations = c.stations; STATE.shifts = c.shifts; STATE.opensAt = c.opensAt;
    STATE.reminders = c.reminders; STATE.occ = c.occ; STATE.done = c.done || {}; STATE.solo = c.solo || null; STATE.estByVer = c.estByVer || {};
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
  // inside its window ("any time between 10:00 and 11:20") it is a job
  // for now, not for later — the opening must read as Start at 10:00
  if (o.appears_at && new Date(o.appears_at) <= now) return 'due';
  if (mins <= 120) return 'next';   // the next couple of hours
  return 'later';
}

// its window has not opened — it can be looked at, not signed
function notYet(o) {
  return !!o && o.status === 'pending' && !!o.appears_at && new Date(o.appears_at) > serverNow();
}

// signed off, but with lines left undone and not yet finished
function partDone(o) {
  const d = STATE.done && STATE.done[o.id];
  return o.status === 'done' && !!d && d.total > 0 && d.done < d.total;
}

function render() {
  // the anchored clock, not the iPad's own — a screen twenty minutes out
  // would otherwise colour the board wrong as well as file wrong times
  const now = serverNow();
  drawClock();
  $('datesub').textContent =
    now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ })
    + ' · nobody signed in';
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
  if (!STATE.solo) cols.innerHTML = '';

  // Worked out before the columns are drawn: a row has to be able to say
  // how late it is, and only ONE row should pulse. Six pulsing rows is the
  // same as none — the eye stops picking any of them out.
  const lates = STATE.occ.filter(o => o.checks.kind !== 'incident'
                                   && urgency(o, now) === 'late')
                         .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  const worstId = lates.length ? lates[0].id : null;
  const lateAgo = o => {
    const m = Math.round((now - new Date(o.due_at)) / 60000);
    return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm late' : m + ' min late';
  };

  // Reporting a problem is not a scheduled job and never "completes", so
  // it does not belong in a column or in the day's count. It sits in the bar.
  const inc = STATE.occ.filter(o => o.checks.kind === 'incident' && o.status === 'pending');
  const pb = $('probbtn');
  if (pb) {
    pb.hidden = !inc.length;
    pb.onclick = () => inc.length === 1 ? openCheck(inc[0]) : pickIncident(inc);
  }

  if (STATE.solo) renderSolo(now, worstId, lateAgo);
  else STATE.stations.forEach(st => {
    const mine  = STATE.occ.filter(o => o.station_id === st.id && o.checks.kind !== 'incident');
    const open  = mine.filter(o => o.status === 'pending');
    // signed, but with lines still to do: it stays up top until finished
    const part  = mine.filter(o => partDone(o));
    const shut  = mine.filter(o => o.status !== 'pending' && !partDone(o));
    const u     = o => urgency(o, now);
    const byTime = (a, b) => ((a.due_at || '9') < (b.due_at || '9') ? -1 : 1);

    const nowG   = open.filter(o => ['due','late'].includes(u(o)) || !o.due_at).sort(byTime);
    const nextG  = open.filter(o => u(o) === 'next').sort(byTime);
    const laterG = open.filter(o => u(o) === 'later' && o.due_at).sort(byTime);
    const pct = mine.length ? Math.round(shut.filter(o=>o.status==='done').length / mine.length * 100) : 0;
    const partRow = o => {
      const d = STATE.done[o.id];
      const b = document.createElement('button');
      b.className = 'row2 part';
      b.innerHTML = `<span class="t2">${o.due_at ? hhmm(o.due_at) : '—'}</span>
        <span class="n2">${esc(o.checks.name)}</span>
        <span class="prog2">${d.done} of ${d.total}</span>
        <span class="go2">Finish</span>`;
      b.onclick = () => openDone(o);
      return b;
    };

    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `<div class="chead2">
        <div class="ctop"><span class="cname2">${esc(st.name)}</span>
          <span class="ccount">${shut.filter(o=>o.status==='done').length} / ${mine.length}</span></div>
        <div class="ctrack"><i style="width:${pct}%"></i></div>
      </div>`;

    const sc = document.createElement('div');
    sc.className = 'scroll';

    const DR = drafts();
    const rowFor = (o, cls) => {
      const uu = u(o);
      const dr = DR[o.id];
      const got = dr ? Object.keys(dr.at || {}).length : 0;
      const b = document.createElement('button');
      b.className = 'row2 ' + (cls || '');
      if (uu === 'late' && o.id === worstId) b.className += ' worst';
      b.innerHTML = `<span class="t2">${o.due_at ? hhmm(o.due_at) : '—'}</span>
        <span class="n2">${esc(o.checks.name)}</span>
        ${got ? `<span class="prog2">${got} of ${dr.total}</span>` : ''}
        ${uu === 'late' ? `<span class="lateage">${lateAgo(o)}</span>` : ''}
        ${got ? `<span class="go2">Carry on</span>`
          : ['due','late'].includes(uu) || !o.due_at
          ? `<span class="go2">Start</span>`
          : notYet(o) ? `<span class="opens">Opens ${hhmm(o.appears_at)}</span>` : ''}`;
      b.onclick = () => openCheck(o);
      return b;
    };
    // 11:15 and 11:45 look identical on a screen, and one of them is
    // "before a customer walks in". Draw the line the day actually turns on.
    //
    // The crossing almost always falls BETWEEN groups — prep is overdue or
    // due now, everything after opening is next up — so this state spans
    // the whole column, not one group. When the crossing lands on a group
    // boundary the line goes above the heading, where it reads properly.
    const opens = STATE.opensAt ? STATE.opensAt.slice(0, 5) : null;
    const beforeOpen = o => !!(opens && o.due_at && hhmm(o.due_at) < opens);
    const openLine = `<div class="openline"><span>Doors open ${opens}</span></div>`;
    let sawBefore = false, lineDrawn = false;

    const group = (label, cls, items, rowCls) => {
      if (!items.length) return;
      if (opens && sawBefore && !lineDrawn && !beforeOpen(items[0])) {
        sc.insertAdjacentHTML('beforeend', openLine);   // above the heading
        lineDrawn = true;
      }
      sc.insertAdjacentHTML('beforeend',
        `<div class="glab2 ${cls}">${label}<span class="ln"></span></div>`);
      items.forEach(o => {
        if (opens && sawBefore && !lineDrawn && !beforeOpen(o)) {
          sc.insertAdjacentHTML('beforeend', openLine);
          lineDrawn = true;
        }
        if (beforeOpen(o)) sawBefore = true;
        sc.appendChild(rowFor(o, rowCls ||
          (urgency(o, now) === 'late' ? 'late' : 'now')));
      });
    };

    group('Now', 'gnow', nowG);
    if (part.length) {
      if (!nowG.length) sc.insertAdjacentHTML('beforeend',
        `<div class="glab2 gnow">Now<span class="ln"></span></div>`);
      part.sort(byTime).forEach(o => sc.appendChild(partRow(o)));
    }
    group('Next up', 'gnext', nextG, '');
    group('Later today', 'glater', laterG, 'dim');

    if (shut.length) {
      sc.insertAdjacentHTML('beforeend', `<div class="glab2 glater">Done<span class="ln"></span></div>`);
      shut.sort(byTime).forEach(o => {
        const d = STATE.done[o.id];
        const b = document.createElement(o.status === 'done' ? 'button' : 'div');
        b.className = 'row2 done' + (o.status === 'done' ? ' open' : '');
        b.innerHTML = `<span class="t2">${o.due_at ? hhmm(o.due_at) : '—'}</span>
         ${o.status === 'done'
           ? '<span class="tick2"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg></span>'
           : '<span class="dot fail"></span>'}
         <span class="n2">${esc(o.checks.name)}</span>
         <span class="rm">${o.status === 'missed' ? 'missed' : o.status === 'expired' ? ''
           : d ? esc(d.signed_by) + ' · ' + hhmm(d.signed_at) : 'signed'}</span>`;
        // a signed task can always be looked at again
        if (o.status === 'done') b.onclick = () => openDone(o);
        sc.appendChild(b);
      });
    }
    if (!open.length && !part.length) {
      sc.insertAdjacentHTML('afterbegin',
        `<div class="glab2 gnext">All done<span class="ln"></span></div>
         <div class="row2 done"><span class="n2">Nothing outstanding on this side.</span></div>`);
    }
    col.appendChild(sc);
    cols.appendChild(col);
  });

  // The overdue banner is gone. It repeated what the board already shows —
  // every late mission sits at the top of its own column in red — and it
  // ate the vertical space the columns need when the day is at its fullest.
  const pending = STATE.occ.filter(o => o.status === 'pending' && o.checks.kind !== 'incident');
  cols.classList.toggle('hasLate', lates.length > 0);
  // when everything outstanding is late, dimming communicates nothing
  cols.classList.toggle('allLate', lates.length > 0 && lates.length === pending.length);
}

/* ONE station on the screen — the guides' iPad, the makers' iPad.
   One person works one task at a time, so the screen IS that task: it is
   open on the left, ready to tick, and the rest of the day sits on the
   right. Signing it brings the next one up on its own. Any task on the
   right can be tapped to bring it over instead — the kitchen can still
   work out of order. The left pane is only rebuilt when the task on it
   changes, so a refresh never disturbs someone mid-task. */
function renderSolo(now, worstId, lateAgo) {
  const cols = $('cols');
  const st = STATE.stations[0];
  let col = cols.querySelector('.col.solo');
  if (!col || col.dataset.st !== st.id) {
    cols.innerHTML = `<div class="col solo" data-st="${st.id}">
        <div class="chead2" id="shead"></div>
        <div class="focus"><div class="panel" id="ipanel"></div></div>
        <div class="scroll daylist" id="daylist"></div>
      </div>`;
    INLINE_EL = $('ipanel');
  }

  const mine = STATE.occ.filter(o => o.station_id === st.id && o.checks.kind !== 'incident');
  const open = mine.filter(o => o.status === 'pending');
  const part = mine.filter(o => partDone(o));
  const shut = mine.filter(o => o.status !== 'pending' && !partDone(o));
  const u = o => urgency(o, now);
  const byTime = (a, b) => ((a.due_at || '9') < (b.due_at || '9') ? -1 : 1);
  const doneN = shut.filter(o => o.status === 'done').length;

  $('shead').innerHTML = `<div class="ctop"><span class="cname2">${esc(st.name)}</span>
      <span class="ccount">${doneN} / ${mine.length}</span></div>
    <div class="ctrack"><i style="width:${mine.length ? Math.round(doneN / mine.length * 100) : 0}%"></i></div>`;

  // what belongs on the left: the one picked, else what is due, else part-done, else the next
  const live = o => o.status === 'pending' || partDone(o);
  let f = mine.find(o => o.id === STATE.focusId && live(o));
  if (!f) {
    const dueNow = open.filter(o => o.due_at && ['due', 'late'].includes(u(o))).sort(byTime);
    f = dueNow[0] || part.sort(byTime)[0] || open.filter(o => o.due_at).sort(byTime)[0] || null;
    STATE.focusId = f ? f.id : null;
  }

  // the day, on the right — drawn as a timeline: a rail of times, a NOW
  // line that moves down it, gaps that follow the clock, long tasks drawn
  // taller, and done tasks left where they happened
  const DR = drafts();
  const est = o => STATE.estByVer[o.check_version_id] || o.checks.est_minutes || null;
  const mins = iso => { const d = new Date(iso); return d.getTime() / 60000; };
  const nowM = now.getTime() / 60000;
  const dl = $('daylist');
  const keep = dl.scrollTop;
  dl.innerHTML = '';

  const card = o => {
    const d = STATE.done[o.id];
    const isDone = o.status === 'done' && !partDone(o);
    const st2 = isDone ? 'done' : o.status === 'missed' ? 'missed' : partDone(o) ? 'part'
      : notYet(o) ? 'soon'
      : u(o) === 'late' ? 'late' : ['due'].includes(u(o)) ? 'now' : 'later';
    const e = est(o);
    const dr = DR[o.id], got = dr ? Object.keys(dr.at || {}).length : 0;
    const right = f && o.id === f.id ? `<span class="onscr">On screen</span>`
      : isDone ? `<span class="rm">${d ? esc(d.signed_by) + ' · ' + hhmm(d.signed_at) : 'signed'}</span>`
      : o.status === 'missed' ? `<span class="rm">missed</span>`
      : partDone(o) ? `<span class="prog2">${d.done} of ${d.total}</span>`
      : got ? `<span class="prog2">${got} of ${dr.total}</span>`
      : st2 === 'late' ? `<span class="lateage">${lateAgo(o)}</span>`
      : st2 === 'soon' ? `<span class="opens">Opens ${hhmm(o.appears_at)}</span>` : '';
    const b = document.createElement(o.status === 'missed' ? 'div' : 'button');
    b.className = `tlc ${st2}` + (f && o.id === f.id ? ' sel' : '') + (o.id === worstId ? ' worst' : '');
    // a long task is a tall block — Opening reads as the morning, a temp log as a moment
    if (e) b.style.minHeight = Math.max(52, Math.min(170, e * 1.5)) + 'px';
    b.innerHTML = `<span class="tln">${isDone ? '<span class="tick2"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg></span>' : ''}${esc(o.checks.name)}</span>
      ${right}
      <span class="tlm">${[e ? '~' + e + ' min' : '',
        // when it can be started: its window opening, which is what the iPad enforces
        o.appears_at && o.due_at && (new Date(o.due_at) - new Date(o.appears_at)) >= 20 * 60000
          ? 'from ' + hhmm(o.appears_at) + ' · due ' + hhmm(o.due_at) : ''].filter(Boolean).join(' · ')}</span>`;
    if (o.status === 'missed') return b;
    b.onclick = isDone ? () => openDone(o) : () => { STATE.focusId = o.id; render(); };
    return b;
  };

  // things with no set time — deliveries — sit in their own box at the top
  const anyT = mine.filter(o => !o.due_at);
  if (anyT.length) {
    const box = document.createElement('div');
    box.className = 'tlany';
    box.innerHTML = `<div class="tlanyh">Any time</div>`;
    anyT.forEach(o => box.appendChild(card(o)));
    dl.appendChild(box);
  }

  const timed = mine.filter(o => o.due_at).map(o => ({ t: mins(o.due_at), o }));
  const opens = STATE.opensAt ? STATE.opensAt.slice(0, 5) : null;
  if (opens) {
    const [h, m] = opens.split(':').map(Number);
    const lon = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
    const t = nowM + ((h * 60 + m) - (lon.getHours() * 60 + lon.getMinutes()));
    timed.push({ t, mark: 'doors', label: 'Doors open ' + opens });
  }
  timed.push({ t: nowM, mark: 'now', label: 'Now ' + hhmm(now.toISOString()) });
  timed.sort((a, b) => a.t - b.t || (a.mark === 'now' ? 1 : b.mark === 'now' ? -1 : 0));

  const rail = document.createElement('div');
  rail.className = 'tl';
  let last = null, nowEl = null;
  timed.forEach(it => {
    // the gap follows the clock, squeezed so a quiet afternoon still fits
    if (last !== null) {
      const gap = Math.max(6, Math.min(64, (it.t - last) * 0.5));
      rail.insertAdjacentHTML('beforeend', `<div style="height:${gap}px"></div>`);
    }
    last = it.t;
    if (it.mark) {
      const m = document.createElement('div');
      m.className = 'tlmark ' + it.mark;
      m.innerHTML = `<span>${esc(it.label)}</span>`;
      rail.appendChild(m);
      if (it.mark === 'now') nowEl = m;
      return;
    }
    const row = document.createElement('div');
    row.className = 'tli' + (it.t < nowM ? ' past' : '');
    row.innerHTML = `<span class="tlt">${hhmm(it.o.due_at)}</span><span class="tldot"></span>`;
    row.appendChild(card(it.o));
    rail.appendChild(row);
  });
  dl.appendChild(rail);
  if (!mine.length) dl.insertAdjacentHTML('beforeend', `<div class="row2 done"><span class="n2">Nothing scheduled today.</span></div>`);

  // keep NOW in view — unless someone has just scrolled to look at something
  dl.onscroll = () => { if (STATE.tlAuto) STATE.tlAuto = false; else STATE.tlTouched = Date.now(); };
  if (nowEl && Date.now() - (STATE.tlTouched || 0) > 60000) {
    const to = Math.max(0, nowEl.offsetTop - dl.clientHeight * 0.35);
    if (Math.abs(dl.scrollTop - to) > 2) { STATE.tlAuto = true; dl.scrollTop = to; }
  } else dl.scrollTop = keep;

  // the left pane — leave it alone if it already shows the right task,
  // or if a pop-up or a corrective action is in progress
  if (JOB && (!JOB.inline || JOB.hold)) return;
  if (!f) {
    if (INLINE_EL.dataset.occ !== 'idle') {
      INLINE_EL.dataset.occ = 'idle';
      INLINE_EL.innerHTML = `<div class="idle"><h2>All done for now</h2>
        <p>Nothing is due on ${esc(st.name)}. The next task appears here on its own.</p></div>`;
    }
    return;
  }
  const want = f.id + (partDone(f) ? ':review' : ':job');
  if (INLINE_EL.dataset.occ === want && JOB && JOB.inline && JOB.occ.id === f.id) return;
  INLINE_EL.dataset.occ = want;
  partDone(f) ? openDone(f, true) : openCheck(f, true);
}

/* more than one incident form set up — ask which side it happened on */
function pickIncident(list) {
  sheet().classList.add('open');
  $('panel').innerHTML = `<div class="pickw">
      <h3>Report a problem</h3>
      <p>Which side did it happen on?</p>
      ${list.map(o => {
        const st = STATE.stations.find(x => x.id === o.station_id);
        return `<button class="row2 now" data-i="${o.id}">
          <span class="n2">${esc(st ? st.name : o.checks.name)}</span>
          <span class="go2">Report</span></button>`;
      }).join('')}
    </div>`;
  $('panel').querySelectorAll('[data-i]').forEach(b => b.onclick = () =>
    openCheck(list.find(o => o.id === b.dataset.i)));
}

/* ------------------------------------------------------------ open a job */

/* Ticks on a checklist are kept on the iPad as they happen. One person
   works through the opening for over an hour before signing — a reload,
   a dropped connection or closing the sheet must not wipe that. Each
   tick keeps its own time; the PIN only comes at the end. */
const DRAFT_KEY = 'missions-drafts';
function drafts() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; }
}
function saveDraft() {
  if (!JOB || JOB.kind !== 'checklist') return;
  const all = drafts();
  const hasRead = Object.keys(JOB.values).length || Object.keys(JOB.skips).length;
  if (JOB.ticked.size || hasRead) all[JOB.occ.id] = { at: JOB.tickAt, alts: JOB.alts, total: JOB.items.length,
    vals: JOB.values, skips: JOB.skips, readAt: JOB.readAt };
  else delete all[JOB.occ.id];
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch {}
}
function dropDraft(id) {
  const all = drafts();
  if (!(id in all)) return;
  delete all[id];
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch {}
}
// anything signed, missed or gone no longer needs its ticks
function pruneDrafts() {
  const all = drafts(), open = new Set(STATE.occ.filter(o => o.status === 'pending').map(o => o.id));
  let changed = false;
  for (const id of Object.keys(all)) if (!open.has(id)) { delete all[id]; changed = true; }
  if (changed) try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch {}
}

async function openCheck(o, inline) {
  const job = JOB = { occ: o, kind: o.checks.kind, items: [], ticked: new Set(), photos: {}, values: {}, skips: {},
          tickAt: {}, alts: {}, readAt: {}, units: [], inline: !!inline };
  if (!inline) sheet().classList.add('open');
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
    : db.from('steps').select('id,sort,text,photo_required,guidance,guidance_image,est_minutes,alt_label')
        .eq('check_version_id', o.check_version_id).order('sort');
  const { data, error } = await q;
  if (JOB !== job) return;   // something else was opened while this loaded
  if (!error && k === 'checklist') {
    const { data: un } = await db.from('units')
      .select('id,sort,name,limit_kind,limit_c,basis,guidance,guidance_image,step_id')
      .eq('check_version_id', o.check_version_id).order('sort');
    if (JOB !== job) return;
    JOB.units = (un || []).filter(x => x.step_id);
  }
  if (error) { panel().innerHTML = `<div class="phead"><div class="ptitle">Could not load</div>
    <p class="pmeta">${esc(error.message)}</p></div>`; return; }

  JOB.items = data || [];
  const d = drafts()[o.id];
  if (d && k === 'checklist') {
    const ids = new Set(JOB.items.map(x => x.id));
    for (const [id, at] of Object.entries(d.at || {})) if (ids.has(id)) {
      JOB.ticked.add(id); JOB.tickAt[id] = at;
      if (d.alts && d.alts[id]) JOB.alts[id] = d.alts[id];
    }
    const uids = new Set(JOB.units.map(x => x.id));
    for (const [id, v] of Object.entries(d.vals || {})) if (uids.has(id)) JOB.values[id] = v;
    for (const [id, r] of Object.entries(d.skips || {})) if (uids.has(id)) JOB.skips[id] = r;
    for (const [id, t] of Object.entries(d.readAt || {})) if (uids.has(id)) JOB.readAt[id] = t;
  }
  drawJob();
}

/* ------------------------------------------------- a signed task, again */

/* Opening a task that has already been signed. The record itself never
   changes — anything left undone is finished as an ADDITION, with its own
   time and its own PIN, until the end of that day. */
async function openDone(o, inline) {
  const job = JOB = { occ: o, kind: 'review', rec: null, ticked: new Set(), tickAt: {}, inline: !!inline };
  if (!inline) sheet().classList.add('open');
  panel().innerHTML = `<div class="phead"><div class="ptitle">${esc(o.checks.name)}</div>
    <p class="pmeta">Loading…</p></div>`;
  let data, error;
  try { ({ data, error } = await db.rpc('record_detail', { p_occurrence: o.id })); }
  catch (e) { error = e; }
  if (JOB !== job) return;
  if (error || !data || !data.ok) {
    panel().innerHTML = `<div class="phead"><button class="pback">← Back</button>
      <div class="ptitle">Could not open it</div>
      <p class="pmeta">${esc(error ? 'No connection — try again when the wifi is back'
                                   : (data && data.error) || 'Unknown error')}</p></div>`;
    panel().querySelector('.pback').onclick = closeSheet;
    return;
  }
  JOB.rec = data;
  drawDone();
}

function drawDone() {
  const o = JOB.occ, R = JOB.rec;
  const steps = R.steps || [];
  const missing = steps.filter(x => !x.done && !x.later_at);
  const doneN = steps.length - missing.length;

  const stepRow = (x, i) => {
    const was = x.done || x.later_at;
    const now = JOB.ticked.has(x.step_id);
    const canTick = !was && R.can_finish && !x.photo_required && !x.has_temps;
    const note = x.done
      ? `${x.reason ? esc(x.reason) + ' · ' : ''}${hhmm(x.done_at)}`
      : x.later_at ? `Finished later · ${hhmm(x.later_at)} by ${esc(x.later_by)}`
      : now ? `Done now · ${hhmm(JOB.tickAt[x.step_id])}`
      : x.has_temps ? 'Not done — readings can’t be added after sign-off'
      : x.photo_required && R.can_finish ? 'Not done — needs a photo, ask a manager'
      : 'Not done';
    const has = x.guidance || x.guidance_image;
    return `<div class="step2 ${was || now ? 'on' : 'miss'}">
        <span class="snum">${i + 1}</span>
        <button class="sbox ${was || now ? 'on' : ''}" ${canTick ? `data-tick="${x.step_id}"` : 'disabled'}>
          ${was || now ? '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>' : ''}
        </button>
        <span class="stx2">${esc(x.text)}
          <span class="${was || now ? 'sat' : 'smiss'}">${note}</span></span>
        ${has ? `<button class="pqs" data-guide="${x.step_id}">?</button>` : ''}
      </div>
      ${has ? `<div class="guide" id="g${x.step_id}">
          ${x.guidance ? `<p>${esc(x.guidance)}</p>` : ''}
          ${x.guidance_image ? `<img src="${esc(x.guidance_image)}" alt="How to do this" loading="lazy">` : ''}
        </div>` : ''}`;
  };
  const readRow = r => `<div class="line2"><span class="dot ${r.skipped ? '' : r.passed ? 'pass' : 'fail'}"></span>
      <span>${esc(r.name)}</span>
      <b>${r.skipped ? esc(r.reason || 'n/a') : r.value + '°C'}</b></div>`;
  const countRow = c => `<div class="line2"><span class="dot ${c.low ? 'fail' : 'pass'}"></span>
      <span>${esc(c.name)}</span><b>${c.qty}${c.unit_label ? ' ' + esc(c.unit_label) : ''}</b></div>`;

  const n = JOB.ticked.size;
  panel().innerHTML = `
    <div class="jprog">
      <button class="pback">← Back</button>
      <div class="jtop"><b>${esc(o.checks.name)}</b>
        ${steps.length ? `<span>${doneN + n} / ${steps.length}</span>` : ''}</div>
      ${steps.length ? `<div class="ctrack"><i style="width:${Math.round((doneN + n) / steps.length * 100)}%"></i></div>` : ''}
    </div>
    <div class="pintro">Signed off by <b>${esc(R.signed_by)}</b> at ${hhmm(R.signed_at)}${
      R.was_late ? ` · ${R.minutes_late} min late` : ''}${
      missing.length && R.can_finish ? '. Anything not done can still be finished today — tick it, then sign with your PIN.'
      : missing.length ? '. This was a previous day, so it can no longer be finished.' : '.'}</div>
    <div class="pbody">
      ${steps.map(stepRow).join('')}
      ${(R.readings || []).map(readRow).join('')}
      ${(R.counts || []).map(countRow).join('')}
    </div>
    ${missing.length && R.can_finish ? `<div class="pfoot">
      <button class="signbtn ${n ? '' : 'off'}" ${n ? '' : 'disabled'}>
        ${n ? `Finish ${n} with your PIN` : `${missing.length} not done — tick what you've finished`}
      </button></div>` : ''}`;

  panel().querySelector('.pback').onclick = closeSheet;
  panel().querySelectorAll('[data-tick]').forEach(b => b.onclick = () => {
    const id = b.dataset.tick;
    if (JOB.ticked.has(id)) { JOB.ticked.delete(id); delete JOB.tickAt[id]; }
    else { JOB.ticked.add(id); JOB.tickAt[id] = serverNow().toISOString(); }
    drawDone();
  });
  panel().querySelectorAll('[data-guide]').forEach(b => b.onclick = () =>
    $('g' + b.dataset.guide).classList.toggle('open'));
  const sb = panel().querySelector('.signbtn:not(.off)');
  if (sb) sb.onclick = () => askPin(finishLater);
}

async function finishLater(pin) {
  const args = { p_pin: pin, p_occurrence: JOB.occ.id,
    p_steps: [...JOB.ticked].map(step_id => ({ step_id, at: JOB.tickAt[step_id] })),
    p_recorded_at: serverNow().toISOString() };
  const n = JOB.ticked.size;
  const offlineDone = async () => {
    await queueSubmission(args, [], 'finish_steps');
    closeSheet();
    toast(`Saved on this iPad — ${n} will send when the wifi is back`);
    setTimeout(() => toast(''), 3500);
    return {};
  };
  if (!navigator.onLine) return offlineDone();

  let data, error;
  try { ({ data, error } = await db.rpc('finish_steps', args)); } catch (e) { error = e; }
  if (error && (!navigator.onLine || /fetch|network|failed/i.test(error.message || ''))) return offlineDone();
  if (error) return { error: error.message };
  if (!data.ok) return { error: data.error };

  closeSheet();
  toast(data.left ? `Finished by ${data.signed_by} — ${data.left} still not done`
                  : `All done — finished by ${data.signed_by}`);
  setTimeout(() => toast(''), 3500);
  await load();
  return {};
}

function drawJob() {
  const o = JOB.occ, k = JOB.kind;
  if (k === 'incident') return drawIncident();
  if (k === 'checklist') syncTempLines();
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
          : missing > 0 ? `Complete — ${missing} not done`
          : isList ? `Complete ${esc(o.checks.name.toLowerCase())} with your PIN`
          : 'Sign off with your PIN'}
      </button>
    </div>`;

  panel().querySelector('.pback').onclick = closeSheet;
  panel().querySelectorAll('[data-tick]').forEach(b => b.onclick = () => tick(b.dataset.tick));
  panel().querySelectorAll('[data-alt]').forEach(b => b.onclick = () => tickAlt(b.dataset.alt));
  panel().querySelectorAll('[data-photo]').forEach(b => b.onclick = () => takePhoto(b.dataset.photo));
  panel().querySelectorAll('[data-guide]').forEach(b => b.onclick = () =>
    $('g' + b.dataset.guide).classList.toggle('open'));
  panel().querySelectorAll('[data-unit]').forEach(b => b.onclick = () => keypad(b.dataset.unit));
  panel().querySelectorAll('[data-count]').forEach(b => b.onclick = () => countPad(b.dataset.count));
  const s = panel().querySelector('.signbtn:not(.off)');
  if (s) s.onclick = () => askPin();
  if (notYet(o)) lockJob(o, drawJob);
}

/* Not open yet: everything stays readable — the lines, the "?" how-to —
   but nothing can be ticked, read or signed until the window opens. The
   screen unlocks itself at that moment. */
function lockJob(o, redraw) {
  panel().querySelectorAll('[data-tick],[data-alt],[data-photo],[data-unit],[data-count]').forEach(b => {
    b.disabled = true; b.onclick = null; b.classList.add('locked');
  });
  const foot = panel().querySelector('.pfoot');
  if (foot) foot.innerHTML = `<button class="signbtn off" disabled>Opens at ${hhmm(o.appears_at)}</button>`;
  const job = JOB;
  const wait = Math.min(2147483000, new Date(o.appears_at) - serverNow() + 1000);
  setTimeout(() => { if (JOB === job && !document.querySelector('.ov')) redraw(); }, wait);
}

/* A checklist line with temperatures on it (Opening's line 8) is not
   ticked by hand: it is done when every unit has a reading, and its time
   is the time of the last reading. Clearing a reading unticks it. */
function tempsOf(stepId) { return (JOB.units || []).filter(u => u.step_id === stepId); }
function syncTempLines() {
  let changed = false;
  JOB.items.forEach(x => {
    const us = tempsOf(x.id);
    if (!us.length) return;
    const all = us.every(u => JOB.values[u.id] !== undefined || JOB.skips[u.id]);
    if (all && !JOB.ticked.has(x.id)) {
      JOB.ticked.add(x.id);
      JOB.tickAt[x.id] = us.map(u => JOB.readAt[u.id]).filter(Boolean).sort().pop() || serverNow().toISOString();
      changed = true;
    } else if (!all && JOB.ticked.has(x.id)) {
      JOB.ticked.delete(x.id); delete JOB.tickAt[x.id]; changed = true;
    }
  });
  if (changed) saveDraft();
}

function drawStep(x, i) {
  const on = JOB.ticked.has(x.id);
  const shot = JOB.photos[x.id];
  const needs = x.photo_required && !shot;
  const has = x.guidance || x.guidance_image;
  const alt = JOB.alts[x.id];
  const temps = tempsOf(x.id);
  return `<div class="step2 ${on ? 'on' : ''} ${temps.length ? 'hastemps' : ''}">
      <span class="snum">${i + 1}</span>
      <button class="sbox ${on ? 'on' : ''} ${needs ? 'cam' : ''}" ${needs || temps.length ? 'disabled' : `data-tick="${x.id}"`}>
        ${on ? '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>' : ''}
      </button>
      <span class="stx2">${esc(x.text)}
        ${on && JOB.tickAt[x.id] ? `<span class="sat">${alt ? esc(alt) + ' · ' : ''}${hhmm(JOB.tickAt[x.id])}</span>`
          : x.est_minutes ? `<span class="sest">${x.est_minutes} min</span>` : ''}</span>
      ${x.alt_label && !on ? `<button class="salt" data-alt="${x.id}">${esc(x.alt_label)}</button>` : ''}
      ${x.photo_required ? (shot
        ? `<span class="shot">Photo ✓</span>`
        : `<button class="scam" data-photo="${x.id}">Photo</button>`) : ''}
      ${has ? `<button class="pqs" data-guide="${x.id}">?</button>` : ''}
    </div>
    ${has ? `<div class="guide" id="g${x.id}">
        ${x.guidance ? `<p>${esc(x.guidance)}</p>` : ''}
        ${x.guidance_image ? `<img src="${esc(x.guidance_image)}" alt="How to do this" loading="lazy">` : ''}
      </div>` : ''}
    ${temps.length ? `<div class="steptemps">${temps.map(drawUnit).join('')}</div>` : ''}`;
}

/* One row builder for temperatures and counts. Same shape as a checklist
   step: the border is on the row, the "?" lives inside it. */
function itemRow(it, kind, state, right, sub) {
  const has = it.guidance || it.guidance_image;
  const guide = has ? `<div class="guide" id="gu${it.id}">
        ${it.guidance ? `<p>${esc(it.guidance)}</p>` : ''}
        ${it.guidance_image ? `<img src="${esc(it.guidance_image)}" alt="How this is done" loading="lazy">` : ''}
      </div>` : '';
  return `<div class="unitrow ${state}">
      <button class="unit" data-${kind}="${it.id}">
        <span class="uname">${esc(it.name)}</span>
        <span class="ulim">${sub}</span>
        <span class="uval">${right}</span>
      </button>
      ${has ? `<button class="pqs" data-guide="u${it.id}">?</button>` : ''}
    </div>${guide}`;
}

function drawUnit(u) {
  const sk = JOB.skips[u.id];
  if (sk) return itemRow(u, 'unit', 'skip', 'n/a', esc(sk));
  const v = JOB.values[u.id];
  const has = v !== undefined;
  const pass = has && (u.limit_kind === 'max' ? v <= u.limit_c : v >= u.limit_c);
  return itemRow(u, 'unit', has ? (pass ? 'pass' : 'fail') : '',
    has ? v + '°' : 'tap',
    `${u.limit_kind === 'min' ? 'at least' : 'no more than'} ${u.limit_c}°C`);
}

// the tick IS the timestamp — unticking clears it, re-ticking takes a new one
function tick(id) {
  if (JOB.ticked.has(id)) {
    JOB.ticked.delete(id); delete JOB.tickAt[id]; delete JOB.alts[id];
  } else {
    JOB.ticked.add(id); JOB.tickAt[id] = serverNow().toISOString();
  }
  saveDraft();
  drawJob();
}

// "No delivery today" is a finished job, not a missed one
function tickAlt(id) {
  const x = JOB.items.find(s => s.id === id);
  if (!x) return;
  JOB.ticked.add(id); JOB.tickAt[id] = serverNow().toISOString(); JOB.alts[id] = x.alt_label;
  saveDraft();
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
      const blob  = await shrink(f);
      const thumb = await shrink(f, 400, 0.62);
      const stamp = Date.now();
      const path      = `${JOB.occ.id}/${stepId}-${stamp}.jpg`;
      const thumbPath = `${JOB.occ.id}/${stepId}-${stamp}-t.jpg`;
      JOB.pendingPhotos = JOB.pendingPhotos || [];

      // the pair travels together, so the small one can never be missing
      // for a record that has a full photo
      const hold = () => JOB.pendingPhotos.push({ stepId, path, blob, thumbPath, thumbBlob: thumb });
      if (navigator.onLine) {
        const up = await db.storage.from('evidence').upload(path, blob,
          { contentType: 'image/jpeg' });
        const upT = await db.storage.from('evidence').upload(thumbPath, thumb,
          { contentType: 'image/jpeg' });
        // offline mid-shot: keep both and send them with the record later
        if (up.error || upT.error) hold();
      } else {
        hold();
      }
      JOB.photos[stepId] = path;
      if (stepId !== 'incident') {
        JOB.ticked.add(stepId); JOB.tickAt[stepId] = serverNow().toISOString(); saveDraft();
      }
      toast('');
      drawJob();
    } catch (e) { toast(''); alert('Photo did not save: ' + e.message); }
  };
  inp.click();
}

/* Two sizes of every evidence photo.
   The full one (1200px, ~200KB) is the real evidence and is culled at 90
   days. The small one (400px, ~30KB) outlives it, so a photo-required
   step never decays into a tick with nothing behind it. 400 rather than
   the 200 originally planned: at 200 you can see THAT there is a tray,
   not WHETHER it is clean, which is the only question worth asking. */
function shrink(file, max = 1200, q = 0.7) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? res(b) : rej(new Error('could not compress')), 'image/jpeg', q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('could not read the image')); };
    img.src = url;
  });
}

/* ------------------------------------------------------ temperature pad */

function keypad(unitId) {
  const u = (JOB.units || []).find(x => x.id === unitId) || JOB.items.find(x => x.id === unitId);
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
      else if (k === 'ok') {
        JOB.values[unitId] = parseFloat(buf); delete JOB.skips[unitId];
        JOB.readAt[unitId] = serverNow().toISOString();   // the moment it was read
        saveDraft(); ov.remove(); drawJob(); return;
      }
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
          ${['Out of stock','Not made yet']
            .map(r => `<button class="opt big" data-r="${esc(r)}">${esc(r)}</button>`).join('')}
        </div>
        <button class="padcancel">Back</button></div>`;
      ov.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
        JOB.skips[unitId] = b.dataset.r;
        JOB.readAt[unitId] = serverNow().toISOString();
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
      ? { step_id: x.id, done: true, photo: JOB.photos[x.id] || null,
          at: JOB.tickAt[x.id] || null, reason: JOB.alts[x.id] || null }
      : { step_id: x.id, done: false });
    if ((JOB.units || []).length) args.p_readings = [
      ...Object.entries(JOB.values).map(([unit_id, value]) => ({ unit_id, value, at: JOB.readAt[unit_id] || null })),
      ...Object.entries(JOB.skips).map(([unit_id, reason]) => ({ unit_id, skipped: true, reason, at: JOB.readAt[unit_id] || null }))
    ];
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
  dropDraft(JOB.occ.id);
  if (!JOB.inline) render();

  if (data.failures && data.failures.length) { JOB.hold = true; corrective(data.failures, 0, data); return; }
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

  /* Does the reading name a food, or a cupboard?
     "Lamb 58°C" already answers "which food" — asking again, and offering
     Dairy and Prepped salads, insults the person holding the probe.
     "Walk-in chiller 12°C" genuinely does not: a chiller holds twenty
     things and the law wants to know which of them were at risk. */
  const unit    = (JOB ? [...(JOB.items || []), ...(JOB.units || [])] : []).find(x => x.name === f.unit) || {};
  const store   = /storage|chiller|freez|fridge|ambient/i.test(unit.basis || f.unit || '');
  const cooking = /cooking|calibrat|probe|core/i.test(unit.basis || f.unit || '');
  const knowsFood = !store && !cooking;          // the unit IS the food

  const FOODS = store
    ? ['Everything in it', 'Prepped salads', 'Dairy', 'Raw meat', 'Cooked food']
    : [];
  const ACTS = ['Binned it', 'Moved to another unit', 'Reheated', 'Called engineer'];

  let food = knowsFood ? f.unit : '', qty = '', act = '', override = null;
  let foodOther = false, actOther = false;

  const draw = () => {
    const ready = food.trim() && act.trim();
    panel().innerHTML = `
      <div class="alert">
        <div class="alertt">${esc(f.unit)} is out of range — ${f.value}°C</div>
        <div class="alerts">Limit is ${f.limit}°C. This has to be recorded before you carry on.</div>
      </div>
      <div class="pbody">
        <p class="calead">The law needs six things.
          <b>We already know ${knowsFood ? 'five' : 'four'}.</b></p>
        <div class="known">
          <div><span>When it started</span><b>${started ? esc(started) : 'Not known'}</b>
            <i>${esc(basis)}</i><button class="tiny" id="fix">Change</button></div>
          <div><span>How far out</span><b>${Math.abs(f.value - f.limit).toFixed(1)}°C ${f.limit_kind === 'min' ? 'below' : 'above'}</b></div>
          <div><span>Who found it</span><b>${esc(sub.signed_by)}</b><i>just now</i></div>
          <div><span>Back to normal</span><b>Re-check in 30 minutes</b></div>
          ${knowsFood ? `<div><span>Which food</span><b>${esc(f.unit)}</b>
            <i>this is what you probed</i><button class="tiny" id="notit">Not that</button></div>` : ''}
        </div>

        ${knowsFood ? '' : `
        <div class="ask"><span class="asklab">${store
            ? 'What food was in there?'
            : 'Which food was this?'}</span>
          ${FOODS.length ? `<div class="opts" id="foods">
            ${FOODS.map(x => `<button class="opt ${food === x && !foodOther ? 'on' : ''}"
                data-f="${esc(x)}">${esc(x)}</button>`).join('')}
            <button class="opt ${foodOther ? 'on' : ''}" data-fo="1">Something else</button>
          </div>` : ''}
          ${(foodOther || !FOODS.length)
            ? `<input class="inp otherin" id="foodtx" placeholder="Which food? e.g. lamb kofte"
                 value="${esc(foodOther || !FOODS.length ? food : '')}">` : ''}
        </div>`}

        <div class="ask"><span class="asklab">How much?</span>
          <input class="inp" id="qty" placeholder="e.g. one full tray, about 4kg" value="${esc(qty)}">
        </div>

        <div class="ask"><span class="asklab">What did you do?</span>
          <div class="opts" id="acts">
            ${ACTS.map(x => `<button class="opt ${act === x && !actOther ? 'on' : ''}"
                data-a="${esc(x)}">${esc(x)}</button>`).join('')}
            <button class="opt ${actOther ? 'on' : ''}" data-ao="1">Something else</button>
          </div>
          ${actOther ? `<input class="inp otherin" id="acttx"
              placeholder="What did you do? Write it in your own words" value="${esc(act)}">` : ''}
        </div>
      </div>
      <div class="pfoot">
        <button class="signbtn ${ready ? '' : 'off'}" ${ready ? '' : 'disabled'}>
          ${ready ? 'Save record with your PIN'
            : !food.trim() ? 'Say which food' : 'Say what you did'}
        </button>
      </div>`;

    panel().querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
      food = b.dataset.f; foodOther = false; draw(); });
    panel().querySelectorAll('[data-fo]').forEach(b => b.onclick = () => {
      foodOther = true; food = ''; draw(); panel().querySelector('#foodtx').focus(); });
    panel().querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      act = b.dataset.a; actOther = false; draw(); });
    panel().querySelectorAll('[data-ao]').forEach(b => b.onclick = () => {
      actOther = true; act = ''; draw(); panel().querySelector('#acttx').focus(); });

    // typing must not redraw — that would steal the keyboard on every key
    const bind = (id, set) => { const el = panel().querySelector(id); if (el) el.oninput = e => {
      set(e.target.value);
      const btn = panel().querySelector('.signbtn');
      const ok = food.trim() && act.trim();
      btn.classList.toggle('off', !ok); btn.disabled = !ok;
      btn.textContent = ok ? 'Save record with your PIN'
        : !food.trim() ? 'Say which food' : 'Say what you did';
      btn.onclick = ok ? save : null;
    }; };
    bind('#qty',    v => qty = v);
    bind('#foodtx', v => food = v);
    bind('#acttx',  v => act = v);

    const nt = $('notit');
    if (nt) nt.onclick = () => { food = ''; foodOther = true; draw(); };

    $('fix').onclick = () => {
      const t = prompt('When was it last definitely fine? e.g. 13:00', '');
      if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return;
      const d = new Date(); const [h, m] = t.split(':');
      d.setHours(+h, +m, 0, 0); override = d.toISOString(); draw();
    };
    const sgn = panel().querySelector('.signbtn:not(.off)');
    if (sgn) sgn.onclick = save;
  };

  const save = () => askPin(async pin => {
    const { data, error } = await db.rpc('submit_corrective', {
      p_pin: pin, p_reading: f.reading_id, p_food: food.trim(),
      p_quantity: qty.trim() || 'not stated', p_action: act.trim(), p_started_at: override
    });
    if (error) return { error: error.message };
    if (!data.ok) return { error: data.error };
    if (i + 1 < fails.length) { corrective(fails, i + 1, sub); return; }
    closeSheet(); celebrate(sub, true);
  });

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
  if (go) go.onclick = () => {
    ov.remove();
    if (STATE.solo) { STATE.focusId = next.id; render(); } else openCheck(next);
  };
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  setTimeout(() => { if (document.body.contains(ov)) ov.remove(); }, 9000);
}

function markDoneLocally() {
  const o = STATE.occ.find(x => x.id === JOB.occ.id);
  if (o) o.status = 'done';
  dropDraft(JOB.occ.id);
  if (!JOB.inline) render();
}

function closeSheet() {
  LAST_JOB = JOB; sheet().classList.remove('open'); JOB = null;
  if (STATE.solo) render();
}
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
/* The clock ticks on its own. render() is skipped while a check is open,
   and a frozen clock on a wall screen is worse than none. */
function drawClock() {
  const c = $('bigclock');
  if (c) c.textContent = hhmm(serverNow().toISOString());
}
setInterval(drawClock, 5000);

let SEEN_DAY = todayLondon();

setInterval(() => {
  if (VIEWING && Date.now() > REVERT_AT && !busy()) return backHome();
  if (VIEWING && !busy()) render();   // keep the countdown honest
  if (busy()) return;                 // never yank the screen out from under someone
  if (todayLondon() !== SEEN_DAY) { SEEN_DAY = todayLondon(); load(); return; }
  render();
}, 30000);

setInterval(() => { if (!busy()) load(); }, 120000);

db.channel('board')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'occurrences' },
      () => { if (!busy()) load(); })
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
  return itemRow(it, 'count', has ? (low ? 'fail' : 'pass') : '',
    has ? q : 'tap',
    it.reorder_level != null
      ? 'order below ' + it.reorder_level + (it.unit_label ? ' ' + esc(it.unit_label) : '')
      : (it.unit_label ? esc(it.unit_label) : ''));
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
async function queueSubmission(args, photoBlobs, rpc) {
  const id = 'q' + Date.now() + Math.random().toString(16).slice(2);
  await IDB.put('queue', { id, args, photoBlobs: photoBlobs || [], at: Date.now(),
                           rpc: rpc || 'submit_check' });
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
        if (ph.thumbBlob) {
          const t = await db.storage.from('evidence')
            .upload(ph.thumbPath, ph.thumbBlob, { contentType: 'image/jpeg' });
          if (t.error && !/exists/i.test(t.error.message)) throw t.error;
        }
        if (ph.stepId === 'incident') args.p_photo = ph.path;
        else if (args.p_steps) {
          const st = args.p_steps.find(s => s.step_id === ph.stepId);
          if (st) st.photo = ph.path;
        }
      }
      const { data, error } = await db.rpc(it.rpc || 'submit_check', args);
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
