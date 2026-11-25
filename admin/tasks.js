/* ================================================================ tasks
   The back office's editor, rebuilt to be simple to run day to day.

   - The Tasks list reads like the day: each side, in time order.
   - A task opens the way staff see it — readable lines, not a form.
   - You change ONE thing at a time, in a panel where every box is named.
   - Nothing is saved until "Save changes"; saving publishes a new
     version, so records already signed keep the wording they had.

   The old editor (builder / viewChecks in admin.js) is untouched and
   reachable from a link at the bottom of every task.
   ================================================================ */

let T = null;          // the task open on screen
let TASKS_CACHE = [];  // the list, for the paper backup

const BASES = ['Chilled storage', 'Frozen storage', 'Cold holding', 'Hot holding', 'Cooking', 'Delivery', 'Cooling'];
const WHEN_PATTERNS = {
  once_daily:    'Once a day, in a time window',
  set_times:     'At set times of day',
  every_n_hours: 'Every few hours',
  on_demand:     'Any time — whenever it happens'
};
const t5 = t => (t || '').slice(0, 5);
const toMins = t => { const [h, m] = t5(t).split(':').map(Number); return h * 60 + m; };
const fromMins = n => String(Math.floor(((n % 1440) + 1440) % 1440 / 60)).padStart(2, '0') + ':' + String(((n % 60) + 60) % 60).padStart(2, '0');
const clone = o => JSON.parse(JSON.stringify(o));

/* The sides of the shop, Guides first — that is where the work is now.
   "Guides — Counter" reads as Guides, upstairs in the service area. */
function sideName(stn) { return (stn.name || '').split(' — ')[0]; }
function sideWhere(stn) {
  const a = (stn.areas && stn.areas.name || '').toLowerCase();
  if (a.startsWith('service')) return 'Upstairs · service area';
  if (a.startsWith('kitchen')) return 'Downstairs · kitchen';
  return stn.areas ? stn.areas.name : '';
}
function sides() {
  // Guides, then Makers upstairs, then Makers downstairs in the kitchen
  const rank = s => /^guides/i.test(s.name) ? 0 : (s.areas && /kitchen/i.test(s.areas.name)) ? 2 : 1;
  return STATIONS.slice().sort((a, b) => rank(a) - rank(b) || a.sort - b.sort);
}
let TAB = null;
try { TAB = localStorage.getItem('tasks-tab'); } catch {}

function daysWords(days) {
  const d = (days || []).slice().sort();
  if (d.join() === '1,2,3,4,5,6,7') return 'every day';
  if (d.join() === '1,2,3,4,5') return 'Mon–Fri';
  if (d.length === 1) return DAYS[d[0] - 1] + 's';
  return d.map(n => DAYS[n - 1]).join(', ');
}

/* ------------------------------------------------------------ the list */

async function viewTasks() {
  const m = $('main');
  m.innerHTML = `<h1>Tasks</h1><p class="sub">Loading…</p>`;
  await doorsOpen();
  await ensureStations();
  const { data: checks, error } = await db.from('checks')
    .select(`id,kind,name,est_minutes,archived_at,station_id,
             check_versions(id,version_no,status),
             schedules(pattern,window_start,window_end,times,interval_hours,days,active,lead_minutes,alert_after)`)
    .is('archived_at', null);
  if (error) return m.innerHTML = `<h1>Tasks</h1><div class="empty">${esc(error.message)}</div>`;
  TASKS_CACHE = checks || [];

  // how big each task is, from its live version
  const live = c => (c.check_versions || []).find(v => v.status === 'live');
  const ids = TASKS_CACHE.map(c => live(c)?.id).filter(Boolean);
  const [st, un, ci] = ids.length ? await Promise.all([
    db.from('steps').select('check_version_id,est_minutes').in('check_version_id', ids),
    db.from('units').select('check_version_id,step_id').in('check_version_id', ids),
    db.from('count_items').select('check_version_id,step_id').in('check_version_id', ids)
  ]) : [{ data: [] }, { data: [] }, { data: [] }];
  const of = (arr, vid) => (arr.data || []).filter(x => x.check_version_id === vid);

  const summary = c => {
    const v = live(c); if (!v) return 'not published';
    if (c.kind === 'checklist') {
      const s = of(st, v.id);
      const mins = s.reduce((a, x) => a + (x.est_minutes || 0), 0) || c.est_minutes || 0;
      return `${s.length} line${s.length === 1 ? '' : 's'}${mins ? ' · ' + mins + ' min' : ''}`;
    }
    if (c.kind === 'temperature') { const n = of(un, v.id).length; return `${n} reading${n === 1 ? '' : 's'}`; }
    if (c.kind === 'count') { const n = of(ci, v.id).length; return `${n} item${n === 1 ? '' : 's'} to count`; }
    if (c.kind === 'incident') return 'reported when something happens';
    return 'always on screen';
  };
  const when = c => {
    const s = (c.schedules || [])[0];
    if (c.kind === 'reminder') return { key: 9998, label: 'Always' };
    if (!s || s.pattern === 'on_demand') return { key: 9999, label: 'Any time' };
    if (s.pattern === 'set_times') {
      const ts = (s.times || []).map(t5).sort();
      return { key: ts.length ? toMins(ts[0]) : 9990,
               label: ts.length > 3 ? `${ts[0]} + ${ts.length - 1} more` : ts.join(' · ') };
    }
    if (s.pattern === 'every_n_hours') return { key: toMins(s.window_start), label: `every ${s.interval_hours}h from ${t5(s.window_start)}` };
    return { key: toMins(s.window_start || s.window_end), label: s.window_start ? `${t5(s.window_start)}–${t5(s.window_end)}` : `by ${t5(s.window_end)}` };
  };

  const S = sides();
  if (!S.some(x => x.id === TAB)) TAB = S[0]?.id;
  const stn = S.find(x => x.id === TAB);

  let html = `<h1>Tasks</h1>
    <p class="sub">What each iPad shows, in time order. Pick a side, then open a task to see it as staff do.</p>
    <div class="ttabs">${S.map(x => {
      const n = TASKS_CACHE.filter(c => c.station_id === x.id).length;
      return `<button class="ttab ${x.id === TAB ? 'on' : ''}" data-tab="${x.id}">
        <b>${esc(sideName(x))}</b><span>${esc(sideWhere(x))} · ${n} task${n === 1 ? '' : 's'}</span></button>`;
    }).join('')}</div>`;

  {
    const mine = TASKS_CACHE.filter(c => c.station_id === stn.id)
      .map(c => ({ c, w: when(c) })).sort((a, b) => a.w.key - b.w.key || a.c.name.localeCompare(b.c.name));
    html += `<div class="tside">
        <div><h2>${esc(sideName(stn))}</h2><p>${esc(sideWhere(stn))}</p></div>
        <div class="bar" style="margin:0">
          <button class="btn cta" id="newtask">+ New ${esc(sideName(stn))} task</button>
          <button class="btn" id="paper">Print paper backup</button>
        </div>
      </div>`;
    if (!mine.length) html += `<div class="empty">No tasks for ${esc(sideName(stn))} yet. Press “+ New ${esc(sideName(stn))} task”.</div>`;
    else {
      const entries = [], anyTime = [];
      mine.forEach(({ c }) => {
        const s = (c.schedules || [])[0];
        const tags = [];
        if (s && !s.active) tags.push('Switched off');
        if (s && s.pattern !== 'on_demand' && c.kind !== 'reminder' && daysWords(s.days) !== 'Mon–Fri') tags.push(daysWords(s.days));
        const base = { id: c.id, title: c.name, sub: summary(c), chip: tags.join(' · '), chipCls: s && !s.active ? 'warn' : 'grey' };
        if (!s || s.pattern === 'on_demand' || c.kind === 'reminder') return anyTime.push(base);
        // each at its START, with when it must be done by — like the iPad
        if (s.pattern === 'set_times') (s.times || []).map(t5).sort().forEach(t => {
          const st = toMins(t) - (s.lead_minutes ?? 30);
          entries.push({ ...base, t: st, end: toMins(t), time: fromMins(st), sub: summary(c) + ' · done by ' + t });
        });
        else entries.push({ ...base, t: toMins(s.window_start || s.window_end), end: toMins(s.window_end),
          time: t5(s.window_start || s.window_end), sub: summary(c) + (s.window_end ? ' · done by ' + t5(s.window_end) : '') });
      });
      if (anyTime.length) html += `<div class="aany"><div class="aanyh">Any time</div>${anyTime.map(e =>
        `<button class="acard" data-task="${e.id}"><span class="atitle">${esc(e.title)}</span><span class="asub">${esc(e.sub)}</span></button>`).join('')}</div>`;
      html += railHTML(entries, DOORS ? [{ t: toMins(DOORS), label: 'Doors open ' + DOORS, cls: 'doors' }] : [], 'data-task');
    }
  }
  html += `<p class="sub" style="margin-top:26px"><button class="linkbtn" id="oldlist">Open the old editor</button></p>`;
  m.innerHTML = html;
  $('newtask').onclick = () => newTaskWizard(TAB);
  m.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    TAB = b.dataset.tab; try { localStorage.setItem('tasks-tab', TAB); } catch {} viewTasks();
  });
  $('paper').onclick = () => printPaperBackup(TASKS_CACHE);
  $('oldlist').onclick = () => viewChecks();
  m.querySelectorAll('[data-task]').forEach(b => b.onclick = () => openTask(b.dataset.task));
}

