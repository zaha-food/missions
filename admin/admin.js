/* Missions — back end. Managers and founders only, behind a real login.
   Reads and writes everything the iPad cannot. */

const TZ = 'Europe/London';
const db = supabase.createClient(window.MISSIONS.url, window.MISSIONS.key);

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fixIso = s => s ? s.replace(/\.(\d{1,6})\d*/, (m, d) => '.' + d.padEnd(6, '0')) : s;
const hhmm = s => s ? new Date(fixIso(s)).toLocaleTimeString('en-GB',
  { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—';
const dayTime = s => s ? new Date(fixIso(s)).toLocaleString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

let VIEW = 'today';
let DATE = today();

/* ----------------------------------------------------------------- auth */

async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return showLogin();
  $('me').textContent = session.user.email;
  $('login').classList.add('hide');
  $('app').classList.remove('hide');
  route();
}

function showLogin() {
  $('app').classList.add('hide');
  $('login').classList.remove('hide');
}

$('signin').onclick = async () => {
  const err = $('lerr');
  err.classList.add('hide');
  const { error } = await db.auth.signInWithPassword({
    email: $('email').value.trim(), password: $('pw').value
  });
  if (error) { err.textContent = error.message; err.classList.remove('hide'); return; }
  boot();
};
$('pw').onkeydown = e => { if (e.key === 'Enter') $('signin').click(); };
$('out').onclick = async () => { await db.auth.signOut(); showLogin(); };

document.querySelectorAll('.nav').forEach(b => b.onclick = () => {
  VIEW = b.dataset.view;
  document.querySelectorAll('.nav').forEach(n => n.classList.toggle('on', n === b));
  route();
});

function route() {
  if (VIEW === 'today') return viewToday();
  if (VIEW === 'records') return viewRecords();
  if (VIEW === 'checks') return viewChecks();
  if (VIEW === 'people') return viewPeople();
  if (VIEW === 'devices') return viewDevices();
}

/* ---------------------------------------------------------------- today */

async function viewToday() {
  const m = $('main');
  m.innerHTML = `<h1>Today</h1><p class="sub">Loading…</p>`;

  const { data: occ, error } = await db.from('occurrences')
    .select(`id,due_at,status,service_date,
             checks(name,kind),stations(name,sort,areas(id,name,sort)),
             records(id,signed_at,was_late,minutes_late,staff(name))`)
    .eq('service_date', DATE).order('due_at');
  if (error) return m.innerHTML = `<h1>Today</h1><div class="empty">${esc(error.message)}</div>`;

  const { data: cas } = await db.from('corrective_actions')
    .select(`id,peak_value_c,deviation_c,food,action_taken,verified_at,verify_due_at,created_at,
             readings(value_c,units(name,limit_c,limit_kind)),records(staff(name))`)
    .order('created_at', { ascending: false }).limit(40);
  const todayCas = (cas || []).filter(c => (c.created_at || '').slice(0, 10) === DATE);

  const done = occ.filter(o => o.status === 'done');
  const missed = occ.filter(o => o.status === 'missed');
  const open = occ.filter(o => o.status === 'pending');
  const now = new Date();
  const late = open.filter(o => o.due_at && new Date(fixIso(o.due_at)) < now);
  const openCas = todayCas.filter(c => !c.verified_at);

  const stat = (n, l, cls, bad) =>
    `<div class="stat${bad ? ' bad' : ''}"><div class="statn${cls ? ' ' + cls : ''}">${n}</div>
     <div class="statl">${l}</div></div>`;

  let html = `<h1>Today</h1>
    <p class="sub">${new Date().toLocaleDateString('en-GB',
      { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ })} · updated ${hhmm(new Date().toISOString())}</p>
    <div class="stats">
      ${stat(done.length, 'Signed off', 'pass')}
      ${stat(open.length, 'Still to do')}
      ${stat(late.length, 'Overdue', late.length ? 'warn' : '')}
      ${stat(todayCas.length, 'Failed readings', todayCas.length ? 'fail' : '', todayCas.length > 0)}
      ${stat(missed.length, 'Missed', missed.length ? 'fail' : '')}
    </div>`;

  if (openCas.length) {
    html += `<div class="glab">Needs you <span class="ln"></span></div>`;
    openCas.forEach(c => {
      const u = c.readings?.units;
      html += `<button class="row bad" data-ca="${c.id}">
        <span class="rt">${hhmm(c.created_at)}</span>
        <span class="dot fail"></span>
        <span class="rn">${esc(u ? u.name : 'Reading')} — ${c.readings?.value_c}°C
          (limit ${u ? u.limit_c : '?'}°C)${c.action_taken ? ' · ' + esc(c.action_taken) : ''}</span>
        <span class="rm">${esc(c.records?.staff?.name || '')}</span>
        <span class="chip fail">Re-check ${hhmm(c.verify_due_at)}</span>
      </button>`;
    });
  }

  if (late.length) {
    html += `<div class="glab">Overdue <span class="ln"></span></div>`;
    late.forEach(o => {
      const mins = Math.round((now - new Date(fixIso(o.due_at))) / 60000);
      html += `<div class="row warnr flat">
        <span class="rt">${hhmm(o.due_at)}</span><span class="dot warn"></span>
        <span class="station">${esc(o.stations.name)}</span>
        <span class="rn">${esc(o.checks.name)}</span>
        <span class="chip warn">${mins >= 60 ? Math.floor(mins / 60) + 'h ' + mins % 60 + 'm' : mins + ' min'} late</span>
      </div>`;
    });
  }

  if (!occ.length) html += `<div class="empty">Nothing scheduled — the site may be closed today.</div>`;
  else html += groupByArea(occ);

  m.innerHTML = html;
  m.querySelectorAll('[data-occ]').forEach(b => b.onclick = () => openRecord(b.dataset.occ));
}

/* -------------------------------------------------------------- records */

async function viewRecords() {
  const m = $('main');
  m.innerHTML = `<h1>Records</h1>
    <p class="sub">Every signature kept, by law, for at least twelve months.</p>
    <div class="bar">
      <input type="date" id="d" value="${DATE}" max="${today()}">
      <button class="btn" id="prev">← Day before</button>
      <button class="btn" id="next">Day after →</button>
      <button class="btn" id="tod">Today</button>
    </div>
    <div id="list"><div class="empty">Loading…</div></div>`;

  $('d').onchange = e => { DATE = e.target.value; viewRecords(); };
  const shift = n => { const d = new Date(DATE); d.setDate(d.getDate() + n);
    DATE = d.toLocaleDateString('en-CA'); viewRecords(); };
  $('prev').onclick = () => shift(-1);
  $('next').onclick = () => shift(1);
  $('tod').onclick = () => { DATE = today(); viewRecords(); };

  const { data: occ, error } = await db.from('occurrences')
    .select(`id,due_at,status,checks(name,kind),stations(name,sort,areas(id,name,sort)),
             records(id,signed_at,was_late,minutes_late,note,staff(name))`)
    .eq('service_date', DATE).order('due_at');
  const list = $('list');
  if (error) return list.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  if (!occ.length) return list.innerHTML =
    `<div class="empty">Nothing on ${DATE}. The site was probably closed.</div>`;

  list.innerHTML = groupByArea(occ);
  list.querySelectorAll('[data-occ]').forEach(b => b.onclick = () => openRecord(b.dataset.occ));
}

/* Two floors means a flat list stops being readable. Group by area,
   biggest first, with the station still named on every row. */
function groupByArea(occ) {
  const areas = [];
  occ.forEach(o => {
    const a = o.stations.areas || { id: 'x', name: 'Unknown', sort: 99 };
    let g = areas.find(x => x.id === a.id);
    if (!g) { g = { id: a.id, name: a.name, sort: a.sort ?? 0, rows: [] }; areas.push(g); }
    g.rows.push(o);
  });
  areas.sort((x, y) => x.sort - y.sort);

  return areas.map(g => {
    const done = g.rows.filter(o => o.status === 'done').length;
    const bad  = g.rows.filter(o => o.status === 'missed').length;
    return `<div class="arealab">
        <span class="an">${esc(g.name)}</span>
        <span class="ln"></span>
        <span class="acount">${done} of ${g.rows.length} signed${bad ? ` · ${bad} missed` : ''}</span>
      </div>` + g.rows.map(rowHtml).join('');
  }).join('');
}

function rowHtml(o) {
  const r = o.records && o.records[0];
  const chip = o.status === 'done' ? (r && r.was_late ? 'warn' : 'pass')
             : o.status === 'missed' ? 'fail' : 'grey';
  const label = o.status === 'done' ? (r && r.was_late ? r.minutes_late + ' min late' : 'Signed')
              : o.status === 'missed' ? 'Missed'
              : o.status === 'expired' ? 'Not needed' : 'Outstanding';
  return `<button class="row ${o.status === 'missed' ? 'bad' : ''}" data-occ="${o.id}">
      <span class="rt">${hhmm(o.due_at)}</span>
      <span class="dot ${o.status === 'done' ? 'pass' : o.status === 'missed' ? 'fail' : ''}"></span>
      <span class="station">${esc(o.stations.name)}</span>
      <span class="rn">${esc(o.checks.name)}</span>
      <span class="rm">${r ? esc(r.staff?.name || '') + ' · ' + hhmm(r.signed_at) : ''}</span>
      <span class="chip ${chip}">${label}</span>
    </button>`;
}

/* --------------------------------------------------------- one record */

async function openRecord(occId) {
  const dr = $('drawer'), p = $('dpanel');
  dr.classList.add('open');
  p.innerHTML = `<div class="dhead"><div class="dtitle">Loading…</div></div>`;

  const { data: o } = await db.from('occurrences')
    .select(`id,due_at,status,service_date,check_version_id,
             checks(name,kind,intro),stations(name),
             records(id,signed_at,received_at,was_offline,delay_minutes,
                     was_late,minutes_late,note,staff(name,job_title))`)
    .eq('id', occId).single();
  if (!o) { p.innerHTML = `<div class="dhead"><div class="dtitle">Not found</div></div>`; return; }

  const rec = o.records && o.records[0];
  let body = '';

  if (!rec) {
    body = `<div class="empty">${o.status === 'missed'
      ? 'Never completed. Recorded as missed at the end of that day.'
      : 'Not done yet.'}</div>`;
  } else {
    const [steps, reads, counts, cas] = await Promise.all([
      db.from('record_steps').select('done,done_at,steps(text,photo_required)').eq('record_id', rec.id),
      db.from('readings').select('value_c,passed,skipped,skip_reason,taken_at,units(name,limit_c,limit_kind)').eq('record_id', rec.id),
      db.from('counts').select('qty,below_reorder,count_items(name,reorder_level,unit_label)').eq('record_id', rec.id),
      db.from('corrective_actions').select('*,readings(value_c,units(name,limit_c))').eq('record_id', rec.id)
    ]);

    (steps.data || []).forEach(s => {
      body += `<div class="line"><span class="dot pass"></span>
        <span>${esc(s.steps.text)}</span><span class="v">${hhmm(s.done_at)}</span></div>`;
    });
    (reads.data || []).forEach(r => {
      if (r.skipped) {
        body += `<div class="line skip"><span class="dot"></span>
          <span>${esc(r.units.name)}</span>
          <span class="v">${esc(r.skip_reason || 'not recorded')}</span></div>`;
      } else {
        body += `<div class="line"><span class="dot ${r.passed ? 'pass' : 'fail'}"></span>
          <span>${esc(r.units.name)} <small style="color:#8a8681">
            (${r.units.limit_kind === 'min' ? 'min' : 'max'} ${r.units.limit_c}°C)</small></span>
          <span class="v ${r.passed ? 'pass' : 'fail'}">${r.value_c}°C</span></div>`;
      }
    });
    (counts.data || []).forEach(c => {
      body += `<div class="line"><span class="dot ${c.below_reorder ? 'fail' : 'pass'}"></span>
        <span>${esc(c.count_items.name)}</span>
        <span class="v ${c.below_reorder ? 'fail' : ''}">${c.qty}${
          c.below_reorder ? ' — order more' : ''}</span></div>`;
    });

    (cas.data || []).forEach(c => {
      const basis = { last_pass_today: 'last confirmed good today',
        last_check_today: 'last checked today',
        shift_start: 'no earlier check — since the shift opened',
        staff: 'stated by the person on shift', unknown: 'not known' }[c.started_basis] || c.started_basis || '';
      body += `<div class="ca"><h3>Corrective action — ${esc(c.readings?.units?.name || '')}</h3>
        <div class="kv">
          <span>Reading</span><b>${c.peak_value_c}°C · ${c.deviation_c}°C out</b>
          <span>Started</span><b>${dayTime(c.started_at)}<br>
            <small style="font-weight:300;color:#8a8681">${esc(basis)}</small></b>
          <span>Food affected</span><b>${esc(c.food || '—')} ${esc(c.quantity || '')}</b>
          <span>Action taken</span><b>${esc(c.action_taken || '—')}</b>
          <span>Re-check due</span><b>${dayTime(c.verify_due_at)}</b>
          <span>Verified</span><b>${c.verified_at ? dayTime(c.verified_at)
            : '<span style="color:var(--fail)">still open</span>'}</b>
        </div></div>`;
    });

    const { data: photos } = await db.from('photos').select('id,path').eq('record_id', rec.id);
    for (const ph of photos || []) {
      const { data: signed } = await db.storage.from('evidence').createSignedUrl(ph.path, 300);
      if (signed) body += `<div class="shot"><img src="${signed.signedUrl}" alt="Evidence photo"></div>`;
    }
    if (rec.note) body += `<div class="line"><span>Note</span><span class="v">${esc(rec.note)}</span></div>`;
  }

  p.innerHTML = `
    <div class="dhead">
      <button class="btn" id="close">← Close</button>
      <div class="dtitle">${esc(o.checks.name)}</div>
      <p class="dmeta">${esc(o.stations.name)} · due ${hhmm(o.due_at)} · ${o.service_date}</p>
      ${rec ? `<p class="dmeta" style="margin-top:7px">
        Signed by <b>${esc(rec.staff?.name || '')}</b> at ${hhmm(rec.signed_at)}${
          rec.was_late ? ` · <span style="color:var(--warn)">${rec.minutes_late} min late</span>` : ''}</p>
        ${rec.was_offline ? `<p class="dmeta" style="margin-top:6px;color:var(--warn)">
          ⏱ Recorded offline. Done at ${hhmm(rec.signed_at)}, reached us at ${hhmm(rec.received_at)}
          — ${rec.delay_minutes} min later.</p>` : ''}` : ''}
    </div>
    <div class="dbody">${body}</div>`;
  $('close').onclick = () => dr.classList.remove('open');
}

$('drawer').onclick = e => { if (e.target.id === 'drawer') e.currentTarget.classList.remove('open'); };

db.auth.onAuthStateChange((_e, s) => { if (!s) showLogin(); });
boot();

/* ================================================================ checks */

const KINDS = {
  checklist:   { label: 'Checklist',        blurb: 'A list of things to tick off, one by one. Any line can be made to need a photo.', eg: 'Opening checks · closing down · cleaning' },
  temperature: { label: 'Temperature round', blurb: 'Readings taken against a limit. A failure opens the corrective record on its own.', eg: 'Fridges · hot holding · probe calibration' },
  count:       { label: 'Stock count',       blurb: 'A number against each item, flagged when it drops below its re-order level.', eg: 'Bowls · lids · cutlery · bags' },
  incident:    { label: 'Incident form',     blurb: 'Something went wrong and needs recording, with a photo and a description.', eg: 'Accidents · equipment faults · complaints' },
  reminder:    { label: 'Reminder',          blurb: 'Shown on screen all day. Never signed off, never overdue, no record kept.', eg: 'Check the tables when needed' }
};
const PATTERNS = {
  once_daily:    'Once a day, inside a window',
  set_times:     'At set times of day',
  every_n_hours: 'Every few hours',
  certain_days:  'Only on certain days',
  every_n_weeks: 'Every few weeks',
  on_demand:     'Whenever it happens — no fixed time'
};
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
let STATIONS = [];

async function viewChecks() {
  const m = $('main');
  m.innerHTML = `<h1>Checks</h1><p class="sub">Loading…</p>`;
  if (!STATIONS.length) {
    const { data } = await db.from('stations').select('id,name,sort,areas(name)').order('sort');
    STATIONS = data || [];
  }
  const { data: checks, error } = await db.from('checks')
    .select(`id,kind,name,est_minutes,archived_at,station_id,
             check_versions(id,version_no,status),schedules(pattern,window_start,window_end,times,interval_hours,days,active)`)
    .is('archived_at', null);
  if (error) return m.innerHTML = `<h1>Checks</h1><div class="empty">${esc(error.message)}</div>`;

  let html = `<h1>Checks</h1>
    <p class="sub">Everything the iPad can show. Editing a live check creates a new version, so past records never change.</p>
    <div class="bar"><button class="btn cta" id="new">+ New check</button></div>`;

  STATIONS.forEach(st => {
    const mine = (checks || []).filter(c => c.station_id === st.id);
    html += `<div class="glab">${esc(st.name)} <span class="ln"></span></div>`;
    if (!mine.length) { html += `<div class="empty">Nothing here yet.</div>`; return; }
    mine.forEach(c => {
      const live = (c.check_versions || []).find(v => v.status === 'live');
      const sc = (c.schedules || [])[0];
      html += `<button class="row" data-edit="${c.id}">
        <span class="chip grey">${esc(KINDS[c.kind] ? KINDS[c.kind].label : c.kind)}</span>
        <span class="rn">${esc(c.name)}</span>
        <span class="rm">${sc ? esc(scheduleWords(sc)) : 'no schedule'}</span>
        <span class="chip ${live ? 'pass' : 'warn'}">${live ? 'Live · v' + live.version_no : 'Draft'}</span>
      </button>`;
    });
  });
  m.innerHTML = html;
  $('new').onclick = () => builder(null);
  m.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => builder(b.dataset.edit));
}

