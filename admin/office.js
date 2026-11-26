/* ================================================================ office
   The rest of the back office, rebuilt the same way as Tasks: one side
   at a time, plain words, problems first, nothing to decode.

   - railHTML()      the vertical timeline (used by Tasks and Today)
   - viewTodayV2()   right now, per side, with "Needs you"
   - viewRecordsV2() history: day / week / month, problems only, person
   - viewInspector() the temperature log an inspector asks for, printable
   - viewPeopleV2()  people grouped by side, PIN status at a glance
   ================================================================ */

/* ------------------------------------------------- the shared timeline */

/* entries: { t, end?, time, title, sub, chip, cls, id }  (t/end in minutes)
   marks:   { t, label, cls }  — doors open, NOW
   A rail of times down the left, the gap between items following the
   clock, long items drawn taller — the same picture as the iPad. */
function railHTML(entries, marks, attr) {
  const all = entries.map(e => ({ ...e, k: 'e' })).concat((marks || []).map(m => ({ ...m, k: 'm' })))
    .sort((a, b) => a.t - b.t || (a.k === 'm' ? -1 : 1));
  let out = '<div class="arail">', last = null;
  all.forEach(it => {
    if (last !== null) out += `<div style="height:${Math.max(6, Math.min(64, (it.t - last) * 0.5))}px"></div>`;
    last = it.t;
    if (it.k === 'm') { out += `<div class="amark ${it.cls || ''}"><span>${esc(it.label)}</span></div>`; return; }
    const h = it.end && it.end > it.t ? Math.max(54, Math.min(180, (it.end - it.t) * 1.1)) : 0;
    out += `<div class="aitem">
        <span class="atime">${esc(it.time)}</span><span class="adot ${it.cls || ''} ${it.by ? 'by-' + it.by : ''}"></span>
        <button class="acard ${it.cls || ''} ${it.by ? 'by-' + it.by : ''}" ${attr}="${esc(it.id)}" ${h ? `style="min-height:${h}px"` : ''}>
          <span class="atitle">${esc(it.title)}${it.by ? `<span class="bytag by-${it.by}">${it.by === 'lead_guide' ? 'Lead guide' : 'Guide'}</span>` : ''}</span>
          ${it.chip ? `<span class="chip ${it.chipCls || 'grey'}">${esc(it.chip)}</span>` : ''}
          ${it.sub ? `<span class="asub">${esc(it.sub)}</span>` : ''}
        </button></div>`;
  });
  return out + '</div>';
}

const minsOfIso = iso => { const d = new Date(fixIso(iso)); const s = d.toLocaleTimeString('en-GB', { hour12: false, timeZone: TZ }); return toMins(s); };
const nowMins = () => toMins(new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: TZ }));
let DOORS = null;
async function doorsOpen() {
  if (DOORS !== null) return DOORS;
  const { data } = await db.from('sites').select('opens_at').limit(1);
  DOORS = data && data[0] && data[0].opens_at ? t5(data[0].opens_at) : '';
  return DOORS;
}
async function ensureStations() {
  if (!STATIONS.length || !STATIONS[0].areas) {
    const { data } = await db.from('stations').select('id,name,sort,areas(name,sort)').order('sort');
    STATIONS = data || [];
  }
}
function sideTabs(current, counts, extra) {
  return `<div class="ttabs">${(extra || '')}${sides().map(x =>
    `<button class="ttab ${x.id === current ? 'on' : ''}" data-side="${x.id}">
      <b>${esc(sideName(x))}</b><span>${esc(sideWhere(x))}${counts ? ' · ' + esc(counts(x)) : ''}</span></button>`).join('')}</div>`;
}

/* ---------------------------------------------------------------- today */