/* ------------------------------------------------------------- loading */

async function openTask(id) {
  const m = $('main');
  m.innerHTML = `<p class="sub">Loading…</p>`;
  const { data: c, error } = await db.from('checks')
    .select('*,check_versions(id,version_no,status),schedules(*)').eq('id', id).single();
  if (error) return m.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  const live = (c.check_versions || []).sort((a, b) => b.version_no - a.version_no)[0];
  T = { id: c.id, kind: c.kind, name: c.name, station_id: c.station_id, intro: c.intro || '',
        est: c.est_minutes || '', versionNo: live ? live.version_no : 0, versionId: live ? live.id : null,
        sched: blankSched(), items: [], dirty: false, isNew: false };
  if (c.schedules && c.schedules[0]) T.sched = { ...T.sched, ...c.schedules[0] };
  if (T.versionId && T.kind !== 'incident' && T.kind !== 'reminder') {
    const tbl = T.kind === 'temperature' ? 'units' : T.kind === 'count' ? 'count_items' : 'steps';
    const { data: items } = await db.from(tbl).select('*').eq('check_version_id', T.versionId).order('sort');
    T.items = (items || []).filter(x => T.kind === 'checklist' || !x.step_id).map(x => ({ ...x }));
    if (T.kind === 'checklist') {
      const [{ data: un }, { data: cn }] = await Promise.all([
        db.from('units').select('*').eq('check_version_id', T.versionId).order('sort'),
        db.from('count_items').select('*').eq('check_version_id', T.versionId).order('sort')
      ]);
      T.items.forEach(it => {
        it.temps = (un || []).filter(u => u.step_id === it.id).map(u => ({
          name: u.name, limit_kind: u.limit_kind, limit_c: u.limit_c, basis: u.basis,
          guidance: u.guidance, guidance_image: u.guidance_image }));
        it.nums = (cn || []).filter(u => u.step_id === it.id).map(u => ({
          name: u.name, unit_label: u.unit_label, group_name: u.group_name, report: u.report,
          guidance: u.guidance, guidance_image: u.guidance_image }));
      });
    }
  }
  drawTask();
}

function blankSched() {
  return { pattern: 'once_daily', days: [1,2,3,4,5], window_start: '10:00', window_end: '11:00',
           times: ['12:00'], interval_hours: 2, lead_minutes: 30, alert_after: 30, active: true };
}

/* NEW TASK — one question per screen, in plain words. The side is the
   tab you were on. It is saved at the end in one go. */
