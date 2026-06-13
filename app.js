/* Project Tracker — front-end preview
   Pure client-side: state lives in localStorage so the board persists across
   reloads with no backend. Swap the `store` layer for an API later.

   Two views:
   • Board    — Kanban, the developer's day-to-day view.
   • Timeline — a Gantt-style project-wide view with an overall progress summary. */

(() => {
  'use strict';

  // ── Configuration ──────────────────────────────────────────────────────
  const COLUMNS = [
    { id: 'todo',     title: 'To Do',       accent: '#97a0af' },
    { id: 'progress', title: 'In Progress', accent: '#4f46e5' },
    { id: 'review',   title: 'In Review',   accent: '#f5a524' },
    { id: 'done',     title: 'Done',        accent: '#30a46c' },
  ];
  const STATUS = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));

  // How "done" each status counts as, for progress roll-ups.
  const STATUS_PROGRESS = { todo: 0, progress: 50, review: 80, done: 100 };

  const AVATAR_COLORS = ['#e5484d', '#4f46e5', '#30a46c', '#f5a524', '#8b5cf6', '#0ea5e9', '#d6409f'];
  const DAY_MS    = 86400000;
  const DAY_WIDTH = 38;                 // px per day in the Gantt
  const STORE_KEY = 'project-tracker/v1';

  // ── Seed data (first run only) ─────────────────────────────────────────
  const SEED = {
    members: [
      { id: 'm1', name: 'Aisha Khan' },
      { id: 'm2', name: 'Ben Ortiz' },
      { id: 'm3', name: 'Chen Wei' },
      { id: 'm4', name: 'Dara Singh' },
    ],
    tasks: [
      { id: 't1', title: 'Define MVP scope',           desc: 'Agree the feature cut for v1 with the team.',  assignee: 'm1', reviewer: 'm3', priority: 'high',   status: 'done',     start: '2026-05-26', due: '2026-05-29' },
      { id: 't2', title: 'Wireframe the board UI',      desc: 'Low-fi mockups for the Kanban layout.',        assignee: 'm3', reviewer: 'm1', priority: 'medium', status: 'done',     start: '2026-05-28', due: '2026-06-02' },
      { id: 't3', title: 'Set up component library',    desc: 'Buttons, cards, modal, form fields.',          assignee: 'm2', reviewer: 'm3', priority: 'medium', status: 'progress', start: '2026-06-03', due: '2026-06-12',
        subtasks: [
          { id: 's1', title: 'Buttons', done: true },
          { id: 's2', title: 'Card + badge', done: true },
          { id: 's3', title: 'Modal + form fields', done: false },
          { id: 's4', title: 'Avatars', done: false },
        ] },
      { id: 't4', title: 'Drag-and-drop between lanes', desc: 'Move cards across status columns.',            assignee: 'm2', reviewer: 'm1', priority: 'high',   status: 'progress', start: '2026-06-04', due: '2026-06-10',
        subtasks: [
          { id: 's5', title: 'dragstart / dragend', done: true },
          { id: 's6', title: 'drop updates status', done: false },
        ] },
      { id: 't5', title: 'Review accessibility',        desc: 'Keyboard nav + contrast pass.',                assignee: 'm4', reviewer: 'm2', priority: 'low',    status: 'review',   start: '2026-06-06', due: '2026-06-15' },
      { id: 't6', title: 'Write onboarding copy',       desc: 'Empty states and first-run hints.',            assignee: 'm1', reviewer: null, priority: 'low',    status: 'todo',     start: '2026-06-09', due: '2026-06-13' },
      { id: 't7', title: 'Plan backend API',            desc: 'Shape the endpoints to replace localStorage.', assignee: 'm3', reviewer: 'm4', priority: 'medium', status: 'todo',     start: '2026-06-11', due: '2026-06-20' },
    ],
  };

  // ── Date helpers ─────────────────────────────────────────────────────
  const parseDate = (s) => (s ? new Date(s + 'T00:00:00') : null);
  const toISO = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  const dayIndex = (from, d) => Math.round((d - from) / DAY_MS);
  const todayMidnight = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };

  // ── Store (with a small migration) ─────────────────────────────────────
  const store = {
    load() {
      let s;
      try {
        const raw = localStorage.getItem(STORE_KEY);
        s = raw ? JSON.parse(raw) : structuredClone(SEED);
      } catch (_) { s = structuredClone(SEED); }
      // Migrate: every task needs a `start` for the timeline. Backfill missing
      // ones from the due date (or today) without disturbing existing data.
      let changed = false;
      s.tasks.forEach((t) => {
        if (!t.start) {
          const base = t.due ? addDays(parseDate(t.due), -3) : todayMidnight();
          t.start = toISO(base);
          changed = true;
        }
        if (!Array.isArray(t.subtasks)) { t.subtasks = []; changed = true; }
        if (typeof t.paused !== 'boolean') { t.paused = false; changed = true; }
        if (!('reviewer' in t)) { t.reviewer = null; changed = true; }
      });
      if (changed) this.save(s);
      return s;
    },
    save(s) { localStorage.setItem(STORE_KEY, JSON.stringify(s)); },
  };

  let state = store.load();
  let filterMember = null;        // member id or null
  let view = 'board';             // 'board' | 'timeline'
  const collapsed = new Set();    // task ids whose subtask hierarchy is collapsed
  const persist = () => store.save(state);

  // ── DOM helpers ────────────────────────────────────────────────────────
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const memberById = (id) => state.members.find((m) => m.id === id);
  const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const colorFor = (id) => {
    const idx = state.members.findIndex((m) => m.id === id);
    return AVATAR_COLORS[(idx < 0 ? 0 : idx) % AVATAR_COLORS.length];
  };

  function avatarEl(memberId, { sm = false, interactive = false } = {}) {
    const m = memberById(memberId);
    const el = document.createElement('span');
    el.className = 'avatar' + (sm ? ' sm' : '');
    if (m) {
      el.textContent = initials(m.name);
      el.style.background = colorFor(memberId);
      el.title = m.name;
    } else {
      el.textContent = '–';
      el.style.background = 'var(--muted)';
      el.title = 'Unassigned';
    }
    if (interactive) el.dataset.member = memberId;
    return el;
  }

  // Small "reviewer" marker: an eye glyph + the reviewer's avatar. Returns null
  // when no reviewer is set, so callers can append unconditionally.
  function reviewerChip(memberId) {
    if (!memberId) return null;
    const m = memberById(memberId);
    const wrap = document.createElement('span');
    wrap.className = 'reviewer-chip';
    wrap.title = 'Reviewer: ' + (m ? m.name : 'Unknown');
    const icon = document.createElement('span');
    icon.className = 'reviewer-icon';
    icon.textContent = '👁';
    const av = avatarEl(memberId, { sm: true });
    av.classList.add('reviewer-avatar');
    wrap.append(icon, av);
    return wrap;
  }

  function fmtDue(due) {
    if (!due) return null;
    const d = parseDate(due);
    const overdue = d < todayMidnight();
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return { label, overdue };
  }

  const uid = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const visibleTasks = () => state.tasks.filter((t) => !filterMember || t.assignee === filterMember);

  // Progress %: driven by subtask completion when a task has any, otherwise by status.
  function taskProgress(t) {
    const subs = t.subtasks || [];
    if (subs.length) return Math.round((subs.filter((s) => s.done).length / subs.length) * 100);
    return STATUS_PROGRESS[t.status] ?? 0;
  }

  // Toggle one subtask's done state directly on the live data (inline, no modal).
  function setSubtaskDone(taskId, subId, done) {
    const t = state.tasks.find((x) => x.id === taskId);
    const s = t && (t.subtasks || []).find((x) => x.id === subId);
    if (s) { s.done = done; persist(); render(); }
  }

  function toggleCollapse(taskId) {
    collapsed.has(taskId) ? collapsed.delete(taskId) : collapsed.add(taskId);
    render();
  }

  // ── Team strip + filter banner ─────────────────────────────────────────
  function renderTeam() {
    const strip = $('#team-strip');
    strip.innerHTML = '';
    state.members.forEach((m) => {
      const a = avatarEl(m.id, { interactive: true });
      if (filterMember === m.id) a.classList.add('active');
      a.addEventListener('click', () => {
        filterMember = (filterMember === m.id) ? null : m.id;
        render();
      });
      strip.appendChild(a);
    });
  }

  function renderFilterBanner() {
    const banner = $('#filter-banner');
    if (filterMember) {
      $('#filter-name').textContent = memberById(filterMember)?.name ?? '';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  // ── Board view ───────────────────────────────────────────────────────
  function renderBoard() {
    const board = $('#board');
    board.innerHTML = '';
    const visible = visibleTasks();

    COLUMNS.forEach((col) => {
      const tasks = visible.filter((t) => t.status === col.id);

      const column = document.createElement('section');
      column.className = 'column';
      column.dataset.status = col.id;

      const head = document.createElement('div');
      head.className = 'column-head';
      head.innerHTML = `
        <span class="column-title"><span class="col-accent" style="background:${col.accent}"></span>${col.title}</span>
        <span class="column-count">${tasks.length}</span>`;
      column.appendChild(head);

      const list = document.createElement('div');
      list.className = 'column-cards';
      if (!tasks.length) {
        const empty = document.createElement('p');
        empty.className = 'col-empty';
        empty.textContent = 'Drop tasks here';
        list.appendChild(empty);
      } else {
        tasks.forEach((t) => list.appendChild(cardEl(t)));
      }
      column.appendChild(list);

      column.addEventListener('dragover', (e) => { e.preventDefault(); column.classList.add('drag-over'); });
      column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
      column.addEventListener('drop', (e) => {
        e.preventDefault();
        column.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        const task = state.tasks.find((t) => t.id === id);
        if (task && task.status !== col.id) { task.status = col.id; persist(); render(); }
      });

      board.appendChild(column);
    });
  }

  function cardEl(t) {
    const card = document.createElement('article');
    card.className = 'card' + (t.paused ? ' paused' : '');
    card.draggable = true;

    const due = fmtDue(t.due);
    const subs = t.subtasks || [];
    const doneSubs = subs.filter((s) => s.done).length;
    const pct = taskProgress(t);
    const open = !collapsed.has(t.id);

    card.innerHTML = `
      <div class="card-top">
        <span class="card-title">${escapeHtml(t.title)}</span>
        <span class="card-tags">
          ${t.paused ? '<span class="paused-badge">⏸ Paused</span>' : ''}
          <span class="badge ${t.priority}">${t.priority}</span>
        </span>
      </div>
      ${t.desc ? `<p class="card-desc">${escapeHtml(t.desc)}</p>` : ''}`;

    // Subtask hierarchy — visible & toggleable right on the card.
    if (subs.length) {
      const tree = document.createElement('div');
      tree.className = 'subtree';
      tree.addEventListener('click', (e) => e.stopPropagation());   // don't open the modal

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'subtree-toggle';
      toggle.innerHTML =
        `<span class="chev">${open ? '▾' : '▸'}</span> Subtasks ` +
        `<span class="st-count ${doneSubs === subs.length ? 'complete' : ''}">${doneSubs}/${subs.length}</span>`;
      toggle.addEventListener('click', () => toggleCollapse(t.id));
      tree.appendChild(toggle);

      const mini = document.createElement('div');
      mini.className = 'mini-bar';
      mini.innerHTML = `<span style="width:${pct}%"></span>`;
      tree.appendChild(mini);

      if (open) {
        const ul = document.createElement('ul');
        ul.className = 'card-subtasks';
        subs.forEach((st) => {
          const li = document.createElement('li');
          li.className = 'card-subtask' + (st.done ? ' done' : '');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = st.done;
          cb.addEventListener('change', () => setSubtaskDone(t.id, st.id, cb.checked));
          const sp = document.createElement('span');
          sp.className = 'cst-title';
          sp.textContent = st.title;
          li.append(cb, sp);
          ul.appendChild(li);
        });
        tree.appendChild(ul);
      }
      card.appendChild(tree);
    }

    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.appendChild(avatarEl(t.assignee, { sm: true }));
    const rchip = reviewerChip(t.reviewer);
    if (rchip) meta.appendChild(rchip);
    foot.appendChild(meta);
    const dueEl = document.createElement('span');
    if (due) { dueEl.className = 'due ' + (due.overdue ? 'overdue' : ''); dueEl.textContent = '📅 ' + due.label; }
    foot.appendChild(dueEl);
    card.appendChild(foot);

    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', t.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', () => openModal(t));
    return card;
  }

  // ── Timeline (Gantt) view ──────────────────────────────────────────────
  function taskSpan(t) {
    const start = parseDate(t.start) || todayMidnight();
    const end   = parseDate(t.due) || start;          // no due → single-day bar
    return { start, end: end < start ? start : end };
  }

  function renderTimeline() {
    renderSummary();

    const gantt = $('#gantt');
    gantt.innerHTML = '';

    const tasks = visibleTasks()
      .slice()
      .sort((a, b) => (parseDate(a.start) - parseDate(b.start)) || a.title.localeCompare(b.title));

    if (!tasks.length) {
      gantt.innerHTML = '<p class="col-empty" style="padding:2rem">No tasks to show.</p>';
      return;
    }

    // Range = earliest start to latest end, padded by a day each side.
    let min = taskSpan(tasks[0]).start, max = taskSpan(tasks[0]).end;
    tasks.forEach((t) => {
      const { start, end } = taskSpan(t);
      if (start < min) min = start;
      if (end > max) max = end;
    });
    const rangeStart = addDays(min, -1);
    const rangeEnd   = addDays(max, 1);
    const totalDays  = dayIndex(rangeStart, rangeEnd) + 1;
    const trackWidth = totalDays * DAY_WIDTH;
    const gridBg = `repeating-linear-gradient(to right, transparent 0, transparent ${DAY_WIDTH - 1}px, var(--border) ${DAY_WIDTH - 1}px, var(--border) ${DAY_WIDTH}px)`;

    const today    = todayMidnight();
    const todayIdx = dayIndex(rangeStart, today);
    const todayInRange = todayIdx >= 0 && todayIdx < totalDays;

    const board = document.createElement('div');
    board.className = 'gantt';

    board.appendChild(buildHeader(rangeStart, totalDays, trackWidth, today));

    tasks.forEach((t) => {
      const { start, end } = taskSpan(t);
      const offset   = dayIndex(rangeStart, start);
      const duration = dayIndex(start, end) + 1;
      const pct      = taskProgress(t);
      const color    = STATUS[t.status]?.accent ?? '#97a0af';
      const subs     = t.subtasks || [];

      const row = document.createElement('div');
      row.className = 'gantt-row';

      // left label (chevron when it has subtasks, ⏸ prefix when paused)
      const label = document.createElement('div');
      label.className = 'gantt-label';
      if (subs.length) {
        const chev = document.createElement('button');
        chev.type = 'button';
        chev.className = 'g-chev';
        chev.textContent = collapsed.has(t.id) ? '▸' : '▾';
        chev.addEventListener('click', (e) => { e.stopPropagation(); toggleCollapse(t.id); });
        label.appendChild(chev);
      }
      label.appendChild(avatarEl(t.assignee, { sm: true }));
      const rchip = reviewerChip(t.reviewer);
      if (rchip) label.appendChild(rchip);
      const name = document.createElement('span');
      name.className = 'task-name';
      name.textContent = (t.paused ? '⏸ ' : '') + t.title;
      name.title = t.title;
      label.appendChild(name);
      row.appendChild(label);

      // track + bar
      const track = document.createElement('div');
      track.className = 'gantt-track';
      track.style.width = trackWidth + 'px';
      track.style.background = gridBg;

      if (todayInRange) {
        const line = document.createElement('div');
        line.className = 'today-line';
        line.style.left = (todayIdx * DAY_WIDTH + DAY_WIDTH / 2) + 'px';
        track.appendChild(line);
      }

      const bar = document.createElement('div');
      bar.className = 'gantt-bar' + (t.paused ? ' paused' : '');
      bar.style.left  = (offset * DAY_WIDTH + 3) + 'px';
      bar.style.width = (duration * DAY_WIDTH - 6) + 'px';
      bar.style.background = color + '33';            // light track for the bar
      bar.title = subs.length
        ? `${t.title} · ${pct}% (${subs.filter((s) => s.done).length}/${subs.length} subtasks)`
        : `${t.title} · ${pct}% (${STATUS[t.status]?.title})`;

      const fill = document.createElement('div');
      fill.className = 'fill';
      fill.style.width = pct + '%';
      fill.style.background = color;
      bar.appendChild(fill);

      const blab = document.createElement('span');
      blab.className = 'bar-label';
      blab.textContent = pct === 100 ? '✓ Done' : pct + '%';
      blab.style.color = pct >= 50 ? '#fff' : '#172b4d';
      blab.style.textShadow = pct >= 50 ? '0 1px 1px rgba(0,0,0,.25)' : 'none';
      bar.appendChild(blab);

      bar.addEventListener('click', () => openModal(t));
      bar.style.cursor = 'pointer';
      track.appendChild(bar);
      row.appendChild(track);

      board.appendChild(row);

      // Indented subtask child rows (hierarchy + per-subtask progress).
      if (subs.length && !collapsed.has(t.id)) {
        subs.forEach((st) => {
          const srow = document.createElement('div');
          srow.className = 'gantt-row subtask-row';

          const slabel = document.createElement('div');
          slabel.className = 'gantt-label sub';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = st.done;
          cb.addEventListener('change', () => setSubtaskDone(t.id, st.id, cb.checked));
          const sname = document.createElement('span');
          sname.className = 'task-name sub-name' + (st.done ? ' done' : '');
          sname.textContent = st.title;
          sname.title = st.title;
          slabel.append(cb, sname);
          srow.appendChild(slabel);

          const strack = document.createElement('div');
          strack.className = 'gantt-track';
          strack.style.width = trackWidth + 'px';
          strack.style.background = gridBg;
          if (todayInRange) {
            const sline = document.createElement('div');
            sline.className = 'today-line';
            sline.style.left = (todayIdx * DAY_WIDTH + DAY_WIDTH / 2) + 'px';
            strack.appendChild(sline);
          }
          const sbar = document.createElement('div');
          sbar.className = 'subtask-bar' + (st.done ? ' done' : '');
          sbar.style.left  = (offset * DAY_WIDTH + 6) + 'px';
          sbar.style.width = (duration * DAY_WIDTH - 12) + 'px';
          sbar.title = `${st.title} — ${st.done ? 'done' : 'open'}`;
          strack.appendChild(sbar);
          srow.appendChild(strack);

          board.appendChild(srow);
        });
      }
    });

    gantt.appendChild(board);
    // Scroll so "today" is roughly in view on first paint.
    if (todayInRange) gantt.scrollLeft = Math.max(0, todayIdx * DAY_WIDTH - 200);
  }

  function buildHeader(rangeStart, totalDays, trackWidth, today) {
    const head = document.createElement('div');
    head.className = 'gantt-row gantt-head';

    const label = document.createElement('div');
    label.className = 'gantt-label';
    label.textContent = 'Task';
    head.appendChild(label);

    const track = document.createElement('div');
    track.className = 'gantt-track';
    track.style.width = trackWidth + 'px';

    // month strip
    const months = document.createElement('div');
    months.className = 'gantt-months';
    let m = -1, span = null;
    for (let i = 0; i < totalDays; i++) {
      const d = addDays(rangeStart, i);
      if (d.getMonth() !== m) {
        m = d.getMonth();
        span = document.createElement('div');
        span.className = 'gantt-month';
        span.textContent = d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
        span.dataset.days = '0';
        months.appendChild(span);
      }
      span.dataset.days = String(+span.dataset.days + 1);
    }
    $$('.gantt-month', months).forEach((el) => { el.style.width = (+el.dataset.days * DAY_WIDTH) + 'px'; });
    track.appendChild(months);

    // day strip
    const days = document.createElement('div');
    days.className = 'gantt-days';
    const todayTime = today.getTime();
    for (let i = 0; i < totalDays; i++) {
      const d = addDays(rangeStart, i);
      const cell = document.createElement('div');
      cell.className = 'gantt-day';
      cell.style.width = DAY_WIDTH + 'px';
      const dow = d.getDay();
      if (dow === 0 || dow === 6) cell.classList.add('weekend');
      if (d.getTime() === todayTime) cell.classList.add('today');
      cell.innerHTML = `<span class="gantt-dow">${'SMTWTFS'[dow]}</span><span>${d.getDate()}</span>`;
      days.appendChild(cell);
    }
    track.appendChild(days);

    head.appendChild(track);
    return head;
  }

  function renderSummary() {
    const tasks = visibleTasks();
    const summary = $('#timeline-summary');
    const total = tasks.length;
    const overall = total ? Math.round(tasks.reduce((s, t) => s + taskProgress(t), 0) / total) : 0;
    const counts = Object.fromEntries(COLUMNS.map((c) => [c.id, tasks.filter((t) => t.status === c.id).length]));
    const doneCount = counts.done;
    const pausedCount = tasks.filter((t) => t.paused).length;

    const chips = COLUMNS.map((c) =>
      `<span class="summary-chip"><span class="dot" style="background:${c.accent}"></span>${c.title} ${counts[c.id]}</span>`
    ).join('');

    // proportional progress bar segmented by status weight
    const segs = total ? COLUMNS.map((c) => {
      const w = (counts[c.id] / total) * 100;
      return w > 0 ? `<span style="width:${w}%;background:${c.accent}"></span>` : '';
    }).join('') : '';

    const scope = filterMember ? `${escapeHtml(memberById(filterMember)?.name ?? '')}'s tasks` : 'All projects';

    summary.innerHTML = `
      <div class="summary-top">
        <div>
          <div class="summary-pct">${overall}% complete</div>
          <div class="summary-sub">${scope} · ${doneCount} of ${total} done${pausedCount ? ` · ${pausedCount} paused ⏸` : ''}</div>
        </div>
        <div class="summary-chips">${chips}</div>
      </div>
      <div class="summary-bar">${segs}</div>`;
  }

  // ── Modal ───────────────────────────────────────────────────────────────
  const overlay = $('#modal-overlay');
  let modalSubtasks = [];           // working copy; committed to the task on Save

  const sid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);

  function renderSubtasks() {
    const list = $('#subtask-list');
    list.innerHTML = '';
    modalSubtasks.forEach((st) => {
      const li = document.createElement('li');
      li.className = 'subtask-item' + (st.done ? ' done' : '');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = st.done;
      cb.addEventListener('change', () => { st.done = cb.checked; renderSubtasks(); });

      const title = document.createElement('span');
      title.className = 'st-title';
      title.textContent = st.title;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'st-del';
      del.textContent = '✕';
      del.title = 'Remove subtask';
      del.addEventListener('click', () => {
        modalSubtasks = modalSubtasks.filter((x) => x.id !== st.id);
        renderSubtasks();
      });

      li.append(cb, title, del);
      list.appendChild(li);
    });

    const done = modalSubtasks.filter((s) => s.done).length;
    $('#subtask-progress').textContent = modalSubtasks.length ? `${done}/${modalSubtasks.length}` : '';
  }

  function addSubtask() {
    const input = $('#subtask-input');
    const title = input.value.trim();
    if (!title) return;
    modalSubtasks.push({ id: sid(), title, done: false });
    input.value = '';
    renderSubtasks();
    input.focus();                  // stay put so several can be added in a row
  }

  $('#subtask-add-btn').addEventListener('click', addSubtask);
  $('#subtask-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addSubtask(); }
  });

  function fillSelects() {
    const people = state.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
    $('#f-assignee').innerHTML = '<option value="">Unassigned</option>' + people;
    $('#f-reviewer').innerHTML = '<option value="">No reviewer</option>' + people;
    $('#f-status').innerHTML = COLUMNS.map((c) => `<option value="${c.id}">${c.title}</option>`).join('');
  }

  function openModal(task) {
    fillSelects();
    const isEdit = !!task;
    $('#modal-title').textContent = isEdit ? 'Edit task' : 'New task';
    $('#task-id').value    = isEdit ? task.id : '';
    $('#f-title').value    = isEdit ? task.title : '';
    $('#f-desc').value     = isEdit ? task.desc : '';
    $('#f-assignee').value = isEdit ? (task.assignee || '') : '';
    $('#f-reviewer').value = isEdit ? (task.reviewer || '') : '';
    $('#f-priority').value = isEdit ? task.priority : 'medium';
    $('#f-status').value   = isEdit ? task.status : 'todo';
    $('#f-start').value    = isEdit ? (task.start || '') : toISO(todayMidnight());
    $('#f-due').value      = isEdit ? (task.due || '') : '';
    $('#f-paused').checked = isEdit ? !!task.paused : false;
    modalSubtasks = isEdit ? (task.subtasks || []).map((s) => ({ ...s })) : [];
    $('#subtask-input').value = '';
    renderSubtasks();
    $('#delete-task').classList.toggle('hidden', !isEdit);
    overlay.classList.remove('hidden');
    $('#f-title').focus();
  }

  const closeModal = () => overlay.classList.add('hidden');

  $('#task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('#task-id').value;
    const data = {
      title:    $('#f-title').value.trim(),
      desc:     $('#f-desc').value.trim(),
      assignee: $('#f-assignee').value || null,
      reviewer: $('#f-reviewer').value || null,
      priority: $('#f-priority').value,
      status:   $('#f-status').value,
      start:    $('#f-start').value || toISO(todayMidnight()),
      due:      $('#f-due').value || '',
      paused:   $('#f-paused').checked,
      subtasks: modalSubtasks.map((s) => ({ ...s })),
    };
    if (!data.title) return;
    if (id) Object.assign(state.tasks.find((t) => t.id === id), data);
    else    state.tasks.push({ id: uid(), ...data });
    persist();
    closeModal();
    render();
  });

  $('#delete-task').addEventListener('click', () => {
    const id = $('#task-id').value;
    if (id && confirm('Delete this task?')) {
      state.tasks = state.tasks.filter((t) => t.id !== id);
      persist(); closeModal(); render();
    }
  });

  // ── View switching ───────────────────────────────────────────────────
  $('#view-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    view = btn.dataset.view;
    render();
  });

  // ── Wiring ──────────────────────────────────────────────────────────────
  $('#add-task-btn').addEventListener('click', () => openModal(null));
  $('#modal-close').addEventListener('click', closeModal);
  $('#cancel-task').addEventListener('click', closeModal);
  $('#clear-filter').addEventListener('click', () => { filterMember = null; render(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal(); });

  // ── Render orchestration ─────────────────────────────────────────────────
  function render() {
    renderTeam();
    renderFilterBanner();

    const isBoard = view === 'board';
    $('#board-view').classList.toggle('hidden', !isBoard);
    $('#timeline-view').classList.toggle('hidden', isBoard);
    $$('#view-switch .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

    if (isBoard) renderBoard();
    else         renderTimeline();
  }

  render();
})();
