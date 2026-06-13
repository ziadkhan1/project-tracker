/* Project Tracker — Firebase-backed team board
   ─────────────────────────────────────────────────────────────────────────
   • Auth     : Google Sign-In via Firebase Auth.
   • Access   : gated by an `allowedUsers` allowlist in Firestore. Admins manage
                it from the in-app Admin page; the OWNER_EMAIL is always an admin.
   • Storage  : tasks live in Firestore (`tasks`), synced live to every signed-in
                client. Assignable members are the allowed users themselves.

   Two views:
   • Board    — Kanban, the day-to-day view.
   • Timeline — a Gantt-style project-wide view with a progress summary. */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, setDoc, deleteDoc, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { firebaseConfig, OWNER_EMAIL } from './firebase-config.js';

(() => {
  'use strict';

  // ── DOM helpers ────────────────────────────────────────────────────────
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function showScreen(name) {
    ['boot', 'config', 'signin', 'denied', 'app'].forEach((s) => {
      document.getElementById(s + '-screen').classList.toggle('hidden', s !== name);
    });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  // ── Setup gate ─────────────────────────────────────────────────────────
  // If firebase-config.js still has placeholders the app can't reach a backend —
  // we show the setup screen, but still offer a no-backend UI preview (DEMO mode).
  const configReady = !Object.values(firebaseConfig).some(
    (v) => typeof v === 'string' && v.includes('REPLACE_ME')
  );

  // ── Firebase init (only when configured) ───────────────────────────────
  const ownerKey = OWNER_EMAIL.trim().toLowerCase();
  let app, auth, db;
  if (configReady) {
    app  = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db   = getFirestore(app);
  }

  // ── Configuration ──────────────────────────────────────────────────────
  const COLUMNS = [
    { id: 'todo',     title: 'To Do',       accent: '#97a0af' },
    { id: 'progress', title: 'In Progress', accent: '#4f46e5' },
    { id: 'review',   title: 'In Review',   accent: '#f5a524' },
    { id: 'done',     title: 'Done',        accent: '#30a46c' },
  ];
  const STATUS = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));
  const STATUS_PROGRESS = { todo: 0, progress: 50, review: 80, done: 100 };

  const AVATAR_COLORS = ['#e5484d', '#4f46e5', '#30a46c', '#f5a524', '#8b5cf6', '#0ea5e9', '#d6409f'];
  const DAY_MS    = 86400000;
  const DAY_WIDTH = 38;

  // ── App state ──────────────────────────────────────────────────────────
  let state = { members: [], tasks: [], areas: [] };
  let currentUser = null;          // { email, name, photo, role }
  let filterMember = null;         // member id (== email key) or null
  let filterArea = null;           // area id or null
  let view = 'board';              // 'board' (by status) | 'area' | 'timeline'
  const collapsed = new Set();      // timeline: collapsed subtask rows
  const expandedCards = new Set();  // board: which cards are expanded
  let DEMO = false;                 // no-backend UI preview mode
  let unsubTasks = null;
  let unsubUsers = null;
  let unsubAreas = null;

  // Sample data for the no-backend UI preview (DEMO mode only).
  const SEED = {
    members: [
      { id: 'm1', name: 'Aisha Khan' },
      { id: 'm2', name: 'Ben Ortiz' },
      { id: 'm3', name: 'Chen Wei' },
      { id: 'm4', name: 'Dara Singh' },
    ],
    areas: [
      { id: 'a-design', name: 'Design',         createdAt: 1 },
      { id: 'a-fe',     name: 'Frontend',       createdAt: 2 },
      { id: 'a-be',     name: 'Backend',        createdAt: 3 },
      { id: 'a-infra',  name: 'Infrastructure', createdAt: 4 },
    ],
    tasks: [
      { id: 't1', title: 'Define MVP scope', desc: 'Agree the feature cut for v1 with the team.', area: 'a-design', assignee: 'm1', reviewer: 'm3', priority: 'high', status: 'done', start: '2026-05-26', due: '2026-05-29', paused: false, subtasks: [] },
      { id: 't2', title: 'Wireframe the board UI', desc: 'Low-fi mockups for the Kanban layout.', area: 'a-design', assignee: 'm3', reviewer: 'm1', priority: 'medium', status: 'done', start: '2026-05-28', due: '2026-06-02', paused: false, subtasks: [] },
      { id: 't3', title: 'Set up component library', desc: 'Buttons, cards, modal, form fields.', area: 'a-fe', assignee: 'm2', reviewer: 'm3', priority: 'medium', status: 'progress', start: '2026-06-03', due: '2026-06-12', paused: false, subtasks: [
        { id: 's1', title: 'Buttons', done: true },
        { id: 's2', title: 'Card + badge', done: true },
        { id: 's3', title: 'Modal + form fields', done: false },
        { id: 's4', title: 'Avatars', done: false },
      ] },
      { id: 't4', title: 'Drag-and-drop between lanes', desc: 'Move cards across status columns.', area: 'a-fe', assignee: 'm2', reviewer: 'm1', priority: 'high', status: 'progress', start: '2026-06-04', due: '2026-06-10', paused: false, subtasks: [
        { id: 's5', title: 'dragstart / dragend', done: true },
        { id: 's6', title: 'drop updates status', done: false },
      ] },
      { id: 't5', title: 'Build sync API', desc: 'Endpoints to persist tasks.', area: 'a-be', assignee: 'm4', reviewer: 'm2', priority: 'high', status: 'review', start: '2026-06-06', due: '2026-06-15', paused: false, subtasks: [] },
      { id: 't6', title: 'Provision hosting + CI', desc: 'Pages deploy + workflow.', area: 'a-infra', assignee: 'm1', reviewer: null, priority: 'low', status: 'todo', start: '2026-06-09', due: '2026-06-13', paused: false, subtasks: [] },
      { id: 't7', title: 'Write onboarding copy', desc: 'Empty states and first-run hints.', area: null, assignee: 'm3', reviewer: null, priority: 'low', status: 'todo', start: '2026-06-10', due: '2026-06-16', paused: false, subtasks: [] },
    ],
  };

  // ── Date helpers ─────────────────────────────────────────────────────
  const parseDate = (s) => (s ? new Date(s + 'T00:00:00') : null);
  const toISO = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  const dayIndex = (from, d) => Math.round((d - from) / DAY_MS);
  const todayMidnight = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };

  // ── Generic helpers ────────────────────────────────────────────────────
  const memberById = (id) => state.members.find((m) => m.id === id);
  const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const colorFor = (id) => {
    const idx = state.members.findIndex((m) => m.id === id);
    return AVATAR_COLORS[(idx < 0 ? 0 : idx) % AVATAR_COLORS.length];
  };
  const uid = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const sid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  const aid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  // ── Areas (generic task classification) ────────────────────────────────
  const AREA_COLORS = ['#4f46e5', '#0ea5e9', '#30a46c', '#f5a524', '#8b5cf6', '#e5484d', '#d6409f', '#0891b2', '#65a30d', '#c2410c'];
  const areaById = (id) => state.areas.find((a) => a.id === id);
  const areaName = (id) => areaById(id)?.name ?? '';
  const areaColor = (id) => {
    const i = state.areas.findIndex((a) => a.id === id);
    return AREA_COLORS[(i < 0 ? 0 : i) % AREA_COLORS.length];
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

  const visibleTasks = () => state.tasks.filter((t) =>
    (!filterMember || t.assignee === filterMember) &&
    (!filterArea || (t.area || null) === filterArea));

  function taskProgress(t) {
    const subs = t.subtasks || [];
    if (subs.length) return Math.round((subs.filter((s) => s.done).length / subs.length) * 100);
    return STATUS_PROGRESS[t.status] ?? 0;
  }

  function toggleCollapse(taskId) {
    collapsed.has(taskId) ? collapsed.delete(taskId) : collapsed.add(taskId);
    render();
  }

  function toggleCard(taskId) {
    expandedCards.has(taskId) ? expandedCards.delete(taskId) : expandedCards.add(taskId);
    render();
  }

  // ── Firestore writes ─────────────────────────────────────────────────
  function normalizeTask(t) {
    return {
      title:    t.title || '',
      desc:     t.desc || '',
      area:     t.area || null,
      assignee: t.assignee || null,
      reviewer: t.reviewer || null,
      priority: t.priority || 'medium',
      status:   t.status || 'todo',
      start:    t.start || toISO(todayMidnight()),
      due:      t.due || '',
      paused:   !!t.paused,
      subtasks: (t.subtasks || []).map((s) => ({ id: s.id, title: s.title, done: !!s.done })),
    };
  }

  async function createTask(data) {
    const id = uid();
    if (DEMO) { state.tasks.push({ id, ...normalizeTask(data), createdAt: Date.now() }); render(); return; }
    try {
      await setDoc(doc(db, 'tasks', id), { ...normalizeTask(data), createdAt: Date.now() });
    } catch (e) { toast('Could not save task: ' + e.message); }
  }
  async function updateTask(id, data) {
    if (DEMO) { const t = state.tasks.find((x) => x.id === id); if (t) Object.assign(t, normalizeTask(data)); render(); return; }
    try {
      await setDoc(doc(db, 'tasks', id), normalizeTask(data), { merge: true });
    } catch (e) { toast('Could not save task: ' + e.message); }
  }
  async function removeTask(id) {
    if (DEMO) { state.tasks = state.tasks.filter((t) => t.id !== id); render(); return; }
    try { await deleteDoc(doc(db, 'tasks', id)); }
    catch (e) { toast('Could not delete task: ' + e.message); }
  }

  async function setSubtaskDone(taskId, subId, done) {
    const t = state.tasks.find((x) => x.id === taskId);
    if (!t) return;
    const subs = (t.subtasks || []).map((s) => (s.id === subId ? { ...s, done } : s));
    if (DEMO) { t.subtasks = subs; render(); return; }
    try { await setDoc(doc(db, 'tasks', taskId), { subtasks: subs }, { merge: true }); }
    catch (e) { toast('Could not update subtask: ' + e.message); }
  }

  async function moveTask(id, status) {
    if (DEMO) { const t = state.tasks.find((x) => x.id === id); if (t) t.status = status; render(); return; }
    try { await setDoc(doc(db, 'tasks', id), { status }, { merge: true }); }
    catch (e) { toast('Could not move task: ' + e.message); }
  }

  async function setTaskArea(id, area) {
    if (DEMO) { const t = state.tasks.find((x) => x.id === id); if (t) t.area = area; render(); return; }
    try { await setDoc(doc(db, 'tasks', id), { area }, { merge: true }); }
    catch (e) { toast('Could not move task: ' + e.message); }
  }

  // ── Area writes ─────────────────────────────────────────────────────────
  function afterAreaChange() {
    if (!$('#areas-overlay').classList.contains('hidden')) renderAreaList();
    render();
  }
  async function createArea(name) {
    const id = aid();
    if (DEMO) { state.areas.push({ id, name, createdAt: Date.now() }); afterAreaChange(); return; }
    try { await setDoc(doc(db, 'areas', id), { name, createdAt: Date.now() }); }
    catch (e) { toast('Could not add area: ' + e.message); }
  }
  async function renameArea(id, name) {
    if (DEMO) { const a = areaById(id); if (a) a.name = name; afterAreaChange(); return; }
    try { await setDoc(doc(db, 'areas', id), { name }, { merge: true }); }
    catch (e) { toast('Could not rename area: ' + e.message); }
  }
  async function removeArea(area) {
    if (!confirm(`Delete area “${area.name}”? Tasks in it become Unclassified (their other details stay).`)) return;
    if (filterArea === area.id) filterArea = null;
    if (DEMO) { state.areas = state.areas.filter((a) => a.id !== area.id); afterAreaChange(); return; }
    try { await deleteDoc(doc(db, 'areas', area.id)); }
    catch (e) { toast('Could not delete area: ' + e.message); }
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

  function renderAreaStrip() {
    const strip = $('#area-strip');
    strip.innerHTML = '';
    if (!state.areas.length) {
      const hint = document.createElement('span');
      hint.className = 'area-empty';
      hint.textContent = 'No areas yet';
      strip.appendChild(hint);
      return;
    }
    state.areas.forEach((a) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'area-chip' + (filterArea === a.id ? ' active' : '');
      chip.innerHTML = `<span class="area-dot" style="background:${areaColor(a.id)}"></span>${escapeHtml(a.name)}`;
      chip.addEventListener('click', () => {
        filterArea = (filterArea === a.id) ? null : a.id;
        render();
      });
      strip.appendChild(chip);
    });
  }

  function renderFilterBanner() {
    const banner = $('#filter-banner');
    const parts = [];
    if (filterMember) parts.push(memberById(filterMember)?.name ?? '');
    if (filterArea)   parts.push(areaName(filterArea));
    if (parts.length) {
      $('#filter-name').textContent = parts.filter(Boolean).join(' · ');
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  // ── Board view ───────────────────────────────────────────────────────
  // Columns depend on the current grouping: by status (default) or by area.
  function boardColumns() {
    if (view === 'area') {
      const cols = state.areas.map((a) => ({ id: a.id, title: a.name, accent: areaColor(a.id) }));
      cols.push({ id: '__none', title: 'Unclassified', accent: '#97a0af' });
      return cols;
    }
    return COLUMNS;
  }

  function renderBoard() {
    const board = $('#board');
    board.innerHTML = '';
    const byArea = view === 'area';

    if (byArea && !state.areas.length) {
      board.innerHTML = '<p class="col-empty" style="padding:2rem">No areas yet — add some with “＋ Manage areas”.</p>';
      return;
    }

    const visible = visibleTasks();
    const taskInCol = (t, col) => byArea ? ((t.area || '__none') === col.id) : (t.status === col.id);

    boardColumns().forEach((col) => {
      const tasks = visible.filter((t) => taskInCol(t, col));

      const column = document.createElement('section');
      column.className = 'column';
      column.dataset.col = col.id;

      const head = document.createElement('div');
      head.className = 'column-head';
      head.innerHTML = `
        <span class="column-title"><span class="col-accent" style="background:${col.accent}"></span>${escapeHtml(col.title)}</span>
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
        if (!task) return;
        if (byArea) {
          const newArea = col.id === '__none' ? null : col.id;
          if ((task.area || null) !== newArea) setTaskArea(id, newArea);
        } else if (task.status !== col.id) {
          moveTask(id, col.id);
        }
      });

      board.appendChild(column);
    });
  }

  function cardEl(t) {
    const card = document.createElement('article');
    const isOpen = expandedCards.has(t.id);
    card.className = 'card' + (t.paused ? ' paused' : '') + (isOpen ? ' expanded' : '');
    card.draggable = true;

    const due = fmtDue(t.due);
    const subs = t.subtasks || [];
    const doneSubs = subs.filter((s) => s.done).length;
    const pct = taskProgress(t);

    // Top row: title + priority/paused badges + expand chevron (always shown).
    card.innerHTML = `
      <div class="card-top">
        <span class="card-title">${escapeHtml(t.title)}</span>
        <span class="card-tags">
          ${t.paused ? '<span class="paused-badge">⏸ Paused</span>' : ''}
          <span class="badge ${t.priority}">${t.priority}</span>
          <span class="card-chev">${isOpen ? '▾' : '▸'}</span>
        </span>
      </div>`;

    // Details (description + subtask checklist) only when expanded.
    if (isOpen) {
      if (t.desc) {
        const d = document.createElement('p');
        d.className = 'card-desc card-desc-full';
        d.textContent = t.desc;
        card.appendChild(d);
      }
      if (subs.length) {
        const mini = document.createElement('div');
        mini.className = 'mini-bar';
        mini.innerHTML = `<span style="width:${pct}%"></span>`;
        card.appendChild(mini);

        const ul = document.createElement('ul');
        ul.className = 'card-subtasks';
        ul.addEventListener('click', (e) => e.stopPropagation());  // don't collapse the card
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
        card.appendChild(ul);
      }
    }

    // Footer: assignee + reviewer · (subtask pill when collapsed) · due · Edit (open).
    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.appendChild(avatarEl(t.assignee, { sm: true }));
    const rchip = reviewerChip(t.reviewer);
    if (rchip) meta.appendChild(rchip);
    foot.appendChild(meta);

    const right = document.createElement('div');
    right.className = 'card-foot-right';
    // Cross-context chip: show the area when grouped by status, the status when
    // grouped by area, so the other dimension is always visible at a glance.
    if (view === 'area') {
      const s = STATUS[t.status];
      if (s) {
        const chip = document.createElement('span');
        chip.className = 'meta-chip';
        chip.style.color = s.accent;
        chip.style.background = s.accent + '1f';
        chip.textContent = s.title;
        right.appendChild(chip);
      }
    } else if (t.area && areaById(t.area)) {
      const chip = document.createElement('span');
      chip.className = 'meta-chip';
      chip.style.color = areaColor(t.area);
      chip.style.background = areaColor(t.area) + '1f';
      chip.textContent = areaName(t.area);
      right.appendChild(chip);
    }
    if (subs.length && !isOpen) {
      const pill = document.createElement('span');
      pill.className = 'st-pill' + (doneSubs === subs.length ? ' complete' : '');
      pill.textContent = `☑ ${doneSubs}/${subs.length}`;
      right.appendChild(pill);
    }
    if (due) {
      const dueEl = document.createElement('span');
      dueEl.className = 'due ' + (due.overdue ? 'overdue' : '');
      dueEl.textContent = '📅 ' + due.label;
      right.appendChild(dueEl);
    }
    if (isOpen) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn-edit';
      edit.textContent = 'Edit';
      edit.addEventListener('click', (e) => { e.stopPropagation(); openModal(t); });
      right.appendChild(edit);
    }
    foot.appendChild(right);
    card.appendChild(foot);

    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', t.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', () => toggleCard(t.id));
    return card;
  }

  // ── Timeline (Gantt) view ──────────────────────────────────────────────
  function taskSpan(t) {
    const start = parseDate(t.start) || todayMidnight();
    const end   = parseDate(t.due) || start;
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
      bar.style.background = color + '33';
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

  // ── Task modal ──────────────────────────────────────────────────────────
  const overlay = $('#modal-overlay');
  let modalSubtasks = [];

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
    input.focus();
  }

  function fillSelects() {
    const people = state.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
    $('#f-assignee').innerHTML = '<option value="">Unassigned</option>' + people;
    $('#f-reviewer').innerHTML = '<option value="">No reviewer</option>' + people;
    $('#f-status').innerHTML = COLUMNS.map((c) => `<option value="${c.id}">${c.title}</option>`).join('');
    $('#f-area').innerHTML = '<option value="">Unclassified</option>' +
      state.areas.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  }

  function openModal(task) {
    fillSelects();
    const isEdit = !!task;
    $('#modal-title').textContent = isEdit ? 'Edit task' : 'New task';
    $('#task-id').value    = isEdit ? task.id : '';
    $('#f-title').value    = isEdit ? task.title : '';
    $('#f-desc').value     = isEdit ? task.desc : '';
    $('#f-area').value     = isEdit ? (task.area || '') : (view === 'area' && filterArea ? filterArea : '');
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

  // ── Admin: manage users ─────────────────────────────────────────────────
  const adminOverlay = $('#admin-overlay');

  function openAdmin() {
    if (currentUser?.role !== 'admin') return;
    $('#admin-error').classList.add('hidden');
    $('#add-user-form').reset();
    renderUserList();
    adminOverlay.classList.remove('hidden');
    $('#u-email').focus();
  }
  const closeAdmin = () => adminOverlay.classList.add('hidden');

  function renderUserList() {
    const list = $('#user-list');
    list.innerHTML = '';
    if (!state.members.length) {
      list.innerHTML = '<li class="user-empty">No users yet.</li>';
      return;
    }
    state.members.forEach((m) => {
      const li = document.createElement('li');
      li.className = 'user-row';

      const av = avatarEl(m.id, { sm: true });
      const info = document.createElement('div');
      info.className = 'user-info';
      info.innerHTML =
        `<span class="user-row-name">${escapeHtml(m.name)}</span>` +
        `<span class="user-row-email">${escapeHtml(m.email)}</span>`;

      const right = document.createElement('div');
      right.className = 'user-row-right';

      const roleSel = document.createElement('select');
      roleSel.className = 'role-select';
      roleSel.innerHTML = '<option value="member">Member</option><option value="admin">Admin</option>';
      roleSel.value = m.role;
      const isSelf  = m.id === currentUser.email;
      const isOwner = m.id === ownerKey;
      roleSel.disabled = isOwner;                       // owner stays admin
      roleSel.addEventListener('change', () => changeRole(m, roleSel.value));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn user-del';
      del.textContent = '🗑';
      del.title = isOwner ? 'The owner can’t be removed' : (isSelf ? 'You can’t remove yourself' : 'Remove user');
      del.disabled = isOwner || isSelf;
      del.addEventListener('click', () => removeUser(m));

      right.append(roleSel, del);
      li.append(av, info, right);
      if (isSelf) {
        const you = document.createElement('span');
        you.className = 'you-tag';
        you.textContent = 'you';
        info.appendChild(you);
      }
      list.appendChild(li);
    });
  }

  async function addUser(e) {
    e.preventDefault();
    const email = $('#u-email').value.trim().toLowerCase();
    const name  = $('#u-name').value.trim();
    const role  = $('#u-role').value;
    const err = $('#admin-error');
    err.classList.add('hidden');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      err.textContent = 'Enter a valid email address.';
      err.classList.remove('hidden');
      return;
    }
    try {
      await setDoc(doc(db, 'allowedUsers', email), {
        email,
        name: name || email.split('@')[0],
        role,
        addedBy: currentUser.email,
        addedAt: Date.now(),
      });
      $('#add-user-form').reset();
      $('#u-email').focus();
    } catch (e2) {
      err.textContent = 'Could not add user: ' + e2.message;
      err.classList.remove('hidden');
    }
  }

  async function changeRole(member, role) {
    try { await setDoc(doc(db, 'allowedUsers', member.id), { role }, { merge: true }); }
    catch (e) { toast('Could not change role: ' + e.message); renderUserList(); }
  }

  async function removeUser(member) {
    if (!confirm(`Remove ${member.name} (${member.email})? They will lose access.`)) return;
    try { await deleteDoc(doc(db, 'allowedUsers', member.id)); }
    catch (e) { toast('Could not remove user: ' + e.message); }
  }

  // ── Areas: manage modal ─────────────────────────────────────────────────
  const areasOverlay = $('#areas-overlay');

  function openAreas() {
    $('#areas-error').classList.add('hidden');
    $('#add-area-form').reset();
    renderAreaList();
    areasOverlay.classList.remove('hidden');
    $('#a-name').focus();
  }
  const closeAreas = () => areasOverlay.classList.add('hidden');

  function renderAreaList() {
    const list = $('#area-list');
    list.innerHTML = '';
    if (!state.areas.length) {
      list.innerHTML = '<li class="user-empty">No areas yet.</li>';
      return;
    }
    state.areas.forEach((a) => {
      const li = document.createElement('li');
      li.className = 'user-row';

      const dot = document.createElement('span');
      dot.className = 'area-dot lg';
      dot.style.background = areaColor(a.id);

      const input = document.createElement('input');
      input.className = 'area-rename';
      input.value = a.name;
      input.addEventListener('change', () => {
        const v = input.value.trim();
        if (v && v !== a.name) renameArea(a.id, v); else input.value = a.name;
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn user-del';
      del.textContent = '🗑';
      del.title = 'Delete area';
      del.addEventListener('click', () => removeArea(a));

      li.append(dot, input, del);
      list.appendChild(li);
    });
  }

  async function addArea(e) {
    e.preventDefault();
    const name = $('#a-name').value.trim();
    const err = $('#areas-error');
    err.classList.add('hidden');
    if (!name) return;
    if (state.areas.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      err.textContent = 'That area already exists.';
      err.classList.remove('hidden');
      return;
    }
    await createArea(name);
    $('#add-area-form').reset();
    $('#a-name').focus();
  }

  // ── Live subscriptions ──────────────────────────────────────────────────
  function subscribe() {
    unsubUsers = onSnapshot(collection(db, 'allowedUsers'), (snap) => {
      state.members = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0) || a.name.localeCompare(b.name));
      // If the current user's row was deleted while they're online, kick them out.
      if (currentUser && currentUser.email !== ownerKey &&
          !state.members.some((m) => m.id === currentUser.email)) {
        toast('Your access was removed.');
        signOut(auth);
        return;
      }
      if (!adminOverlay.classList.contains('hidden')) renderUserList();
      render();
    }, (err) => toast('Lost connection to users: ' + err.message));

    unsubTasks = onSnapshot(collection(db, 'tasks'), (snap) => {
      state.tasks = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .map((t) => ({ ...t, subtasks: Array.isArray(t.subtasks) ? t.subtasks : [] }))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      render();
    }, (err) => toast('Lost connection to tasks: ' + err.message));

    unsubAreas = onSnapshot(collection(db, 'areas'), (snap) => {
      state.areas = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.name.localeCompare(b.name));
      if (!areasOverlay.classList.contains('hidden')) renderAreaList();
      render();
    }, (err) => toast('Lost connection to areas: ' + err.message));
  }

  function unsubscribe() {
    if (unsubTasks) { unsubTasks(); unsubTasks = null; }
    if (unsubUsers) { unsubUsers(); unsubUsers = null; }
    if (unsubAreas) { unsubAreas(); unsubAreas = null; }
    state = { members: [], tasks: [], areas: [] };
  }

  // ── Render orchestration ─────────────────────────────────────────────────
  function render() {
    if (!currentUser) return;
    renderTeam();
    renderAreaStrip();
    renderFilterBanner();

    const isTimeline = view === 'timeline';
    $('#board-view').classList.toggle('hidden', isTimeline);
    $('#timeline-view').classList.toggle('hidden', !isTimeline);
    $$('#view-switch .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

    if (isTimeline) renderTimeline();
    else            renderBoard();
  }

  // ── User chip ─────────────────────────────────────────────────────────
  function paintUserChip() {
    const av = $('#user-avatar');
    av.innerHTML = '';
    av.style.background = '';
    if (currentUser.photo) {
      av.style.backgroundImage = `url(${currentUser.photo})`;
      av.style.backgroundSize = 'cover';
    } else {
      av.textContent = initials(currentUser.name || currentUser.email);
      av.style.background = AVATAR_COLORS[1];
    }
    $('#user-name').textContent = currentUser.name || currentUser.email;
    $('#admin-btn').classList.toggle('hidden', currentUser.role !== 'admin');
  }

  // ── No-backend UI preview (DEMO) ─────────────────────────────────────────
  function startDemo() {
    DEMO = true;
    currentUser = { email: 'demo', name: 'Demo user', photo: '', role: 'member' };
    state = structuredClone(SEED);
    filterMember = null;
    paintUserChip();
    $('#admin-btn').classList.add('hidden');
    const sub = document.querySelector('.brand-sub');
    if (sub) sub.textContent = 'Team board · UI preview (no backend)';
    showScreen('app');
    render();
  }

  // ── Auth flow ───────────────────────────────────────────────────────────
  async function resolveAccess(user) {
    const key = user.email.trim().toLowerCase();

    // Bootstrap: make sure the owner always has an admin row to sign in against.
    if (key === ownerKey) {
      try {
        const ref = doc(db, 'allowedUsers', key);
        const snap = await getDoc(ref);
        if (!snap.exists() || snap.data().role !== 'admin') {
          await setDoc(ref, {
            email: key,
            name: user.displayName || key.split('@')[0],
            role: 'admin',
            addedBy: 'bootstrap',
            addedAt: snap.exists() ? (snap.data().addedAt || Date.now()) : Date.now(),
          }, { merge: true });
        }
      } catch (e) { /* rules allow this for the owner; ignore transient errors */ }
    }

    let allowed = key === ownerKey;
    let role = 'admin';
    if (!allowed) {
      try {
        const snap = await getDoc(doc(db, 'allowedUsers', key));
        if (snap.exists()) { allowed = true; role = snap.data().role || 'member'; }
      } catch (e) { /* not allowed → read denied by rules */ }
    }

    if (!allowed) {
      $('#denied-email').textContent = user.email;
      showScreen('denied');
      return;
    }

    currentUser = { email: key, name: user.displayName || key, photo: user.photoURL || '', role };
    paintUserChip();
    subscribe();
    showScreen('app');
  }

  // Decide the initial screen: config gate (with preview escape hatch) when the
  // backend isn't set up, otherwise resolve auth state.
  if (configReady) {
    onAuthStateChanged(auth, (user) => {
      unsubscribe();
      currentUser = null;
      if (user) {
        resolveAccess(user);
      } else {
        showScreen('signin');
      }
    });
  } else {
    showScreen('config');
  }

  async function doSignIn() {
    const err = $('#signin-error');
    err.classList.add('hidden');
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
      err.textContent = e.code === 'auth/unauthorized-domain'
        ? 'This domain isn’t authorised in Firebase. Add it under Authentication → Settings → Authorized domains.'
        : 'Sign-in failed: ' + e.message;
      err.classList.remove('hidden');
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  $('#google-signin').addEventListener('click', doSignIn);
  $('#preview-ui')?.addEventListener('click', startDemo);
  $('#denied-signout').addEventListener('click', () => signOut(auth));
  $('#signout-btn').addEventListener('click', () => { if (DEMO) { location.reload(); return; } signOut(auth); });

  $('#admin-btn').addEventListener('click', openAdmin);
  $('#admin-close').addEventListener('click', closeAdmin);
  $('#add-user-form').addEventListener('submit', addUser);
  adminOverlay.addEventListener('click', (e) => { if (e.target === adminOverlay) closeAdmin(); });

  $('#manage-areas-btn').addEventListener('click', openAreas);
  $('#areas-close').addEventListener('click', closeAreas);
  $('#add-area-form').addEventListener('submit', addArea);
  areasOverlay.addEventListener('click', (e) => { if (e.target === areasOverlay) closeAreas(); });

  $('#add-task-btn').addEventListener('click', () => openModal(null));
  $('#modal-close').addEventListener('click', closeModal);
  $('#cancel-task').addEventListener('click', closeModal);
  $('#clear-filter').addEventListener('click', () => { filterMember = null; filterArea = null; render(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  $('#subtask-add-btn').addEventListener('click', addSubtask);
  $('#subtask-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addSubtask(); }
  });

  $('#task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('#task-id').value;
    const data = {
      title:    $('#f-title').value.trim(),
      desc:     $('#f-desc').value.trim(),
      area:     $('#f-area').value || null,
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
    if (id) updateTask(id, data); else createTask(data);
    closeModal();
  });

  $('#delete-task').addEventListener('click', () => {
    const id = $('#task-id').value;
    if (id && confirm('Delete this task?')) { removeTask(id); closeModal(); }
  });

  $('#view-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    view = btn.dataset.view;
    render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!overlay.classList.contains('hidden')) closeModal();
    else if (!adminOverlay.classList.contains('hidden')) closeAdmin();
    else if (!areasOverlay.classList.contains('hidden')) closeAreas();
  });

  // Boot screen stays until onAuthStateChanged fires the first time.
})();