function newTaskWizard(sideId) {
  const W = { step: 1, name: '', station_id: sideId || sides()[0]?.id, kind: null, sched: blankSched(), items: [], more: false };
  const dr = $('drawer'), p = $('dpanel');
  dr.classList.add('open');
  const stnOf = () => STATIONS.find(x => x.id === W.station_id) || {};
  const steps = () => W.kind === 'reminder' ? [1, 2, 5] : W.kind === 'incident' ? [1, 2, 5] : [1, 2, 3, 4, 5];
  const KIND_WORDS = {
    checklist:   ['Tick off a list of jobs', 'e.g. Opening, Closing, a toilet check'],
    temperature: ['Take temperatures', 'e.g. fridges, hot food, deliveries'],
    count:       ['Count things', 'e.g. packaging, stock'],
    incident:    ['Report a problem', 'a form for when something goes wrong'],
    reminder:    ['A reminder on screen', 'always shown, never signed']
  };

  const draw = () => {
    const list = steps(), at = list.indexOf(W.step) + 1;
    let title = '', body = '';
    if (W.step === 1) {
      title = 'What’s the task called?';
      body = field('Name', `<input class="finp" id="z_name" value="${esc(W.name)}" placeholder="e.g. Mid-afternoon toilet check" autofocus>`) +
        field('Which side does it?', `<div class="opts">${sides().map(x =>
          `<button class="opt ${x.id === W.station_id ? 'on' : ''}" data-side="${x.id}">${esc(sideName(x))} <small>· ${esc(sideWhere(x))}</small></button>`).join('')}</div>`);
    }
    if (W.step === 2) {
      title = 'What do staff do?';
      const main = ['checklist', 'temperature', 'count'], extra = ['incident', 'reminder'];
      const card = k => `<button class="zcard ${W.kind === k ? 'on' : ''}" data-kind="${k}"><b>${KIND_WORDS[k][0]}</b><span>${KIND_WORDS[k][1]}</span></button>`;
      body = main.map(card).join('') +
        (W.more || extra.includes(W.kind) ? extra.map(card).join('') : `<button class="linkbtn" id="z_more">Something else…</button>`);
    }
    if (W.step === 3) {
      title = 'When?';
      const S = W.sched;
      body = field('', `<div class="opts">
          <button class="opt ${S.pattern === 'once_daily' ? 'on' : ''}" data-pat="once_daily">Once a day</button>
          <button class="opt ${S.pattern === 'set_times' ? 'on' : ''}" data-pat="set_times">At set times</button>
          <button class="opt ${S.pattern === 'on_demand' ? 'on' : ''}" data-pat="on_demand">Whenever needed</button></div>`);
      if (S.pattern === 'once_daily') body +=
        field('Opens', `<input class="finp sm" type="time" id="z_start" value="${t5(S.window_start)}">`, 'Staff can start it from this time.') +
        field('Due', `<input class="finp sm" type="time" id="z_end" value="${t5(S.window_end)}">`);
      if (S.pattern === 'set_times') body += field('Times', `${S.times.map((t, j) => `<div class="inline" style="margin-bottom:6px">
          <input class="finp sm" type="time" data-time="${j}" value="${t5(t)}">
          <button class="tbtn del" data-tdel="${j}" ${S.times.length < 2 ? 'disabled' : ''}>✕</button></div>`).join('')}
          <button class="btn" id="z_addtime">+ Add a time</button>`, 'Each one opens 30 minutes before its time.');
      if (S.pattern !== 'on_demand') body += field('Which days', `<div class="opts">${DAYS.map((d, n) =>
          `<button class="opt ${(S.days || []).includes(n + 1) ? 'on' : ''}" data-day="${n + 1}">${d}</button>`).join('')}</div>`);
    }
    if (W.step === 4) {
      title = W.kind === 'checklist' ? 'What are the jobs?' : W.kind === 'temperature' ? 'What gets a temperature?' : 'What gets counted?';
      const rows = W.items.map((it, j) => `<div class="zitem"><span class="tnum">${j + 1}</span><span class="zname">${esc(it.text || it.name)}</span>
          <span class="rm">${W.kind === 'checklist' ? (it.est_minutes ? it.est_minutes + ' min' : '') : W.kind === 'temperature'
            ? (it.limit_kind === 'min' ? '≥' : '≤') + it.limit_c + '°C' : esc(it.unit_label || '')}</span>
          <button class="tbtn del" data-idel="${j}">✕</button></div>`).join('');
      const adder = W.kind === 'checklist'
        ? `<input class="finp" id="z_a1" placeholder="A job, as you’d say it to a new starter"><input class="finp sm" id="z_a2" type="number" min="0" placeholder="min" style="width:80px">`
        : W.kind === 'temperature'
        ? `<input class="finp" id="z_a1" placeholder="e.g. Drinks fridge"><select class="finp sm" id="z_a3"><option value="max">no more than</option><option value="min">at least</option></select><input class="finp sm" id="z_a2" type="number" step="0.1" value="8" style="width:80px"><span class="deg">°C</span>`
        : `<input class="finp" id="z_a1" placeholder="e.g. Bowls"><input class="finp sm" id="z_a2" placeholder="container" style="width:120px">`;
      body = (rows || `<p class="fhint">Nothing yet. Type the first one below and press Enter.</p>`) +
        `<div class="zadd">${adder}<button class="btn cta" id="z_add">Add</button></div>
         <p class="fhint">Press Enter to add, and the next one is ready to type. You can add photos and how-to afterwards.</p>`;
    }
    if (W.step === 5) {
      title = 'Check and create';
      const S = W.sched;
      body = `<div class="tcard"><div class="kv">
          <span>Name</span><b>${esc(W.name)}</b>
          <span>Side</span><b>${esc(sideName(stnOf()))} · ${esc(sideWhere(stnOf()))}</b>
          <span>What staff do</span><b>${esc(KIND_WORDS[W.kind][0])}</b>
          ${W.kind !== 'reminder' ? `<span>When</span><b>${esc(whenSentence(S, W.kind))}</b>` : ''}
          ${['checklist','temperature','count'].includes(W.kind) ? `<span>${W.items.length} ${W.kind === 'checklist' ? 'job' : 'item'}${W.items.length === 1 ? '' : 's'}</span>
            <b>${W.items.map(it => esc(it.text || it.name)).join('<br>')}</b>` : ''}
        </div></div><p class="fhint">After it’s created you can add photos, how-to and anything else on the task page.</p>`;
    }

    p.innerHTML = `<div class="dhead"><button class="btn" id="z_cancel">← Cancel</button>
        <p class="dmeta" style="margin-top:12px">New task · step ${at} of ${list.length}</p>
        <div class="dtitle">${esc(title)}</div></div>
      <div class="dbody">${body}</div>
      <div class="dfoot zfoot">
        ${at > 1 ? '<button class="btn" id="z_back">Back</button>' : '<span></span>'}
        <button class="btn cta" id="z_next">${W.step === 5 ? 'Create task' : 'Next'}</button></div>`;

    const g = id => p.querySelector('#' + id);
    const collect = () => {
      if (g('z_name')) W.name = g('z_name').value;
      if (g('z_start')) W.sched.window_start = g('z_start').value;
      if (g('z_end')) W.sched.window_end = g('z_end').value;
      p.querySelectorAll('[data-time]').forEach(el => { W.sched.times[+el.dataset.time] = el.value; });
    };
    const addItem = () => {
      const a = g('z_a1').value.trim(); if (!a) return g('z_a1').focus();
      if (W.kind === 'checklist') W.items.push({ text: a, est_minutes: g('z_a2').value === '' ? null : +g('z_a2').value,
        photo_required: false, guidance: null, guidance_image: null, alt_label: null, temps: [], nums: [] });
      else if (W.kind === 'temperature') W.items.push({ name: a, limit_kind: g('z_a3').value, limit_c: parseFloat(g('z_a2').value),
        basis: g('z_a3').value === 'min' ? 'Hot holding' : 'Chilled storage', guidance: null, guidance_image: null });
      else W.items.push({ name: a, unit_label: g('z_a2').value.trim() || null, reorder_level: null, guidance: null, guidance_image: null });
      draw(); setTimeout(() => g('z_a1') && g('z_a1').focus(), 0);
    };

    g('z_cancel').onclick = () => dr.classList.remove('open');
    if (g('z_back')) g('z_back').onclick = () => { collect(); W.step = list[at - 2]; draw(); };
    p.querySelectorAll('[data-side]').forEach(b => b.onclick = () => { collect(); W.station_id = b.dataset.side; draw(); });
    p.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
      W.kind = b.dataset.kind;
      W.sched.pattern = W.kind === 'incident' ? 'on_demand' : W.kind === 'temperature' ? 'set_times' : 'once_daily';
      W.items = []; draw();
    });
    if (g('z_more')) g('z_more').onclick = () => { W.more = true; draw(); };
    p.querySelectorAll('[data-pat]').forEach(b => b.onclick = () => { collect(); W.sched.pattern = b.dataset.pat; draw(); });
    p.querySelectorAll('[data-day]').forEach(b => b.onclick = () => {
      collect(); const n = +b.dataset.day, d = W.sched.days || [];
      W.sched.days = d.includes(n) ? d.filter(x => x !== n) : [...d, n].sort(); draw();
    });
    if (g('z_addtime')) g('z_addtime').onclick = () => { collect(); W.sched.times.push('12:00'); draw(); };
    p.querySelectorAll('[data-tdel]').forEach(b => b.onclick = () => { collect(); W.sched.times.splice(+b.dataset.tdel, 1); draw(); });
    p.querySelectorAll('[data-idel]').forEach(b => b.onclick = () => { W.items.splice(+b.dataset.idel, 1); draw(); });
    if (g('z_add')) g('z_add').onclick = addItem;
    ['z_a1', 'z_a2'].forEach(id => { if (g(id)) g(id).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }; });
    if (g('z_name')) g('z_name').onkeydown = e => { if (e.key === 'Enter') g('z_next').click(); };

    g('z_next').onclick = async () => {
      collect();
      if (W.step === 1 && !W.name.trim()) return alert('Give the task a name.');
      if (W.step === 2 && !W.kind) return alert('Pick what staff do.');
      if (W.step === 3 && W.sched.pattern !== 'on_demand') {
        if (!(W.sched.days || []).length) return alert('Pick at least one day.');
        if (W.sched.pattern === 'once_daily' && toMins(W.sched.window_end) <= toMins(W.sched.window_start))
          return alert('“Due” has to be after “Opens”.');
      }
      if (W.step === 4 && !W.items.length) return alert('Add at least one.');
      if (W.step < 5) { W.step = list[at]; return draw(); }
      // create it
      T = { id: null, kind: W.kind, name: W.name.trim(), station_id: W.station_id, intro: '', est: '',
            versionNo: 0, versionId: null, sched: W.sched, items: W.items, dirty: true, isNew: true };
      dr.classList.remove('open');
      await saveTask(g('z_next'));
    };
    if (g('z_name')) setTimeout(() => g('z_name').focus(), 0);
  };
  draw();
}