function scheduleWords(s) {
  if (!s) return 'no schedule';
  const d = (s.days || []).length === 7 ? 'every day'
    : (s.days || []).map(n => DAYS[n - 1]).join(' ');
  if (s.pattern === 'on_demand')    return 'whenever it happens';
  if (s.pattern === 'set_times')    return (s.times || []).map(t => t.slice(0, 5)).join(', ') + ' · ' + d;
  if (s.pattern === 'every_n_hours') return `every ${s.interval_hours}h ${(s.window_start || '').slice(0, 5)}–${(s.window_end || '').slice(0, 5)}`;
  return `by ${(s.window_end || s.window_start || '').slice(0, 5)} · ${d}`;
}

/* -------------------------------------------------------------- builder */

let B = null;

async function builder(checkId) {
  B = { id: checkId, kind: null, name: '', station_id: STATIONS[0]?.id, intro: '', est: '',
        items: [], sched: { pattern: 'once_daily', days: [1,2,3,4,5], window_start: '10:30',
        window_end: '11:00', times: ['12:00'], interval_hours: 2, lead_minutes: 15 },
        versionNo: 0, isNew: !checkId };

  if (checkId) {
    const { data: c } = await db.from('checks')
      .select('*,check_versions(id,version_no,status),schedules(*)').eq('id', checkId).single();
    B.kind = c.kind; B.name = c.name; B.station_id = c.station_id;
    B.intro = c.intro || ''; B.est = c.est_minutes || '';
    const live = (c.check_versions || []).sort((a, b) => b.version_no - a.version_no)[0];
    B.versionNo = live ? live.version_no : 0;
    B.versionId = live ? live.id : null;
    if (c.schedules && c.schedules[0]) B.sched = { ...B.sched, ...c.schedules[0] };
    if (B.versionId && B.kind !== 'incident' && B.kind !== 'reminder') {
      const tbl = B.kind === 'temperature' ? 'units' : B.kind === 'count' ? 'count_items' : 'steps';
      const { data: items } = await db.from(tbl).select('*').eq('check_version_id', B.versionId).order('sort');
      B.items = (items || []).map(x => ({ ...x }));
    }
  }
  drawBuilder();
}