let TODAY_TAB = null, TODAY_TIMER = null;
async function viewTodayV2() {
  const m = $('main');
  if (!m.innerHTML.includes('id="today2"')) m.innerHTML = `<h1>Today</h1><p class="sub">Loading…</p>`;
  await ensureStations();
  const day = today();
  const [{ data: occ, error }, { data: dn }, { data: cas }, opens] = await Promise.all([
    db.from('occurrences').select(`id,due_at,appears_at,status,station_id,checks(name,kind,done_by),
        records(id,signed_at,was_late,minutes_late,steps_total,steps_done,staff(name))`)
      .eq('service_date', day).order('due_at'),
    db.rpc('board_done', { p_date: day }),
    db.from('corrective_actions').select(`id,verified_at,verify_due_at,created_at,action_taken,
        readings(value_c,units(name,limit_c)),records(staff(name),occurrences(station_id))`)
      .order('created_at', { ascending: false }).limit(40),
    doorsOpen()
  ]);
  if (error) return m.innerHTML = `<h1>Today</h1><div class="empty">${esc(error.message)}</div>`;
  const list = (occ || []).filter(o => o.checks && o.checks.kind !== 'incident');
  const doneMap = {}; (dn || []).forEach(d => doneMap[d.occurrence_id] = d);
  const nowM = nowMins();
  const S = sides();
  if (!S.some(x => x.id === TODAY_TAB)) TODAY_TAB = S[0]?.id;

  const stateOf = o => {
    const r = o.records && o.records[0], d = doneMap[o.id];
    if (o.status === 'missed') return 'missed';
    if (o.status === 'done') return d && d.total > 0 && d.done < d.total ? 'part' : (r && r.was_late ? 'donelate' : 'done');
    if (o.due_at && minsOfIso(o.due_at) < nowM) return 'late';
    if (o.appears_at && minsOfIso(o.appears_at) <= nowM) return 'now';
    if (!o.due_at) return 'any';
    return 'soon';
  };
  const lateBy = o => { const n = nowM - minsOfIso(o.due_at); return n >= 60 ? Math.floor(n / 60) + 'h ' + (n % 60) + 'm late' : n + ' min late'; };

  // Needs you — everything that wants a decision, across all sides
  const needs = [];
  (cas || []).filter(c => !c.verified_at && (c.created_at || '').slice(0, 10) === day).forEach(c => {
    const u = c.readings?.units;
    needs.push({ cls: 'fail', text: `${u ? u.name : 'A reading'} was ${c.readings?.value_c}°C (limit ${u ? u.limit_c : '?'}°C)${c.action_taken ? ' — ' + c.action_taken : ''}`,
      who: c.records?.staff?.name || '', tag: 'Re-check by ' + hhmm(c.verify_due_at) });
  });
  list.forEach(o => {
    const s = stateOf(o), stn = STATIONS.find(x => x.id === o.station_id);
    const where = stn ? sideName(stn) + ' · ' : '';
    if (s === 'late') needs.push({ cls: 'warn', text: where + o.checks.name, tag: lateBy(o), occ: o.id });
    if (s === 'part') { const d = doneMap[o.id]; needs.push({ cls: 'warn', text: where + o.checks.name, tag: `${d.total - d.done} line${d.total - d.done === 1 ? '' : 's'} not done`, occ: o.id }); }
    if (s === 'missed') needs.push({ cls: 'fail', text: where + o.checks.name, tag: 'Missed', occ: o.id });
  });

  const counts = x => {
    const mine = list.filter(o => o.station_id === x.id);
    const done = mine.filter(o => ['done', 'donelate', 'part'].includes(stateOf(o))).length;
    return `${done} of ${mine.length} signed`;
  };
  const stn = S.find(x => x.id === TODAY_TAB);
  const mine = list.filter(o => o.station_id === TODAY_TAB);
  const late = mine.filter(o => stateOf(o) === 'late').length;
  const toCome = mine.filter(o => ['soon', 'now', 'any'].includes(stateOf(o))).length;
  const signed = mine.filter(o => ['done', 'donelate', 'part'].includes(stateOf(o))).length;

  const entries = [], anyTime = [];
  mine.forEach(o => {
    const s = stateOf(o), r = o.records && o.records[0], d = doneMap[o.id];
    const chip = s === 'done' ? 'Signed' : s === 'donelate' ? r.minutes_late + ' min late' : s === 'part' ? `${d.done} of ${d.total} done`
      : s === 'late' ? lateBy(o) : s === 'missed' ? 'Missed' : s === 'now' ? 'Open now' : s === 'any' ? 'Any time' : 'Opens ' + hhmm(o.appears_at);
    const chipCls = { done: 'pass', donelate: 'warn', part: 'warn', late: 'fail', missed: 'fail' }[s] || 'grey';
    const e = { id: o.id, title: o.checks.name, chip, chipCls, cls: 'st-' + s, by: o.checks.done_by,
      sub: r ? 'by ' + (r.staff?.name || '?') + ' at ' + hhmm(r.signed_at) : '' };
    if (!o.due_at) { anyTime.push(e); return; }
    // every task at its START, with when it must be done by
    const st = o.appears_at && new Date(fixIso(o.appears_at)) < new Date(fixIso(o.due_at)) ? o.appears_at : o.due_at;
    entries.push({ ...e, t: minsOfIso(st), end: minsOfIso(o.due_at), time: hhmm(st),
      sub: ['Done by ' + hhmm(o.due_at), e.sub].filter(Boolean).join(' · ') });
  });
  const marks = [{ t: nowM, label: 'Now ' + hhmm(new Date().toISOString()), cls: 'now' }];
  if (opens) marks.push({ t: toMins(opens), label: 'Doors open ' + opens, cls: 'doors' });

  m.innerHTML = `<div id="today2">
    <h1>Today</h1>
    <p class="sub">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ })}
      · live, updated ${hhmm(new Date().toISOString())}</p>
    <div class="needs ${needs.length ? '' : 'calm'}">
      <div class="needsh">${needs.length ? 'Needs you · ' + needs.length : 'Nothing needs you right now'}</div>
      ${needs.map(n => `<button class="needrow ${n.cls}" ${n.occ ? `data-occ="${n.occ}"` : ''}>
          <span class="dot ${n.cls}"></span><span class="rn">${esc(n.text)}</span>
          ${n.who ? `<span class="rm">${esc(n.who)}</span>` : ''}<span class="chip ${n.cls}">${esc(n.tag)}</span></button>`).join('')}
    </div>
    ${sideTabs(TODAY_TAB, counts)}
    <div class="tside"><div><h2>${esc(sideName(stn))}</h2><p>${esc(sideWhere(stn))}</p></div>
      <p class="tsays">${signed} of ${mine.length} signed${late ? ` · <b class="bad">${late} late</b>` : ''}${toCome ? ' · ' + toCome + ' to come' : ''}</p></div>
    ${anyTime.length ? `<div class="aany"><div class="aanyh">Any time</div>${anyTime.map(e =>
      `<button class="acard ${e.cls}" data-occ="${e.id}"><span class="atitle">${esc(e.title)}</span><span class="chip ${e.chipCls}">${esc(e.chip)}</span></button>`).join('')}</div>` : ''}
    ${mine.length ? railHTML(entries, marks, 'data-occ') : '<div class="empty">Nothing on this side today. The site may be closed.</div>'}
  </div>`;

  m.querySelectorAll('[data-side]').forEach(b => b.onclick = () => { TODAY_TAB = b.dataset.side; viewTodayV2(); });
  m.querySelectorAll('[data-occ]').forEach(b => b.onclick = () => openRecord(b.dataset.occ));

  // live: refresh every minute while Today is open and nothing is on top
  clearInterval(TODAY_TIMER);
  TODAY_TIMER = setInterval(() => {
    if (VIEW !== 'today') return clearInterval(TODAY_TIMER);
    if (!$('drawer').classList.contains('open')) viewTodayV2();
  }, 60000);
}