function newTask() {
  const dr = $('drawer'), p = $('dpanel');
  dr.classList.add('open');
  p.innerHTML = `<div class="dhead"><button class="btn" id="close">← Cancel</button>
      <div class="dtitle">What kind of task?</div>
      <p class="dmeta">You can change everything else afterwards.</p></div>
    <div class="dbody">${Object.entries(KINDS).map(([k, v]) =>
      `<button class="row" data-kind="${k}" style="height:auto;padding:16px;align-items:flex-start;flex-direction:column;gap:5px">
        <span class="rn" style="font-size:17px;font-weight:600">${v.label}</span>
        <span class="rm" style="white-space:normal;text-align:left">${v.blurb}</span>
        <span class="rm" style="color:#9a9691">${v.eg}</span></button>`).join('')}</div>`;
  $('close').onclick = () => dr.classList.remove('open');
  p.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
    dr.classList.remove('open');
    T = { id: null, kind: b.dataset.kind, name: '', station_id: STATIONS[0]?.id, intro: '', est: '',
          versionNo: 0, versionId: null, sched: blankSched(), items: [], dirty: true, isNew: true };
    if (T.kind === 'incident') T.sched.pattern = 'on_demand';
    drawTask();
    editDetails();
  });
}

/* ------------------------------------------------------- the task page */

function whenSentence(s, kind) {
  if (kind === 'reminder') return 'Always on screen. Never signed, never overdue.';
  if (!s || s.pattern === 'on_demand') return 'Any time — whenever it happens. Never overdue.';
  const off = s.active === false ? 'Switched off — nothing goes on the board. ' : '';
  const d = daysWords(s.days);
  const alert = s.alert_after ?? 30;
  if (s.pattern === 'set_times') {
    const ts = (s.times || []).map(t5).sort().join(' · ');
    return `${off}At ${ts} · ${d}. Each opens ${s.lead_minutes ?? 30} min before its time. Manager alerted if one is ${alert} min late.`;
  }
  if (s.pattern === 'every_n_hours')
    return `${off}Every ${s.interval_hours} hours from ${t5(s.window_start)} to ${t5(s.window_end)} · ${d}. Manager alerted if one is ${alert} min late.`;
  return `${off}Opens ${t5(s.window_start)} · Due ${t5(s.window_end)} · ${d}. Manager alerted at ${fromMins(toMins(s.window_end) + alert)} if it isn't done.`;
}

function lineCount() {
  if (T.kind === 'checklist') return 'Lines';
  if (T.kind === 'temperature') return 'Readings';
  if (T.kind === 'count') return 'Items to count';
  return '';
}