function drawBuilder() {
  const dr = $('drawer'), p = $('dpanel');
  dr.classList.add('open');

  if (!B.kind) {
    p.innerHTML = `<div class="dhead"><button class="btn" id="close">← Cancel</button>
      <div class="dtitle">What kind of check?</div>
      <p class="dmeta">Everything after this adjusts to suit.</p></div>
      <div class="dbody">${Object.entries(KINDS).map(([k, v]) =>
        `<button class="row" data-kind="${k}" style="height:auto;padding:16px;align-items:flex-start;flex-direction:column;gap:5px">
          <span class="rn" style="font-size:17px;font-weight:600">${v.label}</span>
          <span class="rm" style="white-space:normal;text-align:left">${v.blurb}</span>
          <span class="rm" style="color:#9a9691">${v.eg}</span>
        </button>`).join('')}</div>`;
    $('close').onclick = () => dr.classList.remove('open');
    p.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { B.kind = b.dataset.kind; drawBuilder(); });
    return;
  }

  const k = B.kind, noItems = k === 'incident' || k === 'reminder';
  const noSched = k === 'reminder';
  const itemLabel = k === 'temperature' ? 'Units and their limits'
    : k === 'count' ? 'Items and re-order levels' : 'Steps';

  p.innerHTML = `
    <div class="dhead">
      <button class="btn" id="close">← Cancel</button>
      <div class="dtitle">${B.isNew ? 'New ' + KINDS[k].label.toLowerCase() : esc(B.name)}</div>
      <p class="dmeta">${B.isNew ? 'It goes live as version 1.'
        : `Live version ${B.versionNo} — publishing creates version ${B.versionNo + 1}. Records already signed keep version ${B.versionNo}.`}</p>
    </div>
    <div class="dbody">
      <div class="ask"><span class="asklab">Name</span>
        <input class="finp" id="bname" value="${esc(B.name)}" placeholder="e.g. Opening checks — kitchen ready"></div>
      <div class="ask"><span class="asklab">Which station</span>
        <select class="finp" id="bstation">${STATIONS.map(s =>
          `<option value="${s.id}" ${s.id === B.station_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="ask"><span class="asklab">How to do it (optional)</span>
        <textarea class="finp ta" id="bintro" placeholder="Shown at the top of the check on the iPad">${esc(B.intro)}</textarea></div>
      <div class="ask"><span class="asklab">Roughly how long (minutes, optional)</span>
        <input class="finp" id="best" type="number" min="1" value="${esc(B.est)}" style="width:120px"></div>

      ${noItems ? '' : `<div class="glab">${itemLabel} <span class="ln"></span></div>
        <div id="items">${B.items.map(itemRow).join('')}</div>
        <button class="btn" id="additem">+ Add ${k === 'checklist' ? 'a step' : 'an item'}</button>`}

      ${noSched ? `<div class="glab">When <span class="ln"></span></div>
        <div class="empty">A reminder is always on screen. No schedule, no sign-off, no record.</div>`
      : `<div class="glab">When <span class="ln"></span></div>
        <div class="ask"><span class="asklab">How often</span>
          <select class="finp" id="bpat">${Object.entries(PATTERNS).map(([v, l]) =>
            `<option value="${v}" ${v === B.sched.pattern ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div id="schedfields">${schedFields()}</div>
        ${B.sched.pattern === 'on_demand' ? '' : `<div class="ask"><span class="asklab">Days</span>
          <div class="opts">${DAYS.map((d, i) =>
            `<button class="opt ${(B.sched.days || []).includes(i + 1) ? 'on' : ''}" data-day="${i + 1}">${d}</button>`).join('')}</div></div>`}`}
    </div>
    <div class="dfoot">
      ${B.isNew ? '' : `<button class="btn" id="archive">Archive</button>`}
      <button class="btn cta" id="publish">${B.isNew ? 'Publish' : 'Publish v' + (B.versionNo + 1)}</button>
    </div>`;

  $('close').onclick = () => dr.classList.remove('open');
  $('bname').oninput = e => B.name = e.target.value;
  $('bstation').onchange = e => B.station_id = e.target.value;
  $('bintro').oninput = e => B.intro = e.target.value;
  $('best').oninput = e => B.est = e.target.value;
  if ($('bpat')) $('bpat').onchange = e => { B.sched.pattern = e.target.value; drawBuilder(); };
  if ($('additem')) $('additem').onclick = () => { B.items.push(blankItem()); drawBuilder(); };
  p.querySelectorAll('[data-day]').forEach(b => b.onclick = () => {
    const n = +b.dataset.day, d = B.sched.days || [];
    B.sched.days = d.includes(n) ? d.filter(x => x !== n) : [...d, n].sort();
    drawBuilder();
  });
  bindItems(p);
  bindSched(p);
  $('publish').onclick = publish;
  if ($('archive')) $('archive').onclick = archive;
}

function blankItem() {
  if (B.kind === 'temperature') return { name: '', limit_kind: 'max', limit_c: 8, basis: '', guidance: '', guidance_image: null };
  if (B.kind === 'count') return { name: '', reorder_level: 1, unit_label: '', guidance: '', guidance_image: null };
  return { text: '', photo_required: false, guidance: '', guidance_image: null };
}

function itemRow(it, i) {
  if (B.kind === 'temperature') return `<div class="irow">
      <input class="finp" data-i="${i}" data-f="name" value="${esc(it.name)}" placeholder="e.g. Walk-in chiller">
      <select class="finp sm" data-i="${i}" data-f="limit_kind">
        <option value="max" ${it.limit_kind === 'max' ? 'selected' : ''}>no more than</option>
        <option value="min" ${it.limit_kind === 'min' ? 'selected' : ''}>at least</option></select>
      <input class="finp sm" type="number" step="0.1" data-i="${i}" data-f="limit_c" value="${esc(it.limit_c)}">
      <span class="deg">°C</span>
      <button class="del" data-del="${i}">✕</button></div>
      ${imgRow(it, i, true)}`;
  if (B.kind === 'count') return `<div class="irow">
      <input class="finp" data-i="${i}" data-f="name" value="${esc(it.name)}" placeholder="e.g. Bowls">
      <span class="deg">order below</span>
      <input class="finp sm" type="number" data-i="${i}" data-f="reorder_level" value="${esc(it.reorder_level)}">
      <input class="finp sm" data-i="${i}" data-f="unit_label" value="${esc(it.unit_label || '')}" placeholder="sleeves">
      <button class="del" data-del="${i}">✕</button></div>
      ${imgRow(it, i, true)}`;
  return `<div class="irow col">
      <div class="irowtop">
        <input class="finp" data-i="${i}" data-f="text" value="${esc(it.text)}" placeholder="Say it as you would to a new starter">
        <button class="opt photoreq ${it.photo_required ? 'on' : ''}" data-photo="${i}">${
          it.photo_required ? '✓ Photo required' : 'No photo needed'}</button>
        <button class="del" data-del="${i}">✕</button>
      </div>
      <input class="finp tiny" data-i="${i}" data-f="guidance" value="${esc(it.guidance || '')}" placeholder="How to do it — shown behind the ? (optional)">
      ${imgRow(it, i)}
    </div>`;
}

function imgRow(it, i, standalone) {
  return `<div class="imgrow${standalone ? ' standalone' : ''}">
    ${it.guidance_image
      ? `<img src="${esc(it.guidance_image)}" alt="How-to">
         <button class="tiny" data-imgdel="${i}">Remove picture</button>`
      : `<button class="tiny" data-img="${i}">+ Add a how-to picture</button>`}
  </div>`;
}

async function uploadGuidanceImage(i) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const blob = await shrinkImage(f, 1200, 0.72);
      const path = `${B.id || 'new'}/${Date.now()}-${i}.jpg`;
      const { error } = await db.storage.from('reference')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      if (error) throw error;
      const { data } = db.storage.from('reference').getPublicUrl(path);
      B.items[i].guidance_image = data.publicUrl;
      drawBuilder();
    } catch (e) { alert('Could not add the picture: ' + (e.message || e)); }
  };
  inp.click();
}