/* -------------------------------------------------------------- records */

const REC = { side: 'all', range: 'day', date: null, filter: 'all', person: '' };
async function viewRecordsV2() {
  const m = $('main');
  await ensureStations();
  if (!REC.date) REC.date = today();
  const d0 = new Date(REC.date + 'T12:00:00');
  let from = REC.date, to = REC.date, label;
  const ymd = d => d.toLocaleDateString('en-CA');
  if (REC.range === 'week') {
    const dow = (d0.getDay() + 6) % 7; const a = new Date(d0); a.setDate(a.getDate() - dow);
    const b = new Date(a); b.setDate(b.getDate() + 6); from = ymd(a); to = ymd(b);
    label = 'Week of ' + a.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  } else if (REC.range === 'month') {
    const a = new Date(d0.getFullYear(), d0.getMonth(), 1, 12), b = new Date(d0.getFullYear(), d0.getMonth() + 1, 0, 12);
    from = ymd(a); to = ymd(b); label = a.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  } else label = d0.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  m.innerHTML = `<h1>Records</h1><p class="sub">Every signed task, kept for at least twelve months. Loading…</p>`;
  let q = db.from('occurrences').select(`id,due_at,status,service_date,station_id,checks(name,kind),
      records(id,signed_at,was_late,minutes_late,steps_total,steps_done,steps_missed,staff(id,name),readings(passed,skipped),photos(id))`)
    .gte('service_date', from).lte('service_date', to).order('service_date', { ascending: false }).order('due_at');
  if (REC.side !== 'all') q = q.eq('station_id', REC.side);
  const { data: occ, error } = await q;
  if (error) return m.innerHTML = `<h1>Records</h1><div class="empty">${esc(error.message)}</div>`;

  const rows = (occ || []).filter(o => o.checks && o.checks.kind !== 'incident' || (o.records && o.records.length));
  const flags = o => {
    const r = o.records && o.records[0], f = [];
    if (o.status === 'missed') f.push(['fail', 'Missed']);
    if (r && r.was_late) f.push(['warn', r.minutes_late + ' min late']);
    if (r && r.steps_missed) f.push(['warn', r.steps_missed + ' not done']);
    if (r && (r.readings || []).some(x => x.passed === false)) f.push(['fail', 'Failed temperature']);
    return f;
  };
  const people = [...new Map(rows.flatMap(o => (o.records || []).map(r => r.staff)).filter(Boolean).map(s => [s.id, s.name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const shown = rows.filter(o => {
    const r = o.records && o.records[0];
    if (REC.person && !(r && r.staff && r.staff.id === REC.person)) return false;
    if (REC.filter === 'problems') return flags(o).length > 0;
    if (REC.filter === 'temps') return r && (r.readings || []).length > 0;
    if (REC.filter === 'photos') return r && (r.photos || []).length > 0;
    return true;
  });
  const problems = rows.filter(o => flags(o).length).length;
  const signed = rows.filter(o => o.status === 'done').length;

  let html = `<h1>Records</h1>
    <p class="sub">Every signed task, kept for at least twelve months. Tap one to see every line, time, name and photo.</p>
    ${sideTabs(REC.side, null, `<button class="ttab ${REC.side === 'all' ? 'on' : ''}" data-side="all"><b>All sides</b><span>everything</span></button>`)}
    <div class="recbar">
      <div class="opts">${[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([v, l]) =>
        `<button class="opt ${REC.range === v ? 'on' : ''}" data-range="${v}">${l}</button>`).join('')}</div>
      <button class="btn" id="rprev">←</button>
      <input type="date" id="rdate" value="${REC.date}" max="${today()}">
      <button class="btn" id="rnext">→</button>
      <button class="btn" id="rtoday">Today</button>
      <span style="flex:1"></span>
      <button class="btn" id="inspector">Temperature log for inspectors</button>
    </div>
    <div class="recbar">
      <div class="opts">${[['all', 'Everything'], ['problems', 'Problems only'], ['temps', 'Temperatures'], ['photos', 'With photos']].map(([v, l]) =>
        `<button class="opt ${REC.filter === v ? 'on' : ''}" data-filter="${v}">${l}</button>`).join('')}</div>
      <select class="finp sm" id="rperson"><option value="">Anyone</option>${people.map(([id, n]) =>
        `<option value="${id}" ${id === REC.person ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
    </div>
    <p class="tsays">${esc(label)} · ${rows.length} tasks · ${signed} signed${problems ? ` · <b class="bad">${problems} with problems</b>` : ''}</p>`;

  if (!shown.length) html += `<div class="empty">${rows.length ? 'Nothing matches those filters.' : 'Nothing recorded for this period. The site may have been closed.'}</div>`;
  let lastDay = null;
  shown.forEach(o => {
    if (REC.range !== 'day' && o.service_date !== lastDay) {
      lastDay = o.service_date;
      html += `<div class="glab">${new Date(o.service_date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })} <span class="ln"></span></div>`;
    }
    const r = o.records && o.records[0], f = flags(o), stn = STATIONS.find(x => x.id === o.station_id);
    html += `<button class="row ${f.some(x => x[0] === 'fail') ? 'bad' : f.length ? 'warnr' : ''}" data-occ="${o.id}">
      <span class="rt">${o.due_at ? hhmm(o.due_at) : '—'}</span>
      <span class="dot ${o.status === 'done' ? (f.length ? 'warn' : 'pass') : o.status === 'missed' ? 'fail' : ''}"></span>
      ${REC.side === 'all' && stn ? `<span class="station">${esc(sideName(stn))}</span>` : ''}
      <span class="rn">${esc(o.checks.name)}</span>
      <span class="rm">${r ? esc(r.staff?.name || '') + ' · ' + hhmm(r.signed_at) : o.status === 'pending' ? 'not done yet' : ''}</span>
      ${r && (r.photos || []).length ? `<span class="chip grey">📷 ${r.photos.length}</span>` : ''}
      ${f.map(x => `<span class="chip ${x[0]}">${esc(x[1])}</span>`).join('') || (o.status === 'done' ? '<span class="chip pass">Signed</span>' : '')}
    </button>`;
  });
  m.innerHTML = html;

  const go = () => viewRecordsV2();
  m.querySelectorAll('[data-side]').forEach(b => b.onclick = () => { REC.side = b.dataset.side; go(); });
  m.querySelectorAll('[data-range]').forEach(b => b.onclick = () => { REC.range = b.dataset.range; go(); });
  m.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { REC.filter = b.dataset.filter; go(); });
  $('rperson').onchange = e => { REC.person = e.target.value; go(); };
  $('rdate').onchange = e => { REC.date = e.target.value || today(); go(); };
  const step = n => {
    const d = new Date(REC.date + 'T12:00:00');
    if (REC.range === 'week') d.setDate(d.getDate() + 7 * n);
    else if (REC.range === 'month') d.setMonth(d.getMonth() + n);
    else d.setDate(d.getDate() + n);
    const s = d.toLocaleDateString('en-CA'); REC.date = s > today() ? today() : s; go();
  };
  $('rprev').onclick = () => step(-1);
  $('rnext').onclick = () => step(1);
  $('rtoday').onclick = () => { REC.date = today(); go(); };
  $('inspector').onclick = () => viewInspector();
  m.querySelectorAll('[data-occ]').forEach(b => b.onclick = () => openRecord(b.dataset.occ));
}

/* ------------------------------------------------------------ inspector */

const INSP = { from: null, to: null, side: 'all' };
async function viewInspector() {
  const m = $('main');
  await ensureStations();
  if (!INSP.to) { INSP.to = today(); const d = new Date(); d.setDate(d.getDate() - 27); INSP.from = d.toLocaleDateString('en-CA'); }
  m.innerHTML = `<p class="sub">Loading…</p>`;
  const end = new Date(INSP.to + 'T23:59:59');
  const { data, error } = await db.from('readings')
    .select(`value_c,passed,skipped,skip_reason,taken_at,units(name,limit_kind,limit_c,basis),
             corrective_actions(action_taken,food),
             records!inner(signed_at,staff(name),occurrences!inner(service_date,station_id,checks(name)))`)
    .gte('taken_at', new Date(INSP.from + 'T00:00:00').toISOString()).lte('taken_at', end.toISOString())
    .order('taken_at');
  if (error) return m.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  const rows = (data || []).filter(r => INSP.side === 'all' || r.records?.occurrences?.station_id === INSP.side);
  const fails = rows.filter(r => r.passed === false).length;
  const stnName = id => { const s = STATIONS.find(x => x.id === id); return s ? sideName(s) + ' · ' + sideWhere(s) : ''; };

  m.innerHTML = `
    <p class="tcrumb noprint"><button class="linkbtn" id="iback">← Records</button></p>
    <h1>Temperature log</h1>
    <p class="sub">Every temperature recorded, with who took it and what was done about any failure.
      ${INSP.side === 'all' ? 'All sides.' : esc(stnName(INSP.side)) + '.'}
      ${new Date(INSP.from).toLocaleDateString('en-GB')} – ${new Date(INSP.to).toLocaleDateString('en-GB')}.</p>
    <div class="recbar noprint">
      <span class="deg">From</span><input type="date" id="ifrom" value="${INSP.from}" max="${today()}">
      <span class="deg">to</span><input type="date" id="ito" value="${INSP.to}" max="${today()}">
      <select class="finp sm" id="iside"><option value="all">All sides</option>${sides().map(s =>
        `<option value="${s.id}" ${s.id === INSP.side ? 'selected' : ''}>${esc(sideName(s))} · ${esc(sideWhere(s))}</option>`).join('')}</select>
      <span style="flex:1"></span>
      <button class="btn cta" id="iprint">Print / save as PDF</button>
    </div>
    <p class="tsays">${rows.length} readings · ${fails ? `<b class="bad">${fails} out of range, each with its action</b>` : 'none out of range'}</p>
    ${rows.length ? `<table class="itbl"><thead><tr><th>Date</th><th>Time</th><th>Task</th><th>Unit / food</th><th>Reading</th><th>Limit</th><th>Result</th><th>Taken by</th><th>Action taken</th></tr></thead><tbody>${
      rows.map(r => {
        const u = r.units || {}, o = r.records?.occurrences || {}, ca = (r.corrective_actions || [])[0];
        return `<tr class="${r.passed === false ? 'ifail' : ''}">
          <td>${new Date(fixIso(r.taken_at)).toLocaleDateString('en-GB', { timeZone: TZ })}</td>
          <td>${hhmm(r.taken_at)}</td>
          <td>${esc(o.checks?.name || '')}</td>
          <td>${esc(u.name || '')}</td>
          <td><b>${r.skipped ? '—' : esc(r.value_c) + '°C'}</b></td>
          <td>${u.limit_kind === 'min' ? '≥' : '≤'}${esc(u.limit_c)}°C</td>
          <td>${r.skipped ? esc(r.skip_reason || 'Not taken') : r.passed ? 'OK' : '<b>OUT OF RANGE</b>'}</td>
          <td>${esc(r.records?.staff?.name || '')}</td>
          <td>${ca ? esc([ca.food, ca.action_taken].filter(Boolean).join(' — ')) : ''}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">No temperatures recorded in this period.</div>'}`;

  $('iback').onclick = () => viewRecordsV2();
  $('ifrom').onchange = e => { INSP.from = e.target.value; viewInspector(); };
  $('ito').onchange = e => { INSP.to = e.target.value; viewInspector(); };
  $('iside').onchange = e => { INSP.side = e.target.value; viewInspector(); };
  $('iprint').onclick = () => window.print();
}

/* --------------------------------------------------------------- people */

async function viewPeopleV2() {
  const m = $('main');
  m.innerHTML = `<h1>People</h1><p class="sub">Loading…</p>`;
  await ensureStations();
  let { data: staff, error } = await db.from('staff')
    .select('id,name,job_title,email,role,pin_hash,pin_set_at,active,left_on,home_station,works_stations').order('name');
  if (error) return m.innerHTML = `<h1>People</h1><div class="empty">${esc(error.message)}</div>`;
  const { data: last } = await db.from('records').select('signed_by,signed_at').order('signed_at', { ascending: false }).limit(500);
  const lastBy = {}; (last || []).forEach(r => { if (!lastBy[r.signed_by]) lastBy[r.signed_by] = r.signed_at; });

  const live = staff.filter(s => s.active), gone = staff.filter(s => !s.active);
  const ws = s => (s.works_stations && s.works_stations.length ? s.works_stations : [s.home_station]).filter(Boolean);
  const noPin = live.filter(s => !s.pin_hash).length;

  const row = (s, sideId) => {
    const others = ws(s).filter(id => id !== sideId).map(id => STATIONS.find(x => x.id === id)).filter(Boolean);
    return `<button class="row" data-person="${s.id}">
      <span class="rn">${esc(s.name)}${s.role !== 'staff' ? ` <span class="chip grey">${s.role === 'admin' ? 'founder' : s.role}</span>` : ''}</span>
      <span class="rm">${esc(s.job_title || '')}</span>
      ${others.length ? `<span class="rm">also ${others.map(x => esc(sideName(x) + (sideWhere(x).startsWith('Down') ? ' (kitchen)' : ''))).join(', ')}</span>` : ''}
      <span class="rm">${lastBy[s.id] ? 'last signed ' + dayTime(lastBy[s.id]) : 'never signed'}</span>
      <span class="chip ${!s.active ? 'grey' : s.pin_hash ? 'pass' : 'warn'}">${!s.active ? 'Left' + (s.left_on ? ' ' + new Date(s.left_on + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' — tap to bring back' : '') : s.pin_hash ? 'PIN active' : 'No PIN — tap to issue'}</span>
    </button>`;
  };

  let html = `<h1>People</h1>
    <p class="sub">Everyone who signs tasks, by the side they work. A PIN is shown once when it’s issued — nobody can look it up afterwards.</p>
    <div class="bar"><button class="btn cta" id="add">+ Add someone</button></div>
    ${noPin ? `<div class="needs"><div class="needsh">${noPin} ${noPin === 1 ? 'person has' : 'people have'} no PIN yet — they can’t sign anything until they do</div></div>` : ''}`;
  const founders = live.filter(s => s.role !== 'staff');
  if (founders.length) html += `<div class="glab">Founders &amp; managers · ${founders.length} <span class="ln"></span></div>${founders.map(s => row(s, null)).join('')}`;
  sides().forEach(x => {
    const mine = live.filter(s => s.role === 'staff' && ws(s).includes(x.id));
    html += `<div class="glab">${esc(sideName(x))} · ${esc(sideWhere(x))} · ${mine.length} <span class="ln"></span></div>`;
    html += mine.map(s => row(s, x.id)).join('') || `<div class="empty">Nobody set to ${esc(sideName(x))} yet. Open a person and tick where they usually work.</div>`;
  });
  const unset = live.filter(s => s.role === 'staff' && !ws(s).length);
  if (unset.length) html += `<div class="glab">Side not set yet · ${unset.length} <span class="ln"></span></div>${unset.map(s => row(s, null)).join('')}`;
  if (gone.length) html += `<div class="glab">Left · ${gone.length} <span class="ln"></span></div>${gone.map(s => row(s, null)).join('')}`;
  m.innerHTML = html;
  $('add').onclick = () => personPanel(null);
  m.querySelectorAll('[data-person]').forEach(b => b.onclick = () => personPanel(staff.find(x => x.id === b.dataset.person)));
}

// the People page everywhere (personPanel returns here after a save)
function viewPeople() { return viewPeopleV2(); }