function drawTask() {
  const m = $('main');
  const stn = STATIONS.find(s => s.id === T.station_id);
  const k = T.kind;
  const hasItems = k !== 'incident' && k !== 'reminder';
  const mins = k === 'checklist' ? T.items.reduce((a, x) => a + (+x.est_minutes || 0), 0) : 0;

  let lines = '';
  T.items.forEach((it, i) => {
    let body = '', meta = [];
    if (k === 'checklist') {
      body = `<div class="ttext">${esc(it.text || '(no wording yet)')}</div>`;
      if (it.est_minutes) meta.push(it.est_minutes + ' min');
      if (it.photo_required) meta.push('📷 Photo needed');
      if (it.alt_label) meta.push('Other answer: “' + esc(it.alt_label) + '”');
      if (it.guidance || it.guidance_image) body += `<div class="thow"><b>?</b> ${esc(it.guidance || '')}${it.guidance_image ? ' <span class="chip grey">+ picture</span>' : ''}</div>`;
      if ((it.temps || []).length) body += `<div class="tattach"><div class="tattl">${it.temps.length} temperature${it.temps.length === 1 ? '' : 's'} to read</div>${
        it.temps.map(t => `<span class="titem">${esc(t.name)} <small>${t.limit_kind === 'min' ? '≥' : '≤'}${t.limit_c}°C</small></span>`).join('')}</div>`;
      if ((it.nums || []).length) {
        const sends = it.nums.some(n => n.report === 'prep_list');
        let g = '', last = null;
        it.nums.forEach(n => {
          if ((n.group_name || '') !== last) { last = n.group_name || ''; g += `${g ? '</div>' : ''}<div class="tgrp">${last ? `<span class="tgrpl">${esc(last)}</span>` : ''}`; }
          g += `<span class="titem">${esc(n.name)}${n.unit_label ? ` <small>${esc(n.unit_label)}</small>` : ''}</span>`;
        });
        body += `<div class="tattach"><div class="tattl">${it.nums.length} to record${sends ? ' · sent to the makers on Telegram' : ''}</div>${g}</div></div>`;
      }
    } else if (k === 'temperature') {
      body = `<div class="ttext">${esc(it.name || '(no name yet)')}</div>`;
      meta.push(`${it.limit_kind === 'min' ? 'at least' : 'no more than'} ${it.limit_c}°C`);
      if (it.basis) meta.push(esc(it.basis));
      if (it.guidance) body += `<div class="thow"><b>?</b> ${esc(it.guidance)}</div>`;
    } else if (k === 'count') {
      body = `<div class="ttext">${esc(it.name || '(no name yet)')}</div>`;
      if (it.unit_label) meta.push(esc(it.unit_label));
      if (it.reorder_level != null) meta.push('re-order below ' + it.reorder_level);
      if (it.guidance) body += `<div class="thow"><b>?</b> ${esc(it.guidance)}</div>`;
    }
    lines += `<div class="tline">
        <span class="tnum">${i + 1}</span>
        <div class="tbody">${(() => {
          // the minutes and badges sit right under the wording, before the how-to
          const m = meta.length ? `<div class="tmeta">${meta.join(' · ')}</div>` : '';
          const cut = body.indexOf('</div>') + 6;
          return body.slice(0, cut) + m + body.slice(cut);
        })()}</div>
        <div class="tacts">
          <button class="tbtn" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button class="tbtn" data-down="${i}" ${i === T.items.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button class="btn" data-editline="${i}">Edit</button>
          <button class="tbtn del" data-delline="${i}" title="Remove">✕</button>
        </div>
      </div>`;
  });

  m.innerHTML = `
    <p class="tcrumb"><button class="linkbtn" id="back">← All tasks</button></p>
    <h1>${esc(T.name || 'New task')}</h1>
    <p class="sub">${esc(stn ? stn.name : '')} · ${esc(KINDS[k] ? KINDS[k].label : k)}${
      T.isNew ? ' · not saved yet' : ' · live version ' + T.versionNo}</p>

    <div class="tcard">
      <div class="tcardh"><span>When</span><button class="btn" id="editwhen">Change</button></div>
      <p class="twhen">${esc(whenSentence(T.sched, k))}</p>
    </div>

    <div class="tcard">
      <div class="tcardh"><span>Details</span><button class="btn" id="editdetails">Change</button></div>
      <div class="kv">
        <span>Name</span><b>${esc(T.name || '—')}</b>
        <span>Side</span><b>${esc(stn ? stn.name : '—')}</b>
        <span>Shown at the top on the iPad</span><b>${esc(T.intro || '—')}</b>
        ${k !== 'checklist' ? `<span>Roughly how long</span><b>${T.est ? esc(T.est) + ' min' : '—'}</b>` : ''}
      </div>
    </div>

    ${hasItems ? `<div class="glab">${lineCount()} · ${T.items.length}${mins ? ' · ' + mins + ' min' : ''} <span class="ln"></span></div>
      ${lines || '<div class="empty">Nothing here yet — add the first one below.</div>'}
      ${k === 'checklist' ? `<div class="zadd tquick">
          <input class="finp" id="q_text" placeholder="Add a job — type it and press Enter">
          <input class="finp sm" id="q_min" type="number" min="0" placeholder="min" style="width:80px">
          <button class="btn cta" id="q_add">Add</button></div>
        <p class="fhint">For photos, how-to or anything else, press Edit on the line. <button class="linkbtn" id="addline">More options</button></p>`
      : `<button class="btn" id="addline" style="margin-top:6px">+ Add ${k === 'temperature' ? 'a reading' : 'an item'}</button>`}` : ''}

    <div class="tfoot">
      ${T.isNew ? '' : '<button class="linkbtn" id="archive">Archive this task</button> · '}
      ${T.isNew ? '' : '<button class="linkbtn" id="oldeditor">Open in the old editor</button>'}
    </div>

    <div class="savebar ${T.dirty ? 'show' : ''}">
      <span>${T.isNew ? 'This task is not saved yet.' : 'You have unsaved changes.'}
        <small>Staff see them as soon as you save. Records already signed keep their wording.</small></span>
      <button class="btn" id="discard">Discard</button>
      <button class="btn cta" id="savetask">${T.isNew ? 'Save task' : 'Save changes'}</button>
    </div>`;

  $('back').onclick = () => leaveTask(viewTasks);
  $('editwhen').onclick = editWhen;
  $('editdetails').onclick = editDetails;
  if ($('addline')) $('addline').onclick = () => editLine(-1);
  const quick = () => {
    const t = $('q_text').value.trim(); if (!t) return $('q_text').focus();
    T.items.push({ text: t, est_minutes: $('q_min').value === '' ? null : +$('q_min').value,
      photo_required: false, guidance: null, guidance_image: null, alt_label: null, temps: [], nums: [] });
    T.dirty = true; drawTask(); setTimeout(() => $('q_text') && $('q_text').focus(), 0);
  };
  if ($('q_add')) {
    $('q_add').onclick = quick;
    ['q_text', 'q_min'].forEach(id => $(id).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); quick(); } });
  }
  if ($('archive')) $('archive').onclick = archiveTask;
  if ($('oldeditor')) $('oldeditor').onclick = () => leaveTask(() => builder(T.id));
  $('discard').onclick = () => { if (confirm('Throw away your changes?')) { T.isNew ? viewTasks() : openTask(T.id); } };
  $('savetask').onclick = () => saveTask();
  m.querySelectorAll('[data-up]').forEach(b => b.onclick = () => moveLine(+b.dataset.up, -1));
  m.querySelectorAll('[data-down]').forEach(b => b.onclick = () => moveLine(+b.dataset.down, 1));
  m.querySelectorAll('[data-editline]').forEach(b => b.onclick = () => editLine(+b.dataset.editline));
  m.querySelectorAll('[data-delline]').forEach(b => b.onclick = () => {
    const it = T.items[+b.dataset.delline];
    if (!confirm(`Remove “${it.text || it.name || 'this line'}”?`)) return;
    T.items.splice(+b.dataset.delline, 1); T.dirty = true; drawTask();
  });
}

function moveLine(i, by) {
  const j = i + by;
  if (j < 0 || j >= T.items.length) return;
  [T.items[i], T.items[j]] = [T.items[j], T.items[i]];
  T.dirty = true; drawTask();
}

// never lose unsaved work by clicking away
function leaveTask(go) {
  if (T && T.dirty && !confirm('You have unsaved changes. Leave without saving?')) return;
  T = null; go();
}

/* ------------------------------------------------------- edit one line */

function panel(title, sub, body, onDone) {
  const dr = $('drawer'), p = $('dpanel');
  dr.classList.add('open');
  p.innerHTML = `<div class="dhead"><button class="btn" id="pclose">← Cancel</button>
      <div class="dtitle">${esc(title)}</div><p class="dmeta">${esc(sub || '')}</p></div>
    <div class="dbody" id="pbody">${body}</div>
    <div class="dfoot"><button class="btn cta" id="pdone">Done</button></div>`;
  $('pclose').onclick = () => dr.classList.remove('open');
  $('pdone').onclick = () => { if (onDone() !== false) { dr.classList.remove('open'); T.dirty = true; drawTask(); } };
  return p;
}

function field(label, html, hint) {
  return `<div class="ask"><span class="asklab">${label}</span>${html}${hint ? `<p class="fhint">${hint}</p>` : ''}</div>`;
}