// keep them small — a how-to photo is a reference, not a print
function shrinkImage(file, max, q) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? res(b) : rej(new Error('could not compress')), 'image/jpeg', q);
    };
    img.onerror = () => rej(new Error('could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}

function bindItems(p) {
  p.querySelectorAll('[data-img]').forEach(b => b.onclick = () => uploadGuidanceImage(+b.dataset.img));
  p.querySelectorAll('[data-imgdel]').forEach(b => b.onclick = () => {
    B.items[+b.dataset.imgdel].guidance_image = null; drawBuilder();
  });
  p.querySelectorAll('[data-f]').forEach(el => el.oninput = el.onchange = e => {
    const i = +e.target.dataset.i, f = e.target.dataset.f;
    B.items[i][f] = f === 'limit_c' ? parseFloat(e.target.value)
      : f === 'reorder_level' ? parseInt(e.target.value, 10) : e.target.value;
  });
  p.querySelectorAll('[data-photo]').forEach(b => b.onclick = () => {
    const i = +b.dataset.photo; B.items[i].photo_required = !B.items[i].photo_required; drawBuilder();
  });
  p.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    B.items.splice(+b.dataset.del, 1); drawBuilder();
  });
}

function schedFields() {
  const s = B.sched;
  if (s.pattern === 'on_demand') return `<div class="empty">Always available. Never due, never overdue.</div>`;
  if (s.pattern === 'set_times') return `<div class="ask"><span class="asklab">Times (comma separated)</span>
    <input class="finp" id="stimes" value="${(s.times || []).map(t => t.slice(0, 5)).join(', ')}" placeholder="12:00, 14:00, 15:45"></div>`;
  if (s.pattern === 'every_n_hours') return `<div class="ask"><span class="asklab">Every how many hours, and between when</span>
    <div class="inline"><input class="finp sm" id="sint" type="number" step="0.5" value="${s.interval_hours || 2}">
    <span class="deg">hours, from</span><input class="finp sm" id="swstart" type="time" value="${(s.window_start || '11:30').slice(0, 5)}">
    <span class="deg">until</span><input class="finp sm" id="swend" type="time" value="${(s.window_end || '21:00').slice(0, 5)}"></div></div>`;
  return `<div class="ask"><span class="asklab">Any time between</span>
    <div class="inline"><input class="finp sm" id="swstart" type="time" value="${(s.window_start || '10:30').slice(0, 5)}">
    <span class="deg">and</span><input class="finp sm" id="swend" type="time" value="${(s.window_end || '11:00').slice(0, 5)}">
    <span class="deg">— due at the end</span></div></div>`;
}