function editLine(i) {
  const k = T.kind;
  const isNew = i < 0;
  const D = isNew
    ? (k === 'checklist' ? { text: '', est_minutes: null, guidance: '', guidance_image: null, photo_required: false, alt_label: '', temps: [], nums: [] }
      : k === 'temperature' ? { name: '', limit_kind: 'max', limit_c: 8, basis: 'Chilled storage', guidance: '', guidance_image: null }
      : { name: '', reorder_level: null, unit_label: '', guidance: '', guidance_image: null })
    : clone(T.items[i]);

  const draw = () => {
    let body = '';
    if (k === 'checklist') {
      body += field('What staff see', `<input class="finp" id="f_text" value="${esc(D.text)}" placeholder="Say it as you would to a new starter">`);
      body += field('How long (minutes)', `<input class="finp sm" id="f_min" type="number" min="0" value="${esc(D.est_minutes ?? '')}">`);
      body += field('How-to, shown behind the ?', `<textarea class="finp ta" id="f_how">${esc(D.guidance || '')}</textarea>`, 'Optional. Exactly how to do it, in plain words.');
      body += field('How-to picture', D.guidance_image
        ? `<div class="imgrow"><img src="${esc(D.guidance_image)}" alt=""><button class="btn" id="f_imgdel">Remove picture</button></div>`
        : `<button class="btn" id="f_img">+ Add a picture of it done right</button>`);
      body += field('Photo needed when it’s done?', `<div class="opts">
          <button class="opt ${D.photo_required ? 'on' : ''}" data-photo="1">Yes — a photo is required</button>
          <button class="opt ${D.photo_required ? '' : 'on'}" data-photo="0">No</button></div>`);
      body += field('Other answer that also completes it', `<input class="finp" id="f_alt" value="${esc(D.alt_label || '')}" placeholder="e.g. No delivery today">`, 'Optional. Shown as a second button.');

      // temperatures on this line
      body += `<div class="glab">Temperatures to read on this line <span class="ln"></span></div>`;
      body += (D.temps || []).length ? `<table class="ftbl"><tr><th>Unit</th><th>Must be</th><th>°C</th><th>Type</th><th></th></tr>${
        D.temps.map((t, j) => `<tr>
          <td><input class="finp" data-t="${j}" data-tf="name" value="${esc(t.name)}" placeholder="e.g. Drinks fridge"></td>
          <td><select class="finp" data-t="${j}" data-tf="limit_kind"><option value="max" ${t.limit_kind === 'max' ? 'selected' : ''}>no more than</option><option value="min" ${t.limit_kind === 'min' ? 'selected' : ''}>at least</option></select></td>
          <td><input class="finp" type="number" step="0.1" data-t="${j}" data-tf="limit_c" value="${esc(t.limit_c)}" style="width:70px"></td>
          <td><select class="finp" data-t="${j}" data-tf="basis">${BASES.map(b => `<option ${b === t.basis ? 'selected' : ''}>${b}</option>`).join('')}</select></td>
          <td><button class="tbtn del" data-tdel="${j}">✕</button></td></tr>`).join('')}</table>`
        : `<p class="fhint">None.</p>`;
      body += `<button class="btn" id="f_addtemp">+ Add a temperature</button>`;

      // numbers on this line
      const sends = (D.nums || []).some(n => n.report === 'prep_list');
      body += `<div class="glab" style="margin-top:22px">Things to count or weigh on this line <span class="ln"></span></div>`;
      if (sends) body += `<p class="fhint">These are sent to the makers on Telegram when the task is signed, in this order.</p>`;
      body += (D.nums || []).length ? `<table class="ftbl"><tr><th>Item</th><th>Container / unit</th><th>Where</th><th></th></tr>${
        D.nums.map((n, j) => `<tr>
          <td><input class="finp" data-n="${j}" data-nf="name" value="${esc(n.name)}"></td>
          <td><input class="finp" data-n="${j}" data-nf="unit_label" value="${esc(n.unit_label || '')}" placeholder="pots / g" style="width:90px"></td>
          <td><input class="finp" data-n="${j}" data-nf="group_name" value="${esc(n.group_name || '')}" placeholder="e.g. Door 2 · Shelf 1"></td>
          <td class="nowrap"><button class="tbtn" data-nup="${j}" ${j === 0 ? 'disabled' : ''}>↑</button><button class="tbtn" data-ndown="${j}" ${j === D.nums.length - 1 ? 'disabled' : ''}>↓</button><button class="tbtn del" data-ndel="${j}">✕</button></td></tr>`).join('')}</table>`
        : `<p class="fhint">None.</p>`;
      body += `<button class="btn" id="f_addnum">+ Add an item</button>`;
    } else if (k === 'temperature') {
      body += field('Unit or food', `<input class="finp" id="f_name" value="${esc(D.name)}" placeholder="e.g. Walk-in chiller">`);
      body += field('Must be', `<div class="inline"><select class="finp sm" id="f_kind"><option value="max" ${D.limit_kind === 'max' ? 'selected' : ''}>no more than</option><option value="min" ${D.limit_kind === 'min' ? 'selected' : ''}>at least</option></select>
          <input class="finp sm" id="f_lim" type="number" step="0.1" value="${esc(D.limit_c)}"><span class="deg">°C</span></div>`);
      body += field('Type', `<select class="finp" id="f_basis">${BASES.map(b => `<option ${b === D.basis ? 'selected' : ''}>${b}</option>`).join('')}</select>`,
        'Fridges and freezers can be marked “switched off”; hot food can be marked out of stock.');
      body += field('How-to, shown behind the ?', `<textarea class="finp ta" id="f_how">${esc(D.guidance || '')}</textarea>`);
    } else {
      body += field('Item', `<input class="finp" id="f_name" value="${esc(D.name)}" placeholder="e.g. Bowls">`);
      body += field('Container / unit', `<input class="finp" id="f_unit" value="${esc(D.unit_label || '')}" placeholder="e.g. sleeves">`);
      body += field('Flag when below', `<input class="finp sm" id="f_reorder" type="number" min="0" value="${esc(D.reorder_level ?? '')}">`, 'Optional. Below this, it is flagged as low.');
      body += field('How-to, shown behind the ?', `<textarea class="finp ta" id="f_how">${esc(D.guidance || '')}</textarea>`);
    }

    const title = isNew ? (k === 'checklist' ? 'Add a line' : k === 'temperature' ? 'Add a reading' : 'Add an item')
                        : (k === 'checklist' ? 'Line ' + (i + 1) : 'Edit');
    const p = panel(title, 'Changes are kept here until you press “Save changes” on the task.', body, () => {
      collect();
      const nm = (k === 'checklist' ? D.text : D.name || '').trim();
      if (!nm) { alert(k === 'checklist' ? 'Say what staff see on this line.' : 'Give it a name.'); return false; }
      if (k === 'checklist') {
        D.temps = (D.temps || []).filter(t => (t.name || '').trim());
        D.nums = (D.nums || []).filter(n => (n.name || '').trim());
      }
      if (isNew) T.items.push(D); else T.items[i] = D;
    });

    // keep typing when the panel redraws (add/remove rows)
    const collect = () => {
      const g = id => p.querySelector('#' + id);
      if (k === 'checklist') {
        D.text = g('f_text').value; D.est_minutes = g('f_min').value === '' ? null : +g('f_min').value;
        D.guidance = g('f_how').value; D.alt_label = g('f_alt').value;
        p.querySelectorAll('[data-tf]').forEach(el => {
          const t = D.temps[+el.dataset.t]; t[el.dataset.tf] = el.dataset.tf === 'limit_c' ? parseFloat(el.value) : el.value;
        });
        p.querySelectorAll('[data-nf]').forEach(el => { D.nums[+el.dataset.n][el.dataset.nf] = el.value; });
      } else if (k === 'temperature') {
        D.name = g('f_name').value; D.limit_kind = g('f_kind').value; D.limit_c = parseFloat(g('f_lim').value);
        D.basis = g('f_basis').value; D.guidance = g('f_how').value;
      } else {
        D.name = g('f_name').value; D.unit_label = g('f_unit').value;
        D.reorder_level = g('f_reorder').value === '' ? null : parseInt(g('f_reorder').value, 10);
        D.guidance = g('f_how').value;
      }
    };
    const redraw = () => { collect(); draw(); };

    p.querySelectorAll('[data-photo]').forEach(b => b.onclick = () => { collect(); D.photo_required = b.dataset.photo === '1'; draw(); });
    const on = (id, fn) => { const el = p.querySelector('#' + id); if (el) el.onclick = fn; };
    on('f_addtemp', () => { collect(); D.temps.push({ name: '', limit_kind: 'max', limit_c: 8, basis: 'Chilled storage', guidance: null }); draw(); });
    on('f_addnum', () => {
      collect();
      const sib = D.nums[D.nums.length - 1] || {};
      D.nums.push({ name: '', unit_label: sib.unit_label || '', group_name: sib.group_name || '', report: sib.report || null });
      draw();
    });
    on('f_img', () => pickPicture(url => { collect(); D.guidance_image = url; draw(); }));
    on('f_imgdel', () => { collect(); D.guidance_image = null; draw(); });
    p.querySelectorAll('[data-tdel]').forEach(b => b.onclick = () => { collect(); D.temps.splice(+b.dataset.tdel, 1); draw(); });
    p.querySelectorAll('[data-ndel]').forEach(b => b.onclick = () => { collect(); D.nums.splice(+b.dataset.ndel, 1); draw(); });
    p.querySelectorAll('[data-nup]').forEach(b => b.onclick = () => { collect(); const j = +b.dataset.nup; [D.nums[j - 1], D.nums[j]] = [D.nums[j], D.nums[j - 1]]; draw(); });
    p.querySelectorAll('[data-ndown]').forEach(b => b.onclick = () => { collect(); const j = +b.dataset.ndown; [D.nums[j + 1], D.nums[j]] = [D.nums[j], D.nums[j + 1]]; draw(); });
    void redraw;
  };
  draw();
}