function bindSched(p) {
  const g = id => p.querySelector('#' + id);
  if (g('stimes')) g('stimes').oninput = e => B.sched.times =
    e.target.value.split(',').map(t => t.trim()).filter(Boolean);
  if (g('sint')) g('sint').oninput = e => B.sched.interval_hours = parseFloat(e.target.value);
  if (g('swstart')) g('swstart').oninput = e => B.sched.window_start = e.target.value;
  if (g('swend')) g('swend').oninput = e => B.sched.window_end = e.target.value;
}

/* --------------------------------------------------------------- saving */

async function publish() {
  if (!B.name.trim()) return alert('Give it a name.');
  const noItems = B.kind === 'incident' || B.kind === 'reminder';
  if (!noItems && !B.items.length) return alert('Add at least one item.');
  if (!noItems && B.items.some(i => !(i.text || i.name || '').trim()))
    return alert('One of the items has no name.');

  const btn = $('publish'); btn.disabled = true; btn.textContent = 'Publishing…';
  try {
    let checkId = B.id;
    const payload = { station_id: B.station_id, kind: B.kind, name: B.name.trim(),
                      intro: B.intro.trim() || null, est_minutes: B.est ? +B.est : null };
    if (checkId) {
      const { error } = await db.from('checks').update(payload).eq('id', checkId);
      if (error) throw error;
    } else {
      const { data, error } = await db.from('checks').insert(payload).select('id').single();
      if (error) throw error;
      checkId = data.id;
    }

    // a new version every publish, so signed records keep the wording they were signed against
    const nextNo = B.versionNo + 1;
    const { data: ver, error: ve } = await db.from('check_versions')
      .insert({ check_id: checkId, version_no: nextNo, status: 'live', published_at: new Date().toISOString() })
      .select('id').single();
    if (ve) throw ve;
    if (B.versionId) await db.from('check_versions').update({ status: 'retired' }).eq('id', B.versionId);

    if (!noItems) {
      const tbl = B.kind === 'temperature' ? 'units' : B.kind === 'count' ? 'count_items' : 'steps';
      const rows = B.items.map((it, i) => {
        const base = { check_version_id: ver.id, sort: i + 1 };
        if (B.kind === 'temperature') return { ...base, name: it.name, limit_kind: it.limit_kind,
          limit_c: it.limit_c, basis: it.basis || null, guidance: it.guidance || null,
          guidance_image: it.guidance_image || null };
        if (B.kind === 'count') return { ...base, name: it.name, reorder_level: it.reorder_level ?? null,
          unit_label: it.unit_label || null, guidance: it.guidance || null,
          guidance_image: it.guidance_image || null };
        return { ...base, text: it.text, photo_required: !!it.photo_required,
          guidance: it.guidance || null, guidance_image: it.guidance_image || null };
      });
      const { error } = await db.from(tbl).insert(rows);
      if (error) throw error;
    }

    if (B.kind !== 'reminder') {
      const s = B.sched;
      const sched = { check_id: checkId, pattern: s.pattern, days: s.days || [1,2,3,4,5,6,7],
        lead_minutes: s.lead_minutes ?? 15, active: true,
        window_start: ['once_daily','every_n_hours','certain_days'].includes(s.pattern) ? s.window_start : null,
        window_end:   ['once_daily','every_n_hours','certain_days'].includes(s.pattern) ? s.window_end : null,
        times:        s.pattern === 'set_times' ? s.times : null,
        interval_hours: s.pattern === 'every_n_hours' ? s.interval_hours : null };
      await db.from('schedules').delete().eq('check_id', checkId);
      const { error } = await db.from('schedules').insert(sched);
      if (error) throw error;
    }

    await db.rpc('spawn_occurrences');
    $('drawer').classList.remove('open');
    viewChecks();
  } catch (e) {
    alert('Could not publish: ' + (e.message || e));
    btn.disabled = false; btn.textContent = 'Publish';
  }
}