// a how-to picture: shrunk, stored in the permanent reference bucket
function pickPicture(then) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const blob = await shrinkImage(f, 1200, 0.72);
      const path = `${T.id || 'new'}/${Date.now()}.jpg`;
      const { error } = await db.storage.from('reference').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      if (error) throw error;
      then(db.storage.from('reference').getPublicUrl(path).data.publicUrl);
    } catch (e) { alert('Could not add the picture: ' + (e.message || e)); }
  };
  inp.click();
}

/* ------------------------------------------------------------- when */

function editWhen() {
  const S = clone(T.sched);
  if (!S.times || !S.times.length) S.times = ['12:00'];
  const draw = () => {
    let body = '';
    if (T.kind === 'reminder') {
      body = `<div class="empty">A reminder is always on screen. It has no time.</div>`;
    } else {
      const pats = { ...WHEN_PATTERNS };
      if (!pats[S.pattern]) pats[S.pattern] = PATTERNS[S.pattern] || S.pattern;
      body += field('How often', `<div class="opts">${Object.entries(pats).map(([v, l]) =>
        `<button class="opt ${S.pattern === v ? 'on' : ''}" data-pat="${v}">${l}</button>`).join('')}</div>`);
      if (S.pattern !== 'on_demand') {
        body += field('Which days', `<div class="opts">${DAYS.map((d, n) =>
          `<button class="opt ${(S.days || []).includes(n + 1) ? 'on' : ''}" data-day="${n + 1}">${d}</button>`).join('')}</div>`);
      }
      if (S.pattern === 'once_daily' || S.pattern === 'certain_days') {
        body += field('Opens', `<input class="finp sm" type="time" id="w_start" value="${t5(S.window_start)}">`, 'It can be signed from this time.');
        body += field('Due', `<input class="finp sm" type="time" id="w_end" value="${t5(S.window_end)}">`);
      } else if (S.pattern === 'set_times') {
        body += field('Times', `${S.times.map((t, j) => `<div class="inline" style="margin-bottom:6px">
            <input class="finp sm" type="time" data-time="${j}" value="${t5(t)}">
            <button class="tbtn del" data-tdel="${j}" ${S.times.length < 2 ? 'disabled' : ''}>✕</button></div>`).join('')}
          <button class="btn" id="w_addtime">+ Add a time</button>`);
        body += field('Opens how early', `<div class="inline"><input class="finp sm" type="number" min="0" id="w_lead" value="${esc(S.lead_minutes ?? 30)}"><span class="deg">minutes before each time</span></div>`);
      } else if (S.pattern === 'every_n_hours') {
        body += field('Every', `<div class="inline"><input class="finp sm" type="number" step="0.5" min="0.5" id="w_int" value="${esc(S.interval_hours || 2)}"><span class="deg">hours, from</span>
          <input class="finp sm" type="time" id="w_start" value="${t5(S.window_start || '11:30')}"><span class="deg">to</span>
          <input class="finp sm" type="time" id="w_end" value="${t5(S.window_end || '21:00')}"></div>`);
      }
      if (S.pattern !== 'on_demand') {
        body += field('Tell the manager if it’s late by', `<div class="inline"><input class="finp sm" type="number" min="0" id="w_alert" value="${esc(S.alert_after ?? 30)}"><span class="deg">minutes after it’s due</span></div>`, 'A Telegram message goes to the manager.');
        body += field('Switched on?', `<div class="opts">
            <button class="opt ${S.active !== false ? 'on' : ''}" data-act="1">On — it goes on the board</button>
            <button class="opt ${S.active === false ? 'on' : ''}" data-act="0">Off — nothing goes on the board</button></div>`);
      }
    }
    const p = panel('When', 'Changes are kept here until you press “Save changes” on the task.', body, () => {
      collect();
      if (T.kind !== 'reminder' && S.pattern !== 'on_demand') {
        if (!(S.days || []).length) { alert('Pick at least one day.'); return false; }
        if ((S.pattern === 'once_daily' || S.pattern === 'certain_days') && toMins(S.window_end) <= toMins(S.window_start)) {
          alert('“Due” has to be after “Opens”.'); return false;
        }
      }
      T.sched = S;
    });
    const collect = () => {
      const g = id => p.querySelector('#' + id);
      if (g('w_start')) S.window_start = g('w_start').value;
      if (g('w_end')) S.window_end = g('w_end').value;
      if (g('w_int')) S.interval_hours = parseFloat(g('w_int').value);
      if (g('w_lead')) S.lead_minutes = parseInt(g('w_lead').value, 10) || 0;
      if (g('w_alert')) S.alert_after = parseInt(g('w_alert').value, 10) || 0;
      p.querySelectorAll('[data-time]').forEach(el => { S.times[+el.dataset.time] = el.value; });
    };
    p.querySelectorAll('[data-pat]').forEach(b => b.onclick = () => { collect(); S.pattern = b.dataset.pat; draw(); });
    p.querySelectorAll('[data-day]').forEach(b => b.onclick = () => {
      collect(); const n = +b.dataset.day, d = S.days || [];
      S.days = d.includes(n) ? d.filter(x => x !== n) : [...d, n].sort(); draw();
    });
    p.querySelectorAll('[data-act]').forEach(b => b.onclick = () => { collect(); S.active = b.dataset.act === '1'; draw(); });
    const add = p.querySelector('#w_addtime');
    if (add) add.onclick = () => { collect(); S.times.push('12:00'); draw(); };
    p.querySelectorAll('[data-tdel]').forEach(b => b.onclick = () => { collect(); S.times.splice(+b.dataset.tdel, 1); draw(); });
  };
  draw();
}

/* ------------------------------------------------------------ details */