async function archive() {
  if (!confirm('Archive this check? It stops appearing on the iPad. Past records are kept.')) return;
  await db.from('checks').update({ archived_at: new Date().toISOString() }).eq('id', B.id);
  await db.from('schedules').update({ active: false }).eq('check_id', B.id);
  $('drawer').classList.remove('open');
  viewChecks();
}

/* ================================================================ people */

const ROLES = { staff: 'Staff — signs checks only',
                manager: 'Manager — can manage people and checks',
                admin: 'Admin — everything' };

async function viewPeople() {
  const m = $('main');
  m.innerHTML = `<h1>People</h1><p class="sub">Loading…</p>`;
  if (!STATIONS.length) {
    const { data } = await db.from('stations').select('id,name,sort').order('sort');
    STATIONS = data || [];
  }
  const { data: staff, error } = await db.from('staff')
    .select('id,name,job_title,email,role,pin_hash,pin_set_at,active,left_on,home_station')
    .order('active', { ascending: false }).order('name');
  if (error) return m.innerHTML = `<h1>People</h1><div class="empty">${esc(error.message)}</div>`;

  // when did each person last sign anything?
  const { data: last } = await db.from('records')
    .select('signed_by,signed_at').order('signed_at', { ascending: false }).limit(400);
  const lastBy = {};
  (last || []).forEach(r => { if (!lastBy[r.signed_by]) lastBy[r.signed_by] = r.signed_at; });

  const live = staff.filter(s => s.active);
  const gone = staff.filter(s => !s.active);

  const rowFor = s => {
    const st = STATIONS.find(x => x.id === s.home_station);
    return `<button class="row ${s.active ? '' : 'okr'}" data-person="${s.id}">
      <span class="rn">${esc(s.name)}${s.role !== 'staff'
        ? ` <span class="chip grey">${s.role}</span>` : ''}</span>
      <span class="rm">${esc(s.job_title || '')}</span>
      <span class="station">${esc(st ? st.name : '')}</span>
      <span class="rm">${lastBy[s.id] ? 'last signed ' + dayTime(lastBy[s.id]) : 'never signed'}</span>
      <span class="chip ${!s.active ? 'grey' : s.pin_hash ? 'pass' : 'warn'}">
        ${!s.active ? 'Left' : s.pin_hash ? 'PIN active' : 'No PIN yet'}</span>
    </button>`;
  };

  m.innerHTML = `<h1>People</h1>
    <p class="sub">PINs are generated, never chosen, and shown once. Nothing here can display an existing PIN — the same as a password.</p>
    <div class="bar"><button class="btn cta" id="add">+ Add someone</button></div>
    <div class="glab">Active — ${live.length} <span class="ln"></span></div>
    ${live.map(rowFor).join('') || '<div class="empty">Nobody yet.</div>'}
    ${gone.length ? `<div class="glab">Left <span class="ln"></span></div>${gone.map(rowFor).join('')}` : ''}`;

  $('add').onclick = () => personPanel(null);
  m.querySelectorAll('[data-person]').forEach(b =>
    b.onclick = () => personPanel(staff.find(x => x.id === b.dataset.person)));
}

function personPanel(p0) {
  const dr = $('drawer'), p = $('dpanel');
  const isNew = !p0;
  let P = p0 ? { ...p0 } : { name: '', job_title: '', role: 'staff',
                             home_station: STATIONS[0]?.id, email: '' };
  dr.classList.add('open');

  const draw = (pin) => {
    p.innerHTML = `
      <div class="dhead">
        <button class="btn" id="close">← Close</button>
        <div class="dtitle">${isNew ? 'Add someone' : esc(P.name)}</div>
        <p class="dmeta">${isNew ? 'They get a PIN, not a login.'
          : P.active ? (P.pin_hash ? 'PIN active since ' + dayTime(P.pin_set_at) : 'No PIN issued yet')
          : 'Left on ' + (P.left_on || '—') + ' · PIN revoked'}</p>
      </div>
      <div class="dbody">
        ${pin ? `<div class="pinbox">
            <div class="asklab" style="margin-bottom:0">Their PIN — shown once</div>
            <div class="pinbig">${pin.slice(0,3)} ${pin.slice(3)}</div>
            <div class="dmeta">Checked as unique. Write it down or print the slip now —
              it can never be displayed again.</div>
            <div class="pinrow">
              <button class="btn" id="printpin">Print slip</button>
              <button class="btn" id="againpin">Generate another</button>
            </div>
          </div>` : ''}
        <div class="ask"><span class="asklab">Name</span>
          <input class="finp" id="pname" value="${esc(P.name)}" placeholder="e.g. Rosa M."></div>
        <div class="ask"><span class="asklab">Job title</span>
          <input class="finp" id="pjob" value="${esc(P.job_title || '')}" placeholder="e.g. Kitchen porter"></div>
        <div class="ask"><span class="asklab">Usually works</span>
          <select class="finp" id="pstation">${STATIONS.map(s =>
            `<option value="${s.id}" ${s.id === P.home_station ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
        <div class="ask"><span class="asklab">Permission level</span>
          <select class="finp" id="prole">${Object.entries(ROLES).map(([v, l]) =>
            `<option value="${v}" ${v === P.role ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="ask" id="emailwrap" style="${P.role === 'staff' ? 'display:none' : ''}">
          <span class="asklab">Email — needed to sign in to this back end</span>
          <input class="finp" id="pemail" value="${esc(P.email || '')}" placeholder="name@zaha.global">
          <p class="dmeta" style="margin-top:6px">They also need a Supabase account created with this
            exact address, under Authentication → Users.</p></div>
      </div>
      <div class="dfoot">
        ${!isNew && P.active ? `<button class="btn" id="revoke">Mark as left</button>` : ''}
        ${!isNew && P.active ? `<button class="btn" id="reset">${P.pin_hash ? 'Reset PIN' : 'Issue PIN'}</button>` : ''}
        <button class="btn cta" id="save">${isNew ? 'Save & issue PIN' : 'Save'}</button>
      </div>`;

    $('close').onclick = () => { dr.classList.remove('open'); viewPeople(); };
    $('pname').oninput = e => P.name = e.target.value;
    $('pjob').oninput = e => P.job_title = e.target.value;
    $('pstation').onchange = e => P.home_station = e.target.value;
    $('prole').onchange = e => { P.role = e.target.value;
      $('emailwrap').style.display = P.role === 'staff' ? 'none' : ''; };
    if ($('pemail')) $('pemail').oninput = e => P.email = e.target.value;
    if ($('printpin')) $('printpin').onclick = () => printSlip(P.name, pin);
    if ($('againpin')) $('againpin').onclick = async () => {
      // cycles to a different number if this one is awkward to remember.
      // the old one is discarded the moment a new one is issued.
      const b = $('againpin'); b.disabled = true; b.textContent = 'Generating…';
      await issue(P.id, draw);
    };
    if ($('revoke')) $('revoke').onclick = () => revoke(P);
    if ($('reset')) $('reset').onclick = () => issue(P.id, draw);
    $('save').onclick = () => save(P, isNew, draw);
  };
  draw(null);
}

async function save(P, isNew, draw) {
  if (!P.name.trim()) return alert('They need a name.');
  if (P.role !== 'staff' && !(P.email || '').trim())
    return alert('A manager or admin needs an email to sign in with.');
  const btn = $('save'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const { data: site } = await db.from('sites').select('id').limit(1).single();
    const row = { site_id: site.id, name: P.name.trim(), job_title: P.job_title || null,
                  home_station: P.home_station, role: P.role,
                  email: P.role === 'staff' ? null : (P.email || '').trim().toLowerCase() || null };
    if (isNew) {
      const { data, error } = await db.from('staff').insert(row).select('id').single();
      if (error) throw error;
      P.id = data.id;
      await issue(P.id, draw);
    } else {
      const { error } = await db.from('staff').update(row).eq('id', P.id);
      if (error) throw error;
      $('drawer').classList.remove('open');
      viewPeople();
    }
  } catch (e) {
    alert('Could not save: ' + (e.message || e));
    btn.disabled = false; btn.textContent = 'Save';
  }
}

async function issue(staffId, draw) {
  const { data, error } = await db.rpc('issue_pin', { p_staff: staffId });
  if (error) return alert('Could not issue a PIN: ' + error.message);
  draw(data);
}

async function revoke(P) {
  if (!confirm(`Mark ${P.name} as left? Their PIN stops working immediately and is never reissued. All their past records are kept.`)) return;
  const { error } = await db.rpc('revoke_pin', { p_staff: P.id });
  if (error) return alert(error.message);
  $('drawer').classList.remove('open');
  viewPeople();
}

function printSlip(name, pin) {
  const w = window.open('', '_blank', 'width=420,height=320');
  w.document.write(`<title>PIN — ${esc(name)}</title>
    <style>body{font-family:Helvetica,Arial,sans-serif;padding:40px;text-align:center}
    h1{font-size:19px;margin:0 0 6px}p{font-size:12px;color:#666;margin:0 0 22px}
    .p{font-size:44px;font-weight:700;letter-spacing:.2em;margin:0 0 22px}
    small{font-size:11px;color:#888;line-height:1.5;display:block}</style>
    <h1>${esc(name)} — Zaha Missions</h1><p>Your PIN for signing checks</p>
    <div class="p">${pin.slice(0,3)} ${pin.slice(3)}</div>
    <small>Keep this private. It is your signature on a legal record.<br>
    Lost it? A manager can issue a new one.</small>`);
  w.document.close(); w.print();
}

/* =============================================================== devices */

async function viewDevices() {
  const m = $('main');
  m.innerHTML = `<h1>Devices</h1><p class="sub">Loading…</p>`;

  const { data: devs, error } = await db.from('devices')
    .select(`id,name,active,last_seen,areas(name,sort),
             device_links(id,user_agent,paired_at,last_seen,active,revoked_at,revoked_by),
             device_codes(id,code,created_at,used_at,voided_at)`)
    .eq('active', true);
  if (error) return m.innerHTML = `<h1>Devices</h1><div class="empty">${esc(error.message)}</div>`;

  devs.sort((a,b) => (a.areas?.sort ?? 0) - (b.areas?.sort ?? 0));
  const mins = t => t ? Math.round((Date.now() - new Date(fixIso(t))) / 60000) : null;

  let html = `<h1>Devices</h1>
    <p class="sub">Every screen, who is linked to it, and how to get a screen
       running again — all from here, wherever you are.</p>`;

  devs.forEach(d => {
    const live = (d.device_links || []).filter(l => l.active);
    const spare = (d.device_codes || []).filter(c => !c.used_at && !c.voided_at);
    const used = (d.device_codes || []).filter(c => c.used_at).slice(-3);
    const extra = live.length > 1;
    const quiet = live.length && live.every(l => (mins(l.last_seen) ?? 9999) > 30);

    html += `<div class="dev ${extra || !live.length || quiet ? 'warn' : ''}">
      <div class="devhead">
        <span class="devname">${esc(d.name)}</span>
        <span class="devarea">${esc(d.areas?.name || '')}</span>
        <span style="margin-left:auto">${
          !live.length ? '<span class="chip warn">Not linked</span>'
          : extra ? `<span class="chip fail">⚠ ${live.length} devices linked</span>`
          : quiet ? '<span class="chip warn">Not checked in recently</span>'
          : '<span class="chip pass">Linked and live</span>'}</span>
      </div>`;

    if (!live.length) {
      html += `<div class="empty">No device is linked. Give someone a code below.</div>`;
    } else {
      live.forEach(l => {
        const mm = mins(l.last_seen);
        const cls = mm == null ? 'off' : mm <= 10 ? 'on' : mm <= 30 ? 'stale' : 'off';
        const seen = mm == null ? 'never' : mm < 1 ? 'just now'
          : mm < 60 ? mm + ' min ago'
          : mm < 1440 ? Math.floor(mm/60) + 'h ago' : Math.floor(mm/1440) + 'd ago';
        html += `<div class="link">
          <span class="pulse ${cls}"></span>
          <span class="linkua">${esc(prettyAgent(l.user_agent))}</span>
          <span class="rm">paired ${dayTime(l.paired_at)}</span>
          <span class="rm" style="min-width:90px">seen ${seen}</span>
          <button class="btn-sm" data-revoke="${l.id}">Unlink</button>
        </div>`;
      });
    }

    html += `<div class="codes">${
      spare.length ? spare.map(c => `<span class="code">${esc(c.code)}</span>`).join('')
                   : '<span class="rm">No codes left</span>'}
      ${used.map(c => `<span class="code used">${esc(c.code)}</span>`).join('')}</div>
      <div class="devbar">
        <span class="rm">${spare.length} unused code${spare.length===1?'':'s'}${
          spare.length && spare.length <= 2 ? ' — running low' : ''}</span>
        <span style="flex:1"></span>
        <button class="btn" data-print="${d.id}">Print card</button>
        <button class="btn cta" data-issue="${d.id}">Issue 5 new codes</button>
      </div>
      <p class="sub" style="margin:10px 0 0;font-size:12px">
        Issuing new codes cancels any unused ones, so a lost card stops working.</p>
    </div>`;
  });

  m.innerHTML = html;
  m.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
    if (!confirm(
`Unlink this device?

• It stops working within about 3 minutes
• Whoever is using it drops back to the setup screen mid-shift
• They will need an unused code from the card to get going again

Anything already signed off stays recorded.`)) return;
    const { error } = await db.rpc('revoke_device_link', { p_link: b.dataset.revoke });
    if (error) return alert(error.message);
    viewDevices();
  });
  m.querySelectorAll('[data-issue]').forEach(b => b.onclick = async () => {
    const d = devs.find(x => x.id === b.dataset.issue);
    const spare = (d.device_codes || []).filter(c => !c.used_at && !c.voided_at).length;
    const live = (d.device_links || []).filter(l => l.active).length;
    if (!confirm(
`Issue 5 new setup codes for ${d.name}?

WHAT HAPPENS
• The ${spare} unused code${spare === 1 ? '' : 's'} on the current card stop working straight away
• 5 new codes are created
• You will need to print the new card and replace the old one

WHAT DOES NOT HAPPEN
• The ${live} device${live === 1 ? '' : 's'} already linked to this screen keep working
• Nobody is signed out and no shift is interrupted

To unlink a device, use Unlink next to it instead.`)) return;
    const { error } = await db.rpc('issue_device_codes', { p_device: b.dataset.issue, p_count: 5 });
    if (error) return alert(error.message);
    viewDevices();
  });
  m.querySelectorAll('[data-print]').forEach(b => b.onclick = () => {
    const d = devs.find(x => x.id === b.dataset.print);
    printCard(d, (d.device_codes||[]).filter(c => !c.used_at && !c.voided_at));
  });
}

// "Mozilla/5.0 (iPad; CPU OS 17_4…" means nothing to a manager
function prettyAgent(ua) {
  if (!ua) return 'Unknown device';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android device';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  return 'Unknown device';
}

function printCard(d, codes) {
  const w = window.open('', '_blank', 'width=460,height=620');
  w.document.write(`<title>${esc(d.name)} — setup codes</title>
   <style>body{font-family:Helvetica,Arial,sans-serif;padding:34px;color:#222}
   h1{font-size:19px;margin:0 0 3px}.a{font-size:12px;color:#777;margin:0 0 20px;
   letter-spacing:.1em;text-transform:uppercase}
   ol{padding-left:0;list-style:none;margin:0 0 22px}
   li{font-size:23px;font-weight:700;letter-spacing:.2em;padding:11px 0;
   border-bottom:1px dashed #ccc;display:flex;align-items:center}
   li span{width:26px;height:26px;border:1px solid #999;margin-left:auto;display:block}
   p{font-size:12px;color:#555;line-height:1.65;margin:0 0 8px}
   b{color:#222}</style>
   <h1>${esc(d.name)} — setup codes</h1>
   <p class="a">${esc(d.areas?.name||'')} · printed ${new Date().toLocaleDateString('en-GB')}</p>
   <ol>${codes.map(c => `<li>${esc(c.code)}<span></span></li>`).join('')}</ol>
   <p><b>Each code works once.</b> Use the top one that has not been crossed off,
      then tick its box.</p>
   <p>Keep this card with the iPad. If you run out, a manager can issue more from
      the back office from anywhere.</p>
   <p>If the screen still will not start, <b>use the paper log</b> and tell a manager.</p>`);
  w.document.close(); w.print();
}