function editDetails() {
  const D = { name: T.name, station_id: T.station_id, intro: T.intro, est: T.est };
  const body =
    field('Name', `<input class="finp" id="d_name" value="${esc(D.name)}" placeholder="e.g. Closing">`) +
    field('Side', `<select class="finp" id="d_st">${STATIONS.map(s =>
      `<option value="${s.id}" ${s.id === D.station_id ? 'selected' : ''}>${esc(s.name)}${s.areas ? ' · ' + esc(s.areas.name) : ''}</option>`).join('')}</select>`) +
    field('Shown at the top on the iPad', `<textarea class="finp ta" id="d_intro">${esc(D.intro || '')}</textarea>`, 'Optional. One or two sentences.') +
    (T.kind !== 'checklist' ? field('Roughly how long (minutes)', `<input class="finp sm" type="number" min="0" id="d_est" value="${esc(D.est || '')}">`) : '');
  const p = panel('Details', 'Changes are kept here until you press “Save changes” on the task.', body, () => {
    const g = id => p.querySelector('#' + id);
    if (!g('d_name').value.trim()) { alert('Give the task a name.'); return false; }
    T.name = g('d_name').value.trim(); T.station_id = g('d_st').value; T.intro = g('d_intro').value;
    if (g('d_est')) T.est = g('d_est').value;
  });
}

/* --------------------------------------------------------------- save */

async function saveTask(fromBtn) {
  const k = T.kind;
  const noItems = k === 'incident' || k === 'reminder';
  if (!T.name.trim()) { editDetails(); return; }
  if (!noItems && !T.items.length) return alert('Add at least one ' + (k === 'checklist' ? 'line' : 'item') + ' first.');

  const btn = (fromBtn && fromBtn.nodeType) ? fromBtn : $('savetask'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    let checkId = T.id;
    // a checklist's length is its lines added up
    const lineMins = k === 'checklist' ? T.items.reduce((a, x) => a + (+x.est_minutes || 0), 0) : 0;
    const payload = { station_id: T.station_id, kind: k, name: T.name.trim(), intro: (T.intro || '').trim() || null,
                      est_minutes: k === 'checklist' ? (lineMins || null) : (T.est ? +T.est : null) };
    if (checkId) {
      const { error } = await db.from('checks').update(payload).eq('id', checkId);
      if (error) throw error;
    } else {
      const { data, error } = await db.from('checks').insert(payload).select('id').single();
      if (error) throw error;
      checkId = data.id;
    }

    // a new version every save, so signed records keep the wording they were signed against
    const { data: ver, error: ve } = await db.from('check_versions')
      .insert({ check_id: checkId, version_no: T.versionNo + 1, status: 'live', published_at: new Date().toISOString() })
      .select('id').single();
    if (ve) throw ve;
    if (T.versionId) await db.from('check_versions').update({ status: 'retired' }).eq('id', T.versionId);

    if (!noItems) {
      const tbl = k === 'temperature' ? 'units' : k === 'count' ? 'count_items' : 'steps';
      const rows = T.items.map((it, i) => {
        const base = { check_version_id: ver.id, sort: i + 1 };
        if (k === 'temperature') return { ...base, name: it.name.trim(), limit_kind: it.limit_kind, limit_c: it.limit_c,
          basis: it.basis || null, guidance: it.guidance || null, guidance_image: it.guidance_image || null };
        if (k === 'count') return { ...base, name: it.name.trim(), reorder_level: it.reorder_level ?? null,
          unit_label: it.unit_label || null, guidance: it.guidance || null, guidance_image: it.guidance_image || null };
        return { ...base, text: it.text.trim(), photo_required: !!it.photo_required, guidance: it.guidance || null,
          guidance_image: it.guidance_image || null, est_minutes: it.est_minutes ?? null,
          alt_label: (it.alt_label || '').trim() || null };
      });
      const { data: made, error } = await db.from(tbl).insert(rows).select('id,sort');
      if (error) throw error;

      if (k === 'checklist') {
        const stepFor = i => (made || []).find(m => m.sort === i + 1);
        const temps = [], nums = [];
        T.items.forEach((it, i) => {
          const step = stepFor(i); if (!step) return;
          (it.temps || []).forEach(t => temps.push({ check_version_id: ver.id, step_id: step.id, sort: temps.length + 1,
            name: t.name.trim(), limit_kind: t.limit_kind, limit_c: t.limit_c, basis: t.basis || 'Chilled storage',
            guidance: t.guidance || null, guidance_image: t.guidance_image || null }));
          // the line's report (the makers' prep list) survives every edit
          const rpt = (it.nums || []).map(n => n.report).find(Boolean) || null;
          (it.nums || []).forEach(n => nums.push({ check_version_id: ver.id, step_id: step.id, sort: nums.length + 1,
            name: n.name.trim(), unit_label: (n.unit_label || '').trim() || null,
            group_name: (n.group_name || '').trim() || null, report: n.report || rpt, reorder_level: null,
            guidance: n.guidance || null, guidance_image: n.guidance_image || null }));
        });
        if (temps.length) { const { error: te } = await db.from('units').insert(temps); if (te) throw te; }
        if (nums.length) { const { error: ne } = await db.from('count_items').insert(nums); if (ne) throw ne; }
      }
    }

    if (k !== 'reminder') {
      const s = T.sched;
      const win = ['once_daily','certain_days'].includes(s.pattern) && s.window_start && s.window_end
        ? toMins(s.window_end) - toMins(s.window_start) : null;
      const sched = { check_id: checkId, pattern: s.pattern, days: s.days && s.days.length ? s.days : [1,2,3,4,5,6,7],
        // a window task appears when its window opens; timed ones keep their own lead
        lead_minutes: win > 0 ? win : (s.lead_minutes ?? 30),
        alert_after: s.alert_after ?? 30,
        active: s.active !== false,
        window_start: ['once_daily','every_n_hours','certain_days'].includes(s.pattern) ? s.window_start : null,
        window_end:   ['once_daily','every_n_hours','certain_days'].includes(s.pattern) ? s.window_end : null,
        times:        s.pattern === 'set_times' ? s.times.filter(Boolean).sort() : null,
        interval_hours: s.pattern === 'every_n_hours' ? s.interval_hours : null,
        anchor_date: s.anchor_date || null, interval_weeks: s.interval_weeks || null };
      await db.from('schedules').delete().eq('check_id', checkId);
      const { error } = await db.from('schedules').insert(sched);
      if (error) throw error;
    }

    await db.rpc('spawn_occurrences');
    // today's unsigned tasks move onto the new version, so the change lands now
    await db.rpc('refresh_pending_versions');
    await db.from('ops_activity').insert({ actor: (await db.auth.getUser()).data.user?.email,
      verb: 'check_published', check_id: checkId, detail: T.name + ' — version ' + (T.versionNo + 1) });
    T.dirty = false;
    await openTask(checkId);
    flash('Saved. Staff see it now.');
  } catch (e) {
    alert('Could not save: ' + (e.message || e));
    btn.disabled = false; btn.textContent = T.isNew ? 'Save task' : 'Save changes';
  }
}

async function archiveTask() {
  if (!confirm(`Archive “${T.name}”? It stops appearing on the iPad. Past records are kept.`)) return;
  await db.from('checks').update({ archived_at: new Date().toISOString() }).eq('id', T.id);
  await db.from('schedules').update({ active: false }).eq('check_id', T.id);
  T = null; viewTasks();
  flash('Archived.');
}

function flash(msg) {
  let el = $('flash');
  if (!el) { el = document.createElement('div'); el.id = 'flash'; el.className = 'flash'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

window.addEventListener('beforeunload', e => { if (T && T.dirty) { e.preventDefault(); e.returnValue = ''; } });
