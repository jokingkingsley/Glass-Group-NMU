const state = {
  page: "overview", userId: localStorage.getItem("nmu-demo-user") || "u-catalina",
  data: null, projectId: null, projectTab: "overview", projectSearch: "", projectStatus: "all",
  projectFilters: { city: "all", state: "all", programType: "all", host: "all", manager: "all", dateFrom: "", dateTo: "", sort: "date-asc" },
  taskStatusFilter: "all", taskSearch: "", myTaskFilter: "All tasks", taskSort: "due-asc", authRequired: false,
  calendar: { view: "month", cursor: new Date().toISOString().slice(0, 10), programId: "all" },
  administratorConfigured: false, accountUsers: [], airtableSync: null,
  airtableData: { tables: [], selectedTableId: null, records: [], recordLabels: {}, total: 0, offset: 0, limit: 25, query: "", loading: false }
};
const content = document.getElementById("content");
const modalRoot = document.getElementById("modal-root");
const toastEl = document.getElementById("toast");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const dateLabel = (value, options = { month: "short", day: "numeric", year: "numeric" }) => {
  if (!value) return "—";
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, options).format(new Date(year, month - 1, day));
};
const initials = (name = "") => name.split(/\s+/).map((part) => part[0] || "").slice(0, 2).join("").toUpperCase();
const userRole = () => state.data?.currentUser?.role || "employee";
const isManager = () => ["admin", "program_manager"].includes(userRole());
const isAdmin = () => userRole() === "admin";
const today = () => new Date().toISOString().slice(0, 10);
const dayDiff = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86400000);
const isOverdue = (task) => task.status !== "Completed" && task.dueDate < today();
const projectById = (id) => state.data?.projects.find((project) => project.id === id);
const tasksForProject = (projectId) => state.data?.tasks.filter((task) => task.projectId === projectId) || [];
function showToast(message, error = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", error);
  toastEl.classList.add("show");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toastEl.classList.remove("show"), 3200);
}
async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (!state.authRequired) headers["x-demo-user"] = state.userId;
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.prerequisites?.length
      ? `${body.error} Prerequisites: ${body.prerequisites.join(", ")}`
      : body.error || `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return body;
}
async function refresh() {
  try {
    const config = await api("/api/auth/config");
    state.authRequired = config.required;
    state.administratorConfigured = config.administratorConfigured;
    state.data = await api("/api/bootstrap");
    if (state.authRequired) state.userId = state.data.currentUser.id;
    state.accountUsers = state.authRequired && state.data.currentUser.role === "admin"
      ? (await api("/api/users")).users
      : [];
    document.body.classList.remove("auth-screen");
    render();
  } catch (error) {
    if (state.authRequired && error.message === "Sign in to continue.") {
      state.data = null;
      renderLogin();
      return;
    }
    content.innerHTML = `<div class="inline-error">Could not load the workspace: ${escapeHtml(error.message)}</div>`;
  }
}
function renderLogin(message = "") {
  document.body.classList.add("auth-screen");
  modalRoot.innerHTML = "";
  content.innerHTML = `<section class="login-card" aria-labelledby="login-title"><img class="login-logo" src="/nmu-logo.png" alt="No More Under" width="180" height="78"><div class="eyebrow">NMU PROGRAM OPERATIONS</div><h1 id="login-title">Sign in to your workspace</h1><p class="heading-copy">Use the NMU account created for you by an administrator.</p>
    ${!state.administratorConfigured?`<div class="inline-error">No administrator account is configured yet. Set <span class="code">NMU_ADMIN_EMAIL</span> and <span class="code">NMU_ADMIN_PASSWORD</span> in Railway Variables, then redeploy.</div>`:""}
    ${message?`<div class="inline-error">${escapeHtml(message)}</div>`:""}
    <form id="login-form"><div class="form-field"><label for="login-email">Email address</label><input id="login-email" name="email" type="email" autocomplete="username" required></div><div class="form-field"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required></div><button class="button primary" type="submit" ${state.administratorConfigured?"":"disabled"}>Sign in</button></form>
  </section>`;
}
function setNavigation(page) {
  if (page === "airtable-data" && !isAdmin()) return;
  state.page = page;
  state.projectId = null;
  document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item.dataset.nav === page));
  document.querySelectorAll(".mobile-bottom button").forEach((item) => item.classList.toggle("active", item.dataset.nav === page));
  render();
  if (page === "airtable-data") loadAirtableTables();
}
function statusBadge(status, overdue = false) {
  const value = overdue ? "Overdue" : status || "Planning";
  const className = value.toLowerCase().replaceAll(" ", "-");
  return `<span class="badge ${escapeHtml(className)}">${escapeHtml(value)}</span>`;
}
function priorityLabel(priority) {
  return `<span class="priority ${escapeHtml((priority || "medium").toLowerCase())}">${escapeHtml(priority || "Medium")}</span>`;
}
function progressMarkup(progress) {
  return `<div class="progress-wrap"><span class="progress-track"><span style="width:${Math.min(100, Math.max(0, progress))}%"></span></span><span class="progress-number">${progress}%</span></div>`;
}
function pageHeading(eyebrow, title, description, actions = "") {
  return `<header class="page-heading"><div><div class="eyebrow">${escapeHtml(eyebrow)}</div><h1>${escapeHtml(title)}</h1><p class="heading-copy">${escapeHtml(description)}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ""}</header>`;
}
function statCard(label, value, note, icon, tone = "") {
  return `<article class="stat-card"><div class="stat-top"><span>${escapeHtml(label)}</span><span class="stat-icon ${tone}">${icon}</span></div><div class="stat-value">${escapeHtml(value)}</div><div class="stat-foot">${escapeHtml(note)}</div></article>`;
}
function projectTable(projects) {
  if (!projects.length) return `<div class="empty-state"><span class="empty-mark">▦</span><strong>No programs match</strong>Adjust your search or filters to see programs.</div>`;
  return `<div class="table-wrap"><table class="project-table"><thead><tr><th>Program</th><th>Location</th><th>Start date</th><th>Project manager</th><th>Progress</th><th>Status</th></tr></thead><tbody>${projects.map((project) => `
    <tr>
      <td><button class="project-link" data-project="${escapeHtml(project.id)}">${escapeHtml(project.name)}</button><span class="secondary-cell">${escapeHtml(project.programType)} · ${escapeHtml(project.hostOrganization || "Host not set")}</span></td>
      <td>${escapeHtml(project.location)}</td>
      <td>${dateLabel(project.startDate,{month:"short",day:"numeric"})}</td>
      <td>${escapeHtml(project.projectManagerName || "—")}</td>
      <td>${progressMarkup(project.progress)}</td>
      <td>${statusBadge(project.status)}</td>
    </tr>`).join("")}</tbody></table></div>`;
}
function locationParts(location = "") {
  const [city, ...stateParts] = String(location).split(",");
  return { city: city.trim(), state: stateParts.join(",").trim() };
}
function projectFilterOptions(values, selected) {
  return [`<option value="all">All</option>`, ...[...new Set(values.filter(Boolean))].sort((a,b)=>a.localeCompare(b))
    .map((value)=>`<option value="${escapeHtml(value)}" ${selected===value?"selected":""}>${escapeHtml(value)}</option>`)].join("");
}
function projectFiltersMarkup() {
  const projects = state.data.projects;
  const cities = projects.map((project)=>locationParts(project.location).city);
  const states = projects.map((project)=>locationParts(project.location).state);
  const selects = [
    ["city","City",cities],
    ["state","State",states],
    ["programType","Program type",projects.map((project)=>project.programType)],
    ["host","Host organization",projects.map((project)=>project.hostOrganization)],
    ["manager","Project manager",projects.map((project)=>project.projectManagerName)]
  ];
  return `<details class="project-filters"><summary>More filters and sorting</summary><div class="project-filter-grid">
    ${selects.map(([key,label,values])=>`<label class="compact-filter">${escapeHtml(label)}<select data-project-filter="${key}">${projectFilterOptions(values,state.projectFilters[key])}</select></label>`).join("")}
    <label class="compact-filter">Start date from<input type="date" data-project-filter="dateFrom" value="${escapeHtml(state.projectFilters.dateFrom)}"></label>
    <label class="compact-filter">Start date to<input type="date" data-project-filter="dateTo" value="${escapeHtml(state.projectFilters.dateTo)}"></label>
    <label class="compact-filter">Sort by<select data-project-filter="sort">${[
      ["date-asc","Start date (earliest)"],["date-desc","Start date (latest)"],["name-asc","Program name"],["progress-desc","Progress"],["manager-asc","Project manager"]
    ].map(([value,label])=>`<option value="${value}" ${state.projectFilters.sort===value?"selected":""}>${label}</option>`).join("")}</select></label>
    <button class="button small ghost filter-clear" data-action="clear-project-filters">Clear filters</button>
  </div></details>`;
}
function filteredProjects() {
  const query = state.projectSearch.trim().toLowerCase();
  const filters = state.projectFilters;
  const result = [...state.data.projects].filter((project) => {
    const matchesText = !query || [project.name, project.location, project.projectManagerName, project.hostOrganization].some((value) => (value || "").toLowerCase().includes(query));
    const matchesStatus = state.projectStatus === "all" || project.status === state.projectStatus;
    const parts = locationParts(project.location);
    return matchesText && matchesStatus
      && (filters.city === "all" || parts.city === filters.city)
      && (filters.state === "all" || parts.state === filters.state)
      && (filters.programType === "all" || project.programType === filters.programType)
      && (filters.host === "all" || project.hostOrganization === filters.host)
      && (filters.manager === "all" || project.projectManagerName === filters.manager)
      && (!filters.dateFrom || project.startDate >= filters.dateFrom)
      && (!filters.dateTo || project.startDate <= filters.dateTo);
  });
  const comparators = {
    "date-asc": (a,b)=>a.startDate.localeCompare(b.startDate),
    "date-desc": (a,b)=>b.startDate.localeCompare(a.startDate),
    "name-asc": (a,b)=>a.name.localeCompare(b.name),
    "progress-desc": (a,b)=>b.progress-a.progress,
    "manager-asc": (a,b)=>(a.projectManagerName||"").localeCompare(b.projectManagerName||"")
  };
  return result.sort(comparators[filters.sort] || comparators["date-asc"]);
}
function renderOverview() {
  const projects = state.data.projects;
  const tasks = state.data.tasks;
  const active = projects.filter((project) => project.status !== "Completed");
  const overdue = tasks.filter(isOverdue);
  const dueSoon = tasks.filter((task) => task.status !== "Completed" && dayDiff(task.dueDate) >= 0 && dayDiff(task.dueDate) <= 7);
  const completed = projects.filter((project) => project.status === "Completed").length;
  const completion = tasks.length ? Math.round(tasks.filter((task) => task.status === "Completed").length / tasks.length * 100) : 0;
  const atRisk = projects.filter((project) => project.status === "At Risk");
  const soonTasks = [...tasks].filter((task) => task.status !== "Completed").sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 5);
  const actions = `${isManager()?`<button class="button primary" data-action="create-project">＋ Create program</button>`:""}<button class="button ghost" data-nav="settings">↗ Airtable</button>`;
  return `${pageHeading("PROGRAM OPERATIONS", `Good morning, ${state.data.currentUser.name.split(" ")[0] || "team"}.`, "A clear view of every swim program, from early planning through the final report.", actions)}
    <div class="stat-grid" aria-label="Organization summary">
      ${statCard("Active programs", active.length, `${projects.length} total programs`, "▦")}
      ${statCard("Tasks due this week", dueSoon.length, "Across programs you can access", "◷", "blue")}
      ${statCard("Overdue tasks", overdue.length, "Needs attention", "!", "red")}
      ${statCard("Overall completion", `${completion}%`, `${completed} completed program${completed===1?"":"s"}`, "✓")}
    </div>
    <div class="dashboard-grid">
      <section class="panel">
        <div class="panel-head"><div><h2 class="panel-title">Programs</h2><p class="panel-subtitle">A snapshot of active and upcoming work</p></div><div class="panel-actions"><input class="search-input" data-filter="project-search" placeholder="Search programs…" value="${escapeHtml(state.projectSearch)}" aria-label="Search programs"><select class="filter-select" data-filter="project-status" aria-label="Filter by program status"><option value="all">All statuses</option>${["On Track","At Risk","Planning","Completed"].map((item) => `<option ${state.projectStatus===item?"selected":""}>${item}</option>`).join("")}</select></div></div>
        ${projectFiltersMarkup()}${projectTable(filteredProjects())}
      </section>
      <div class="right-stack">
        <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Needs attention</h2><p class="panel-subtitle">Programs with risk indicators</p></div></div>${atRisk.length ? atRisk.map((project) => `<div class="compact-project" data-project="${escapeHtml(project.id)}"><strong>${escapeHtml(project.name)}</strong>${statusBadge(project.status)}<small>${project.progress}% complete · ${escapeHtml(project.location)}</small></div>`).join("") : `<div class="empty-state"><span class="empty-mark">✓</span><strong>All clear</strong>No at-risk programs right now.</div>`}</section>
        <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Next deadlines</h2><p class="panel-subtitle">Upcoming work across programs</p></div><button class="button small ghost" data-nav="timeline">View timeline</button></div>${soonTasks.length ? soonTasks.map((task) => `<div class="task-row"><div><button class="task-link" data-task="${escapeHtml(task.id)}">${escapeHtml(task.title)}</button><div class="task-row-meta">${escapeHtml(task.projectName)} · ${dateLabel(task.dueDate,{month:"short",day:"numeric"})}</div></div>${statusBadge(task.status,isOverdue(task))}</div>`).join("") : `<div class="empty-state">No upcoming deadlines.</div>`}</section>
      </div>
    </div>`;
}
function renderProjects() {
  const actions = isManager() ? `<button class="button primary" data-action="create-project">＋ Create program</button>` : "";
  return `${pageHeading("PROGRAMS", "All programs", "Search programs, review deadlines, and open a workspace to coordinate the team.", actions)}
    <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Program portfolio</h2><p class="panel-subtitle">${state.data.projects.length} organization-wide programs · ${filteredProjects().length} shown</p></div><div class="panel-actions"><input class="search-input" data-filter="project-search" placeholder="Search programs…" value="${escapeHtml(state.projectSearch)}" aria-label="Search programs"><select class="filter-select" data-filter="project-status" aria-label="Filter by program status"><option value="all">All statuses</option>${["On Track","At Risk","Planning","Completed"].map((item) => `<option value="${item}" ${state.projectStatus===item?"selected":""}>${item}</option>`).join("")}</select></div></div>${projectFiltersMarkup()}${projectTable(filteredProjects())}</section>`;
}
function taskRow(task, compact = false) {
  const overdue = isOverdue(task);
  const currentUserTask = task.assignedUserId === state.userId;
  const status = task.isBlocked ? "Blocked" : task.status;
  return `<div class="${compact ? "my-task" : "task-row"}">
    <div class="${compact ? "my-task-info" : ""}"><button class="task-link" data-task="${escapeHtml(task.id)}">${escapeHtml(task.title)}</button><small class="${compact ? "" : "task-row-meta"}">${escapeHtml(task.projectName)}${task.assigneeName && !compact ? ` · ${escapeHtml(task.assigneeName)}` : ""}${task.milestone ? ` · ${escapeHtml(task.milestone)}` : ""}</small></div>
    ${compact ? `<span class="${overdue?"my-task-date overdue-text":"my-task-date"}">${dateLabel(task.dueDate,{month:"short",day:"numeric"})}${overdue?" · late":""}</span><span>${priorityLabel(task.priority)}</span>${statusBadge(status,overdue)}` : statusBadge(status,overdue)}
  </div>`;
}
function renderMyTasks() {
  const all = state.data.tasks.filter((task) => task.assignedUserId === state.userId);
  const query = state.taskSearch.toLowerCase().trim();
  const searchable = all.filter((task) => !query || `${task.title} ${task.projectName} ${task.description}`.toLowerCase().includes(query));
  const groups = [
    ["Due soon", searchable.filter((task) => task.status !== "Completed" && dayDiff(task.dueDate) >= 0 && dayDiff(task.dueDate) <= 7)],
    ["Overdue", searchable.filter(isOverdue)],
    ["Blocked", searchable.filter((task) => task.isBlocked)],
    ["In progress", searchable.filter((task) => task.status === "In Progress" && !task.isBlocked && !isOverdue(task))],
    ["Not started", searchable.filter((task) => task.status === "Not Started" && !task.isBlocked && !isOverdue(task) && dayDiff(task.dueDate) > 7)],
    ["Completed", searchable.filter((task) => task.status === "Completed")]
  ];
  const selectedGroup = state.myTaskFilter;
  const visible = selectedGroup === "All tasks" ? groups : groups.filter(([name]) => name === selectedGroup);
  const priorityRank = { High: 0, Medium: 1, Low: 2 };
  const sortTasks = (tasks) => [...tasks].sort((a,b) => {
    switch (state.taskSort) {
      case "name-asc": return a.title.localeCompare(b.title);
      case "priority-desc": return (priorityRank[a.priority]??3)-(priorityRank[b.priority]??3) || a.dueDate.localeCompare(b.dueDate);
      case "status-asc": return a.status.localeCompare(b.status) || a.dueDate.localeCompare(b.dueDate);
      case "program-asc": return a.projectName.localeCompare(b.projectName) || a.dueDate.localeCompare(b.dueDate);
      default: return a.dueDate.localeCompare(b.dueDate);
    }
  });
  return `${pageHeading("PERSONAL WORKSPACE", "My tasks", `Your assigned work across ${new Set(all.map((task) => task.projectId)).size} program${new Set(all.map((task) => task.projectId)).size===1?"":"s"}. Update progress, review dependencies, and leave context for your team.`)}
    <div class="toolbar"><div class="filter-row">${["All tasks","Due soon","Overdue","Blocked","In progress","Not started","Completed"].map((label) => `<button class="button small ${state.myTaskFilter===label?"primary":"ghost"}" data-my-filter="${escapeHtml(label)}">${escapeHtml(label)}</button>`).join("")}</div><div class="task-toolbar-actions"><input class="search-input" data-filter="task-search" placeholder="Find a task…" value="${escapeHtml(state.taskSearch)}" aria-label="Search my tasks"><label class="compact-filter">Sort by<select data-filter="task-sort"><option value="due-asc" ${state.taskSort==="due-asc"?"selected":""}>Deadline</option><option value="name-asc" ${state.taskSort==="name-asc"?"selected":""}>Task name</option><option value="priority-desc" ${state.taskSort==="priority-desc"?"selected":""}>Priority</option><option value="status-asc" ${state.taskSort==="status-asc"?"selected":""}>Status</option><option value="program-asc" ${state.taskSort==="program-asc"?"selected":""}>Program</option></select></label></div></div>
    ${visible.map(([label, tasks]) => `<div class="section-label">${label} <span class="muted">(${tasks.length})</span></div>${tasks.length ? `<div class="task-list">${sortTasks(tasks).map((task) => taskRow(task,true)).join("")}</div>` : `<div class="task-list"><div class="empty-state"><strong>Nothing here right now</strong>${label==="Overdue"?"No overdue assigned work.":"Tasks will appear here as work is assigned."}</div></div>`}`).join("")}`;
}
function renderTimeline() {
  const tasks = state.data.tasks.filter((task) => task.status !== "Completed").sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const groups = new Map();
  for (const task of tasks) {
    const date = new Date(`${task.dueDate}T12:00:00`);
    const key = date.toLocaleDateString(undefined,{month:"long",year:"numeric"});
    groups.set(key,[...(groups.get(key)||[]),task]);
  }
  return `${pageHeading("SCHEDULE", "Program timeline", "A chronological view of upcoming work, grouped by month. Blocked and overdue tasks stay visible so teams can act early.")}
    <div class="dashboard-grid"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Upcoming deadlines</h2><p class="panel-subtitle">${tasks.length} open tasks · all accessible programs</p></div></div>${tasks.length ? [...groups.entries()].map(([month,items])=>`<div class="panel-head"><h3 class="panel-title">${escapeHtml(month)}</h3></div><div class="timeline-list">${items.map((task)=>`<div class="timeline-item ${isOverdue(task)?"overdue":""}"><time class="timeline-date">${dateLabel(task.dueDate,{month:"short",day:"numeric"})}</time><span class="timeline-marker"></span><div class="timeline-copy"><strong><button class="task-link" data-task="${escapeHtml(task.id)}">${escapeHtml(task.title)}</button></strong><small>${escapeHtml(task.projectName)} · ${escapeHtml(task.assigneeName || "Unassigned")} · ${escapeHtml(task.milestone)} · ${task.isBlocked?"Blocked by prerequisite":task.status}</small></div></div>`).join("")}</div>`).join("") : `<div class="empty-state"><strong>No open deadlines</strong>All tasks are complete.</div>`}</section><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Date changes</h2><p class="panel-subtitle">Preview and apply from a program workspace</p></div></div><div class="empty-state"><span class="empty-mark">◷</span><strong>Replan with a preview</strong>Open a program workspace and choose “Adjust dates” to preview how an updated program start date will shift outstanding tasks.</div></section></div>`;
}
// ---- Calendar ---------------------------------------------------------------
const CALENDAR_COLORS = [
  { soft: "#e8e9f6", text: "#2c3185", solid: "#2c3185" },
  { soft: "#e3f5fc", text: "#0b5874", solid: "#1586b4" },
  { soft: "#fbf0e2", text: "#7a4a0e", solid: "#b06a1c" },
  { soft: "#e9f0f7", text: "#2c4f70", solid: "#3f6d96" },
  { soft: "#f1ecf7", text: "#55407a", solid: "#7a5a9e" },
  { soft: "#fbeeee", text: "#8a3a33", solid: "#b0534a" },
  { soft: "#eef3e3", text: "#4a5a1c", solid: "#6c8230" }
];
const isoDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const parseDay = (value) => { const [y, m, d] = value.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const shiftDay = (value, days) => { const date = parseDay(value); date.setDate(date.getDate() + days); return isoDay(date); };
function calendarRange() {
  const { view, cursor } = state.calendar;
  const anchor = parseDay(cursor);
  if (view === "week") {
    const start = new Date(anchor); start.setDate(anchor.getDate() - anchor.getDay());
    return { start: isoDay(start), days: 7 };
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const days = Math.ceil((first.getDay() + last.getDate()) / 7) * 7;
  return { start: isoDay(start), days };
}
function calendarEvents() {
  const programs = state.data.projects.filter((project) => state.calendar.programId === "all" || project.id === state.calendar.programId);
  const colorFor = new Map(state.data.projects.map((project, index) => [project.id, CALENDAR_COLORS[index % CALENDAR_COLORS.length]]));
  const byDay = new Map();
  const add = (day, event) => byDay.set(day, [...(byDay.get(day) || []), event]);
  for (const project of programs) {
    if (!project.startDate) continue;
    const end = project.endDate && project.endDate >= project.startDate ? project.endDate : project.startDate;
    const span = Math.min(60, Math.round((parseDay(end) - parseDay(project.startDate)) / 86400000));
    for (let offset = 0; offset <= span; offset++) {
      const day = shiftDay(project.startDate, offset);
      const label = span === 0 ? project.name : offset === 0 ? `Starts · ${project.name}` : day === end ? `Ends · ${project.name}` : project.name;
      add(day, { kind: "program", id: project.id, label, title: "Program dates", color: colorFor.get(project.id) });
    }
  }
  const visible = new Set(programs.map((project) => project.id));
  for (const task of state.data.tasks) {
    if (!task.dueDate || !visible.has(task.projectId)) continue;
    add(task.dueDate, { kind: "task", id: task.id, label: task.title, title: task.projectName, done: task.status === "Completed", overdue: isOverdue(task), color: colorFor.get(task.projectId) });
  }
  for (const events of byDay.values()) events.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "program" ? -1 : 1));
  return { byDay, programs, colorFor };
}
function calendarEventChip(event) {
  const attr = event.kind === "program" ? `data-project="${escapeHtml(event.id)}"` : `data-task="${escapeHtml(event.id)}"`;
  const style = event.kind === "program"
    ? `background:${event.color.solid};color:#fff`
    : `background:${event.color.soft};color:${event.color.text}`;
  const flags = event.overdue ? " is-overdue" : event.done ? " is-done" : "";
  const prefix = event.overdue ? "Overdue: " : event.done ? "Done: " : "";
  return `<button type="button" class="calendar-event${flags}" ${attr} style="${style}" title="${escapeHtml(`${prefix}${event.label} · ${event.title}`)}">${event.overdue ? '<span class="calendar-flag" aria-hidden="true">!</span>' : ""}${escapeHtml(event.label)}<span class="sr-only"> · ${escapeHtml(event.title)}${event.overdue ? " (overdue)" : event.done ? " (done)" : ""}</span></button>`;
}
function renderCalendar() {
  const { view, cursor, programId } = state.calendar;
  const { start, days } = calendarRange();
  const { byDay, programs, colorFor } = calendarEvents();
  const anchor = parseDay(cursor);
  const heading = view === "month"
    ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : `${dateLabel(start, { month: "short", day: "numeric" })} – ${dateLabel(shiftDay(start, 6), { month: "short", day: "numeric", year: "numeric" })}`;
  const limit = view === "month" ? 3 : Infinity;
  const cells = Array.from({ length: days }, (_, index) => {
    const day = shiftDay(start, index);
    const inMonth = view === "week" || parseDay(day).getMonth() === anchor.getMonth();
    const events = byDay.get(day) || [];
    const shown = events.slice(0, limit);
    const more = events.length - shown.length;
    return `<div class="calendar-cell ${inMonth ? "" : "outside"} ${view === "week" ? "week" : ""}">
      <div class="calendar-day ${day === today() ? "today" : ""}">${view === "week" ? `<span class="calendar-weekday">${parseDay(day).toLocaleDateString(undefined, { weekday: "short" })}</span>` : ""}${parseDay(day).getDate()}</div>
      ${shown.map(calendarEventChip).join("")}
      ${more > 0 ? `<button type="button" class="calendar-more" data-calendar-week="${day}">+${more} more</button>` : ""}
    </div>`;
  }).join("");
  const legend = state.data.projects.filter((project) => programs.includes(project)).slice(0, 8)
    .map((project) => `<span class="calendar-legend-item"><span class="calendar-swatch" style="background:${colorFor.get(project.id).solid}"></span>${escapeHtml(project.name)}</span>`).join("");
  return `${pageHeading("SCHEDULE", "Calendar", "Program dates and task deadlines by month or week. Click any item to open it.")}
    <div class="calendar-toolbar">
      <div class="calendar-nav">
        <button type="button" class="icon-button bordered" data-calendar-step="-1" aria-label="Previous ${view}">‹</button>
        <h2 class="calendar-title">${escapeHtml(heading)}</h2>
        <button type="button" class="icon-button bordered" data-calendar-step="1" aria-label="Next ${view}">›</button>
        <button type="button" class="button small ghost" data-calendar-today>Today</button>
      </div>
      <div class="calendar-controls">
        <div class="segmented" role="group" aria-label="Calendar view">
          <button type="button" data-calendar-view="month" aria-pressed="${view === "month"}" class="${view === "month" ? "active" : ""}">Month</button>
          <button type="button" data-calendar-view="week" aria-pressed="${view === "week"}" class="${view === "week" ? "active" : ""}">Week</button>
        </div>
        <label class="compact-filter">Program<select data-calendar-program><option value="all">All programs</option>${state.data.projects.map((project) => `<option value="${escapeHtml(project.id)}" ${programId === project.id ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}</select></label>
      </div>
    </div>
    <div class="calendar-legend">${legend}<span class="calendar-legend-item key"><span class="calendar-swatch solid"></span>Program day</span><span class="calendar-legend-item key"><span class="calendar-swatch soft"></span>Task deadline</span></div>
    <div class="calendar" role="grid" aria-label="${escapeHtml(heading)}">
      <div class="calendar-head">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name) => `<div>${name}</div>`).join("")}</div>
      <div class="calendar-grid">${cells}</div>
    </div>`;
}
function renderTemplates() {
  return `${pageHeading("REUSABLE WORKFLOWS", "Task templates", "Start each program with a repeatable checklist. Template tasks are generated relative to the program date and linked by prerequisites.")}
    <div class="template-grid">${state.data.templates.map((template)=>`<article class="template-card"><div class="eyebrow">${escapeHtml(template.programType)} PROGRAM</div><h2>${escapeHtml(template.name)}</h2><p>${escapeHtml(template.description)}</p><div class="template-meta"><span>${templateTaskCount(template.id)} tasks · relative deadlines</span>${isManager()?`<button class="button small ghost" data-edit-template="${escapeHtml(template.id)}">Edit template</button>`:`<span>Reusable</span>`}</div></article>`).join("")}</div>
    ${isManager()?`<div class="integration-callout" style="margin-top:16px">Template changes apply to programs created from now on; existing program tasks and deadlines are preserved.</div>`:""}`;
}
function templateTaskCount(templateId) {
  return state.data.templates.find((template)=>template.id===templateId)?.tasks?.length || 0;
}
function renderNotifications() {
  const notifications = state.data.notifications;
  return `${pageHeading("UPDATES", "Notifications", "Task assignments, newly unblocked work, and schedule updates for your account.", notifications.some((item)=>!item.isRead)?`<button class="button ghost" data-action="mark-all-read">Mark all read</button>`:"")}
    <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Your notifications</h2><p class="panel-subtitle">${notifications.filter((item)=>!item.isRead).length} unread · only visible to your account</p></div></div>${notifications.length ? notifications.map((item)=>`<article class="notification-card ${item.isRead?"":"unread"}"><span class="notification-icon">♧</span><div class="notification-copy"><p>${escapeHtml(item.message)}</p><time>${dateLabel(item.createdAt,{month:"short",day:"numeric"})} · ${new Date(item.createdAt).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})}</time></div>${!item.isRead?`<button class="text-action" data-read-notification="${escapeHtml(item.id)}">Mark read</button>`:""}</article>`).join(""):`<div class="empty-state"><span class="empty-mark">♧</span><strong>You’re all caught up</strong>New task assignments and program updates will show here.</div>`}</section>`;
}
function airtableCellValue(value, recordLabels) {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === "object" && item.id) return item.name || recordLabels[item.id] || item.id;
      return typeof item === "object" ? JSON.stringify(item) : String(item);
    }).join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function renderAirtableData() {
  if (!isAdmin()) return pageHeading("ADMINISTRATION", "Access denied", "Only administrators can inspect synchronized Airtable data.");
  const data = state.airtableData;
  const selected = data.tables.find((table) => table.id === data.selectedTableId);
  const totalRecords = data.tables.reduce((sum, table) => sum + table.recordCount, 0);
  const recordTable = selected ? `<section class="panel airtable-record-panel">
    <div class="panel-head"><div><h2 class="panel-title">${escapeHtml(selected.name)}</h2><p class="panel-subtitle">${data.total} matching of ${selected.recordCount} synced records · updated ${escapeHtml(new Date(selected.syncedAt).toLocaleString())}</p></div>
      <form class="airtable-search-form" id="airtable-search-form"><input class="search-input" name="query" aria-label="Search Airtable records" placeholder="Search this table…" value="${escapeHtml(data.query)}"><button class="button small ghost" type="submit">Search</button></form>
    </div>
    ${data.loading ? `<div class="empty-state"><span class="spinner"></span>Loading Airtable records…</div>` : data.records.length ? `<div class="table-wrap airtable-record-wrap"><table class="airtable-record-table"><thead><tr><th>Record ID</th>${selected.fields.map((field) => `<th>${escapeHtml(field.name)}<small>${escapeHtml(field.type)}</small></th>`).join("")}</tr></thead><tbody>${data.records.map((record) => `<tr><td class="airtable-record-id">${escapeHtml(record.id)}</td>${selected.fields.map((field) => `<td>${escapeHtml(airtableCellValue(record.fields[field.name],data.recordLabels))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>${data.query?"No matching records":"No records in this table"}</strong>${data.query?"Try a different search.":"Run a sync to load records from Airtable."}</div>`}
    <div class="airtable-pagination"><span>Showing ${data.total ? data.offset + 1 : 0}–${Math.min(data.offset + data.limit,data.total)} of ${data.total}</span><div><button class="button small ghost" data-airtable-page="${Math.max(0,data.offset-data.limit)}" ${data.offset===0||data.loading?"disabled":""}>Previous</button><button class="button small ghost" data-airtable-page="${data.offset+data.limit}" ${data.offset+data.limit>=data.total||data.loading?"disabled":""}>Next</button></div></div>
  </section>` : `<section class="panel"><div class="empty-state"><strong>No Airtable tables synced yet</strong>Open Airtable integration settings and run a sync to load the base.</div></section>`;
  return `${pageHeading("ADMINISTRATOR WORKSPACE", "Airtable data", "Browse every synchronized table and its linked records. This read-only view is available only to administrators.")}
    <div class="stat-grid" aria-label="Airtable data summary">${statCard("Tables synced",data.tables.length,"All tables in the connected base","▧")}${statCard("Records available",totalRecords,"Read-only Airtable snapshots","▤")}${statCard("Latest sync",data.tables.length?new Date(Math.max(...data.tables.map((table)=>Date.parse(table.syncedAt)))).toLocaleDateString():"Not synced", "Most recent successful sync","◷")}${statCard("Programs in workspace",state.data.projects.length,"Sessions linked into NMU","▦")}</div>
    <section class="panel airtable-table-picker"><div class="panel-head"><div><h2 class="panel-title">Base tables</h2><p class="panel-subtitle">Select a table to inspect its fields and records.</p></div><button class="button small ghost" data-action="airtable-refresh-data">↻ Refresh table list</button></div>
      ${data.tables.length ? `<div class="airtable-table-chips">${data.tables.map((table)=>`<button class="airtable-table-chip ${table.id===data.selectedTableId?"selected":""}" data-airtable-table="${escapeHtml(table.id)}" aria-pressed="${table.id===data.selectedTableId}"><span>${escapeHtml(table.name)}</span><small>${table.recordCount} records</small></button>`).join("")}</div>` : `<div class="empty-state">${data.loading?"Loading synced tables…":"No synced tables yet. Run an Airtable sync from Settings."}</div>`}
    </section>
    ${recordTable}`;
}
async function loadAirtableTables() {
  if (!isAdmin()) return;
  state.airtableData.loading = true;
  render();
  try {
    const result = await api("/api/integrations/airtable/tables");
    state.airtableData.tables = result.tables;
    if (!result.tables.some((table) => table.id === state.airtableData.selectedTableId)) {
      state.airtableData.selectedTableId = result.tables[0]?.id || null;
      state.airtableData.query = "";
      state.airtableData.offset = 0;
    }
    state.airtableData.loading = false;
    render();
    if (state.airtableData.selectedTableId) await loadAirtableRecords(0);
  } catch (error) {
    state.airtableData.loading = false;
    render();
    showToast(error.message,true);
  }
}
async function loadAirtableRecords(offset = state.airtableData.offset) {
  const data = state.airtableData;
  if (!data.selectedTableId || !isAdmin()) return;
  const tableId = data.selectedTableId;
  data.loading = true;
  render();
  try {
    const query = new URLSearchParams({ limit: String(data.limit), offset: String(offset) });
    if (data.query) query.set("q",data.query);
    const result = await api(`/api/integrations/airtable/tables/${encodeURIComponent(tableId)}/records?${query}`);
    if (data.selectedTableId !== tableId) return;
    data.records = result.records;
    data.recordLabels = result.recordLabels;
    data.total = result.total;
    data.offset = result.offset;
  } catch (error) {
    showToast(error.message,true);
  } finally {
    if (data.selectedTableId === tableId) {
      data.loading = false;
      render();
    }
  }
}
function renderSettings() {
  const connected = state.data.integration.airtableConfigured;
  const lastSync = state.data.integration.airtableLastSync;
  const syncStatus = lastSync
    ? `${state.data.integration.airtableTablesSynced} Airtable tables synced · ${new Date(lastSync).toLocaleString()}`
    : "Airtable has not been synced to this workspace yet.";
  const accountManager = state.authRequired && isAdmin() ? `<section class="integration-panel" style="margin-top:14px"><div class="eyebrow">TEAM ACCESS</div><h2>Manage team accounts</h2><p>Create individual accounts with the least-privilege role they need. Share temporary passwords privately; teammates can change their password after signing in.</p>
      <form id="create-user-form"><div class="form-grid">${formField("Full name","newUserName","text",{required:true})}${formField("Email address","newUserEmail","email",{required:true})}${formField("Role","newUserRole","select",{required:true,choices:[["employee","Employee"],["program_manager","Program Manager"],["admin","Administrator"],["external_partner","External Partner"]]})}${formField("Temporary password (12+ characters)","newUserPassword","password",{required:true,placeholder:"Share separately and privately"})}</div><button class="button primary" type="submit" style="margin-top:12px">Create account</button></form>
      <div class="table-wrap" style="margin-top:18px"><table class="project-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th><th></th></tr></thead><tbody>${state.accountUsers.map((account)=>`<tr><td>${escapeHtml(account.name)}</td><td>${escapeHtml(account.email)}</td><td>${escapeHtml(account.role.replaceAll("_"," "))}</td><td>${account.active?"Active":"Disabled"}</td><td>${account.id===state.data.currentUser.id?"You":`<button class="text-action" data-account-toggle="${escapeHtml(account.id)}" data-active="${account.active?"false":"true"}">${account.active?"Disable":"Enable"}</button>`}</td></tr>`).join("")}</tbody></table></div>
    </section>` : "";
  const passwordSettings = state.authRequired ? `<section class="integration-panel" style="margin-top:14px"><div class="eyebrow">ACCOUNT SECURITY</div><h2>Change your password</h2><form id="change-password-form"><div class="form-grid">${formField("Current password","currentPassword","password",{required:true})}${formField("New password (12+ characters)","newPassword","password",{required:true})}${formField("Confirm new password","confirmPassword","password",{required:true})}</div><button class="button primary" type="submit" style="margin-top:12px">Update password</button></form></section>` : "";
  const airtableSettings = isAdmin() ? `${pageHeading("WORKSPACE SETTINGS", "Airtable integration", "Sync the linked NMU base into the workspace and send approved Work updates back to Airtable.")}
    <section class="integration-panel"><div class="eyebrow">AIRTABLE · LINKED TABLE SYNC</div><h2>Synchronize NMU data</h2><p>Sync imports and snapshots every table in the connected base, preserving Airtable record IDs and linked fields. Sessions appear as programs and linked Work records appear as tasks; other tables are available in the administrator-only Airtable data browser.</p>
      <div class="integration-callout ${connected?"":"warning"}">${connected?escapeHtml(syncStatus):"Airtable credentials are not configured on the server. Add AIRTABLE_API_KEY and AIRTABLE_BASE_ID in Railway Variables, then redeploy."}</div>
      <p><b>Ownership:</b> Airtable owns reference and setup data. The app writes only <span class="code">Status</span>, <span class="code">Due Date</span>, <span class="code">Completed Date</span>, and <span class="code">Assignee</span> on already-linked <span class="code">Work</span> rows. Other Work fields and linked/reference tables are read-only to the app. No records are automatically deleted, and simultaneous edits are reported as conflicts rather than overwritten.</p>
      <p><b>Access:</b> the server token needs <span class="code">schema.bases:read</span>, <span class="code">data.records:read</span>, and <span class="code">data.records:write</span> access to this base. Keep it in Railway Variables; never put it in the browser or GitHub.</p>
      <div class="heading-actions"><button class="button ghost" data-action="airtable-check" ${connected?"":"disabled"}>Check schema access</button><button class="button primary" data-action="airtable-sync" ${connected?"":"disabled"}>↻ Sync all Airtable tables</button></div>
      ${state.airtableSync?`<div class="integration-callout ${state.airtableSync.conflicts?.length?"warning":""}" style="margin-top:14px">Last sync: ${Object.values(state.airtableSync.tables||{}).reduce((sum,count)=>sum+count,0)} records across ${Object.keys(state.airtableSync.tables||{}).length} tables; ${state.airtableSync.updatedWorkRecords||0} Work records written to Airtable; ${state.airtableSync.conflicts?.length||0} conflicts need review.</div>${state.airtableSync.conflicts?.length?`<ul>${state.airtableSync.conflicts.map((item)=>`<li>${escapeHtml(item.recordId)} · ${escapeHtml(item.field)} differs between the app (${escapeHtml(item.local)}) and Airtable (${escapeHtml(item.airtable)}).</li>`).join("")}</ul>`:""}`:""}
    </section>` : pageHeading("ACCOUNT SETTINGS", "Your account", "Manage your sign-in details.");
  return `${airtableSettings}
    ${accountManager}
    ${passwordSettings}
    ${!state.authRequired?`<section class="integration-panel" style="margin-top:14px"><div class="eyebrow">DEMO IDENTITY</div><h2>Switch demonstration account</h2><p>Use the account menu in the top bar to preview management, program manager, employee, and partner experiences. This is demo identity switching, not production authentication.</p><div class="integration-callout warning">Demo identity switching is for local development only and must not be used for real operational data.</div></section>`:""}`;
}
function projectTabs() {
  return `<nav class="project-tabs" aria-label="Program workspace sections">${["overview","tasks","timeline","team","activity"].map((tab)=>`<button class="project-tab ${state.projectTab===tab?"active":""}" data-project-tab="${tab}">${tab[0].toUpperCase()+tab.slice(1)}</button>`).join("")}</nav>`;
}
function taskTable(tasks, projectId) {
  const external = userRole() === "external_partner";
  const shown = external ? tasks.filter((task) => task.assignedUserId === state.userId) : tasks;
  return shown.length ? `<div class="table-wrap"><table class="task-table"><thead><tr><th>Task</th><th>Owner</th><th>Due</th><th>Priority</th><th>Status</th></tr></thead><tbody>${shown.map((task)=>`<tr><td><button class="task-link" data-task="${escapeHtml(task.id)}">${escapeHtml(task.title)}</button><span class="secondary-cell">${escapeHtml(task.milestone)}${task.isBlocked?" · Prerequisite incomplete":""}</span></td><td>${escapeHtml(task.assigneeName||"Unassigned")}</td><td>${dateLabel(task.dueDate,{month:"short",day:"numeric"})}</td><td>${priorityLabel(task.priority)}</td><td>${statusBadge(task.isBlocked?"Blocked":task.status,isOverdue(task))}</td></tr>`).join("")}</tbody></table></div>`:`<div class="empty-state"><strong>No tasks to display</strong>${external?"You only see tasks assigned to your partner account.":"This program has no tasks yet."}</div>`;
}
function renderProject(data) {
  const { project, tasks, members, activities, comments } = data;
  const allowedTasks = userRole() === "external_partner" ? tasks.filter((task)=>task.assignedUserId===state.userId) : tasks;
  const canReplan = isAdmin() || (userRole()==="program_manager" && (project.projectManagerId===state.userId || members.some((member)=>member.id===state.userId)));
  const pageActions = canReplan ? `<button class="button primary" data-action="create-task">＋ Add task</button><button class="button ghost" data-action="replan">◷ Adjust dates</button>` : "";
  let pane = "";
  if (state.projectTab === "overview") {
    const next = allowedTasks.filter((task)=>task.status!=="Completed").sort((a,b)=>a.dueDate.localeCompare(b.dueDate)).slice(0,4);
    pane = `<div class="detail-grid"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Program details</h2><p class="panel-subtitle">Shared context for the team handoff</p></div></div><div class="detail-list">
      <div class="detail-item"><span>Program type</span><strong>${escapeHtml(project.programType)}</strong></div><div class="detail-item"><span>Delivery type</span><strong>${escapeHtml(project.deliveryType||"Not set")}</strong></div>
      <div class="detail-item"><span>Host organization</span><strong>${escapeHtml(project.hostOrganization||"Not set")}</strong></div><div class="detail-item"><span>Location</span><strong>${escapeHtml([project.city,project.state].filter(Boolean).join(", ")||project.location)}</strong></div>
      <div class="detail-item"><span>Start date</span><strong>${dateLabel(project.startDate)}</strong></div><div class="detail-item"><span>End date</span><strong>${dateLabel(project.endDate)}</strong></div>
      <div class="detail-item"><span>Project manager</span><strong>${escapeHtml(project.projectManagerName||"—")}</strong></div><div class="detail-item"><span>Progress</span><strong>${project.progress}% · ${project.completedCount}/${project.taskCount} tasks</strong></div>
      <div class="detail-item"><span>Program hours</span><strong>${project.details.programHours?escapeHtml(project.details.programHours):"Not provided"}</strong></div><div class="detail-item"><span>Lead instructor(s)</span><strong>${escapeHtml(project.details.leadInstructors||"Not provided")}</strong></div>
      <div class="detail-item"><span>Primary contact</span><strong>${escapeHtml(project.details.primaryContact||"Not provided")}</strong></div><div class="detail-item"><span>Expected participants</span><strong>${escapeHtml(project.details.participants||"Not provided")}</strong></div>
      <div class="detail-item"><span>Contact email</span><strong>${escapeHtml(project.details.contactEmail||"Not provided")}</strong></div><div class="detail-item"><span>Shipping address</span><strong>${escapeHtml(project.details.shippingAddress||"Not provided")}</strong></div>
      ${project.details.notes?`<div class="detail-item" style="grid-column:1/-1"><span>Additional notes</span><strong>${escapeHtml(project.details.notes)}</strong></div>`:""}
    </div></section><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Upcoming work</h2><p class="panel-subtitle">Open items by due date</p></div><button class="button small ghost" data-project-tab="tasks">All tasks</button></div>${next.length?next.map((task)=>`<div class="task-row"><div><button class="task-link" data-task="${escapeHtml(task.id)}">${escapeHtml(task.title)}</button><div class="task-row-meta">${dateLabel(task.dueDate,{month:"short",day:"numeric"})} · ${escapeHtml(task.assigneeName||"Unassigned")}</div></div>${statusBadge(task.isBlocked?"Blocked":task.status,isOverdue(task))}</div>`).join(""):`<div class="empty-state"><strong>All caught up</strong>No outstanding tasks.</div>`}</section></div>`;
  } else if (state.projectTab === "tasks") {
    pane = `<section class="panel"><div class="panel-head"><div><h2 class="panel-title">Program tasks</h2><p class="panel-subtitle">${allowedTasks.length} tasks · completion updates the project progress automatically</p></div><div class="panel-actions"><input class="search-input" data-filter="task-search" placeholder="Search tasks…" value="${escapeHtml(state.taskSearch)}" aria-label="Search program tasks"><select class="filter-select" data-filter="task-status" aria-label="Filter tasks by status"><option value="all">All statuses</option>${["Not Started","In Progress","Blocked","Completed"].map((status)=>`<option ${state.taskStatusFilter===status?"selected":""}>${status}</option>`).join("")}</select></div></div>${taskTable(allowedTasks.filter((task)=>{const q=state.taskSearch.toLowerCase();return (!q||`${task.title} ${task.assigneeName} ${task.milestone}`.toLowerCase().includes(q))&&(state.taskStatusFilter==="all"|| (task.isBlocked?"Blocked":task.status)===state.taskStatusFilter)}),project.id)}</section>`;
  } else if (state.projectTab === "timeline") {
    const grouped = new Map();
    for (const task of allowedTasks.slice().sort((a,b)=>a.dueDate.localeCompare(b.dueDate))) grouped.set(task.milestone,[...(grouped.get(task.milestone)||[]),task]);
    pane = `<section class="panel"><div class="panel-head"><div><h2 class="panel-title">Planning timeline</h2><p class="panel-subtitle">Tasks grouped by NMU planning phase</p></div></div>${[...grouped.entries()].map(([phase,items])=>`<div class="panel-head"><h3 class="panel-title">${escapeHtml(phase)}</h3><span class="muted">${items.length} tasks</span></div><div class="timeline-list">${items.map((task)=>`<div class="timeline-item ${isOverdue(task)?"overdue":""}"><time class="timeline-date">${dateLabel(task.dueDate,{month:"short",day:"numeric"})}</time><span class="timeline-marker"></span><div class="timeline-copy"><strong><button class="task-link" data-task="${escapeHtml(task.id)}">${escapeHtml(task.title)}</button></strong><small>${escapeHtml(task.assigneeName||"Unassigned")} · ${task.isBlocked?"Blocked by prerequisite":task.status}</small></div></div>`).join("")}</div>`).join("")}</section>`;
  } else if (state.projectTab === "team") {
    const visibleMembers = userRole()==="external_partner"?members.filter((member)=>member.id===state.userId):members;
    pane = `<section class="panel"><div class="panel-head"><div><h2 class="panel-title">Program team</h2><p class="panel-subtitle">${visibleMembers.length} member${visibleMembers.length===1?"":"s"} · role and responsibilities</p></div></div><div class="table-wrap"><table class="task-table"><thead><tr><th>Team member</th><th>Role</th><th>Assigned tasks</th></tr></thead><tbody>${visibleMembers.map((member)=>`<tr><td><b>${escapeHtml(member.name)}</b><span class="secondary-cell">${escapeHtml(member.email)}</span></td><td>${escapeHtml(member.projectRole)}</td><td>${allowedTasks.filter((task)=>task.assignedUserId===member.id).length}</td></tr>`).join("")}</tbody></table></div></section>`;
  } else {
    pane = `<section class="panel"><div class="panel-head"><div><h2 class="panel-title">Activity history</h2><p class="panel-subtitle">Important changes and handoff context</p></div></div>${activities.length?`<div class="activity-list">${activities.map((item)=>`<article class="activity-item"><span class="activity-dot"></span><div><strong>${escapeHtml(item.userName)} · ${escapeHtml(item.action)}</strong><p>${escapeHtml(item.details)}</p></div><time>${dateLabel(item.createdAt,{month:"short",day:"numeric"})}</time></article>`).join("")}</div>`:`<div class="empty-state">No activity recorded yet.</div>`}</section><section class="panel" style="margin-top:13px"><div class="panel-head"><div><h2 class="panel-title">Task notes</h2><p class="panel-subtitle">Context posted on individual task details</p></div></div>${comments.length?`<div class="activity-list">${comments.map((comment)=>`<article class="activity-item"><span class="activity-dot"></span><div><strong>${escapeHtml(comment.userName)} · ${escapeHtml(tasks.find((task)=>task.id===comment.taskId)?.title||"Task note")}</strong><p>${escapeHtml(comment.content)}</p></div><time>${dateLabel(comment.createdAt,{month:"short",day:"numeric"})}</time></article>`).join("")}</div>`:`<div class="empty-state">No task notes yet.</div>`}</section>`;
  }
  return `<div class="project-hero"><div><div class="eyebrow">${escapeHtml(project.programType)} · ${escapeHtml(project.location)}</div><h1>${escapeHtml(project.name)}</h1><div class="project-meta"><span>◷ ${dateLabel(project.startDate,{month:"short",day:"numeric"})} – ${dateLabel(project.endDate,{month:"short",day:"numeric",year:"numeric"})}</span><span>♙ ${escapeHtml(project.projectManagerName||"No manager")}</span><span>${project.progress}% complete</span><span>${escapeHtml(project.hostOrganization||"Host not set")}</span></div></div><div class="heading-actions">${statusBadge(project.status)}${pageActions}</div></div>
    ${projectTabs()}<div class="project-content">${pane}</div>`;
}
async function openProject(projectId) {
  state.projectId = projectId;
  state.projectTab = "overview";
  state.taskSearch = "";
  state.taskStatusFilter = "all";
  try {
    const projectData = await api(`/api/projects/${encodeURIComponent(projectId)}`);
    state.projectData = projectData;
    renderProjectPage();
  } catch (error) { showToast(error.message,true); }
}
function showTaskForm() {
  const { project, tasks, members } = state.projectData || {};
  if (!project) return;
  const canManageProject = isAdmin() || (userRole()==="program_manager" &&
    (project.projectManagerId===state.userId || members.some((member)=>member.id===state.userId)));
  if (!canManageProject) return;
  const internalUsers = state.data.users.filter((item)=>item.role!=="external_partner");
  const defaultDate = project.startDate >= new Date().toISOString().slice(0,10)
    ? project.startDate : new Date().toISOString().slice(0,10);
  modalRoot.innerHTML = `<div class="modal-backdrop" data-close-modal><section class="modal" role="dialog" aria-modal="true" aria-labelledby="task-create-title"><header class="modal-head"><div><h2 id="task-create-title">Add a program task</h2><p>Create a task and optionally assign it or add prerequisites.</p></div><button class="modal-close" data-action="close-modal" aria-label="Close dialog">×</button></header><form id="create-task-form" data-project-id="${escapeHtml(project.id)}"><div class="modal-body"><div class="form-grid">
    ${formField("Task name","title","text",{required:true,full:true,placeholder:"What needs to be done?"})}
    ${formField("Description","description","textarea",{full:true,placeholder:"Add instructions or context for the owner."})}
    ${formField("Deadline","dueDate","date",{required:true,value:defaultDate})}
    ${formField("Planning phase","milestone","text",{required:true,value:"Program operations"})}
    ${formField("Priority","priority","select",{required:true,choices:[["Low","Low"],["Medium","Medium"],["High","High"]],value:"Medium"})}
    ${formField("Assign to","assignedUserId","select",{choices:[["","Unassigned"],...internalUsers.map((item)=>[item.id,item.name])]})}
    <fieldset class="form-field full"><legend>Prerequisites</legend>${tasks.length?tasks.map((task)=>`<label class="checkbox-option"><input type="checkbox" name="dependencyIds" value="${escapeHtml(task.id)}"> ${escapeHtml(task.title)} · ${escapeHtml(task.status)}</label>`).join(""):`<p class="muted">No existing tasks to select as prerequisites.</p>`}</fieldset>
  </div></div><footer class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button type="submit" class="button primary">Add task</button></footer></form></section></div>`;
  modalRoot.querySelector("#create-task-form input[name=title]")?.focus();
}
function renderProjectPage() {
  const project = state.projectData?.project;
  if (!project) return;
  content.innerHTML = renderProject(state.projectData);
  document.getElementById("crumb-current").textContent = project.name;
}
function render() {
  if (!state.data) return;
  const user = state.data.currentUser;
  const select = document.getElementById("user-select");
  document.querySelector(".user-select-label").hidden = state.authRequired;
  select.hidden = state.authRequired;
  document.getElementById("logout-button").hidden = !state.authRequired;
  document.getElementById("user-avatar").hidden = state.authRequired;
  const userOptions = state.data.users.map((item)=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.role.replaceAll("_"," "))}</option>`).join("");
  if (select.innerHTML !== userOptions) select.innerHTML = userOptions;
  select.value = state.userId;
  document.getElementById("user-avatar").textContent = initials(user.name);
  document.getElementById("my-task-count").textContent = state.data.tasks.filter((task)=>task.assignedUserId===state.userId&&task.status!=="Completed").length;
  const unread = state.data.notifications.filter((item)=>!item.isRead).length;
  document.getElementById("notification-count").textContent = unread;
  document.getElementById("notification-indicator").classList.toggle("hidden",!unread);
  const integration = document.querySelector(".integration-status");
  integration.classList.toggle("connected",state.data.integration.airtableConfigured);
  document.getElementById("airtable-data-nav").hidden = !isAdmin();
  document.getElementById("mobile-airtable-data-nav").hidden = !isAdmin();
  document.getElementById("airtable-status").textContent = state.data.integration.airtableLastSync
    ? "Synced"
    : state.data.integration.airtableConfigured ? "Configured" : "Not connected";
  document.getElementById("crumb-current").textContent = state.page.replaceAll("-"," ").replace(/\b\w/g,(letter)=>letter.toUpperCase());
  document.querySelectorAll(".nav-link").forEach((item)=>item.classList.toggle("active",item.dataset.nav===state.page&&!state.projectId));
  if (state.projectId && state.projectData) return renderProjectPage();
  const renderers = { overview:renderOverview, projects:renderProjects, "my-tasks":renderMyTasks, timeline:renderTimeline, calendar:renderCalendar, templates:renderTemplates, notifications:renderNotifications, settings:renderSettings, "airtable-data":renderAirtableData };
  content.innerHTML = (renderers[state.page] || renderOverview)();
}
async function openTask(taskId) {
  let task = state.data.tasks.find((item)=>item.id===taskId);
  if (!task) return;
  let projectData = state.projectData?.project.id===task.projectId ? state.projectData : null;
  if (!projectData) {
    try { projectData = await api(`/api/projects/${encodeURIComponent(task.projectId)}`); }
    catch(error) { showToast(error.message,true); return; }
  }
  const fullTask = projectData.tasks.find((item)=>item.id===taskId);
  const comments = projectData.comments.filter((item)=>item.taskId===taskId);
  const managerControls = isAdmin() || (userRole()==="program_manager" && fullTask.canEdit);
  const users = state.data.users.filter((item)=>item.role!=="external_partner");
  const dependencies = fullTask.dependencies.length ? `<div class="form-field full"><label>Prerequisites</label><div class="integration-callout ${fullTask.isBlocked?"warning":""}">${fullTask.dependencies.map((item)=>`${escapeHtml(item.title)} — ${escapeHtml(item.status)}`).join("<br>")}</div></div>` : "";
  modalRoot.innerHTML = `<div class="modal-backdrop" data-close-modal><section class="modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title"><header class="modal-head"><div><h2 id="task-modal-title">${escapeHtml(fullTask.title)}</h2><p>${escapeHtml(projectData.project.name)} · ${escapeHtml(fullTask.milestone)}</p></div><button class="modal-close" data-action="close-modal" aria-label="Close dialog">×</button></header><form id="task-form" data-task-id="${escapeHtml(taskId)}" data-original-due-date="${escapeHtml(fullTask.dueDate)}"><div class="modal-body">
      <div class="form-grid"><div class="form-field"><label for="task-status">Status</label><select id="task-status" name="status"><option ${fullTask.status==="Not Started"?"selected":""}>Not Started</option><option ${fullTask.status==="In Progress"?"selected":""}>In Progress</option><option ${fullTask.status==="Completed"?"selected":""}>Completed</option></select></div>
      ${managerControls?`<div class="form-field"><label for="task-assignee">Assigned to</label><select id="task-assignee" name="assignedUserId">${users.map((item)=>`<option value="${escapeHtml(item.id)}" ${item.id===fullTask.assignedUserId?"selected":""}>${escapeHtml(item.name)}</option>`).join("")}</select></div>`:`<div class="form-field"><label>Assigned to</label><input disabled value="${escapeHtml(fullTask.assigneeName||"Unassigned")}"></div>`}
      <div class="form-field"><label for="task-due-date">Due date${managerControls?" · management override":""}</label><input id="task-due-date" name="dueDate" type="${managerControls?"date":"text"}" ${managerControls?`value="${escapeHtml(fullTask.dueDate)}"`:`disabled value="${dateLabel(fullTask.dueDate)}"`}></div><div class="form-field"><label>Priority</label><input disabled value="${escapeHtml(fullTask.priority)}"></div>
      <div class="form-field full"><label>Description</label><div class="integration-callout">${escapeHtml(fullTask.description||"No task description.")}</div></div>${dependencies}</div>
      ${isAdmin()&&fullTask.isBlocked?`<div class="form-field" style="margin-top:12px"><label for="override-reason">Administrator override reason · required to bypass prerequisites</label><textarea id="override-reason" name="overrideReason" maxlength="500" placeholder="Record why this task must be completed before its prerequisites."></textarea></div>`:""}
      <div class="section-label">Task notes (${comments.length})</div>${comments.length?`<div class="comment-list">${comments.map((item)=>`<article class="comment"><strong>${escapeHtml(item.userName)} · ${dateLabel(item.createdAt,{month:"short",day:"numeric"})}</strong><p>${escapeHtml(item.content)}</p></article>`).join("")}</div>`:`<div class="form-hint" style="margin:0 0 9px">No notes yet. Add context for the next person who picks up this work.</div>`}
      <div class="form-field"><label for="task-comment">Add a note</label><textarea id="task-comment" name="comment" maxlength="2000" placeholder="Add an update or handoff note…"></textarea></div>
    </div><footer class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button type="submit" class="button primary">Save updates</button></footer></form></section></div>`;
  }
function formField(label, name, type="text", options={}) {
  const required = options.required ? "required" : "";
  const full = options.full ? " full" : "";
  const value = options.value ? `value="${escapeHtml(options.value)}"` : "";
  const placeholder = options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : "";
  const step = options.step ? `step="${options.step}"` : "";
  if (type === "select") return `<div class="form-field${full}"><label for="${name}">${escapeHtml(label)}${options.required?" *":""}</label><select id="${name}" name="${name}" ${required}>${options.choices.map(([val,text])=>`<option value="${escapeHtml(val)}" ${options.value===val?"selected":""}>${escapeHtml(text)}</option>`).join("")}</select></div>`;
  if (type === "textarea") return `<div class="form-field${full}"><label for="${name}">${escapeHtml(label)}${options.required?" *":""}</label><textarea id="${name}" name="${name}" ${required} ${placeholder}>${escapeHtml(options.value||"")}</textarea></div>`;
  return `<div class="form-field${full}"><label for="${name}">${escapeHtml(label)}${options.required?" *":""}</label><input id="${name}" name="${name}" type="${type}" ${required} ${value} ${placeholder} ${step}></div>`;
}
function showProjectForm() {
  if (!isManager()) return;
  const templates = state.data.templates;
  const employees = state.data.users.filter((item)=>item.role!=="external_partner");
  const start = new Date(); start.setDate(start.getDate()+60);
  const startValue = start.toISOString().slice(0,10);
  const deliveryTypes = [["Community","Community"],["School","School"],["One-Time Clinic","One-time clinic"]];
  const matchingTemplate = (deliveryType) => templates.find((item)=>
    item.programType.toLowerCase() === (deliveryType==="One-Time Clinic"?"Clinic":deliveryType).toLowerCase()
  ) || templates[0];
  const templateOptions = templates.map((item)=>[item.id,`${item.name} · ${item.programType}`]);
  modalRoot.innerHTML = `<div class="modal-backdrop" data-close-modal><section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="project-modal-title"><header class="modal-head"><div><h2 id="project-modal-title">Create a program</h2><p>Choose a template, review the generated task plan, and create the project.</p></div><button class="modal-close" data-action="close-modal" aria-label="Close dialog">×</button></header><form id="project-form"><div class="modal-body"><div class="form-grid">
    ${formField("Program type","programType","select",{required:true,choices:[["Learn to Swim","Learn to Swim"],["Swim Safely Series","Swim Safely Series"]]})}
    ${formField("Delivery type","deliveryType","select",{required:true,choices:deliveryTypes,value:"Community"})}
    ${formField("City","city","text",{required:true,placeholder:"e.g. Bellevue"})}
    ${formField("State","state","text",{required:true,placeholder:"e.g. WA"})}
    ${formField("Host organization","hostOrganization","text",{required:true,placeholder:"e.g. Bellevue YMCA"})}
    ${formField("Program name","name","text",{required:true,placeholder:"Generated from type, city, and host"})}
    ${formField("Program date","startDate","date",{required:true,value:startValue})}
    ${formField("Program hours","programHours","number",{step:"0.5",placeholder:"e.g. 24"})}
    ${formField("Lead instructor(s)","leadInstructors","text",{placeholder:"Names, separated by commas"})}
    ${formField("Project manager","projectManagerId","select",{required:true,choices:employees.map((item)=>[item.id,item.name]),value:state.data.currentUser.id})}
    ${formField("Create from","creationMode","select",{required:true,choices:[["template","Template · generate a task plan"],["scratch","Scratch · start with no tasks"]],value:"template"})}
    <div id="template-field">${formField("Task template","templateId","select",{choices:templateOptions,value:matchingTemplate("Community")?.id||""})}</div>
    <input type="hidden" name="location" id="location">
    <input type="hidden" name="endDate" id="endDate" value="${startValue}">
    ${formField("Program description","description","textarea",{full:true,placeholder:"What should the team know about this program?"})}
    ${formField("Primary contact","primaryContact","text",{placeholder:"Partner contact name"})}
    ${formField("Contact email","contactEmail","email",{placeholder:"name@example.org"})}
    ${formField("Expected participants","participants","number",{step:"1",placeholder:"e.g. 40"})}
    ${formField("Shipping address","shippingAddress","text",{placeholder:"Address for program materials"})}
    ${formField("Instructor requirements","instructorRequirements","textarea",{placeholder:"Skills, certifications, or coverage"})}
    ${formField("Volunteer requirements","volunteerRequirements","textarea",{placeholder:"Volunteer roles or estimated count"})}
    ${formField("Special requirements","specialRequirements","textarea",{placeholder:"Accessibility or operational needs"})}
    ${formField("Additional notes","notes","textarea",{placeholder:"Context for the team"})}
  </div><div class="preview-box" id="task-preview"></div></div><footer class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button type="submit" class="button primary">Create program and tasks</button></footer></form></section></div>`;
  const form = modalRoot.querySelector("#project-form");
  const nameInput = form.elements.namedItem("name");
  const generatedName = () => {
    const type = form.elements.programType.value;
    const city = form.elements.city.value.trim();
    const host = form.elements.hostOrganization.value.trim();
    if (!city) return "";
    return `${type} – ${city}${host ? ` ${host}` : ""}`;
  };
  const updatePreview = () => {
    const deliveryType = form.elements.deliveryType.value;
    const preferred = matchingTemplate(deliveryType);
    if (form.elements.creationMode.value==="template" && preferred && !templates.some((item)=>item.id===form.elements.templateId.value&&item.programType.toLowerCase()===(deliveryType==="One-Time Clinic"?"Clinic":deliveryType).toLowerCase())) {
      form.elements.templateId.value=preferred.id;
    }
    document.getElementById("template-field").hidden = form.elements.creationMode.value !== "template";
    const templateId = form.elements.templateId.value;
    const template = templates.find((item)=>item.id===templateId);
    const sampleTasks = form.elements.creationMode.value==="scratch" ? [] : templateTaskPreview(templateId);
    const startDate = document.getElementById("startDate").value;
    if (nameInput.dataset.userEdited!=="true") nameInput.value=generatedName();
    form.elements.location.value=[form.elements.city.value.trim(),form.elements.state.value.trim()].filter(Boolean).join(", ");
    form.elements.endDate.value=startDate;
    document.getElementById("task-preview").innerHTML = form.elements.creationMode.value==="scratch"
      ? `<h3>Start from scratch</h3><p>No tasks will be generated. You can create tasks from the new program workspace.</p>`
      : `<h3>Generated task preview · ${sampleTasks.length} tasks · ${escapeHtml(template?.name||"")}</h3>${sampleTasks.map(([title,offset])=>`<div class="preview-task"><span>${escapeHtml(title)}</span><span>${startDate?dateLabel(addDate(startDate,offset),{month:"short",day:"numeric"}):`${offset} days from start`}</span></div>`).join("")}`;
  };
  nameInput.addEventListener("input",()=>{nameInput.dataset.userEdited="true";});
  form.addEventListener("input",(event)=>{if(["city","hostOrganization","programType"].includes(event.target.name)&&nameInput.dataset.userEdited!=="true")nameInput.value=generatedName();});
  form.addEventListener("input",updatePreview);
  form.addEventListener("change",updatePreview);
  updatePreview();
}
function addDate(date, offset) {
  const result = new Date(`${date}T12:00:00`);
  result.setDate(result.getDate()+offset);
  return result.toISOString().slice(0,10);
}
function templateTaskPreview(templateId) {
  const template = state.data.templates.find((item)=>item.id===templateId);
  return (template?.tasks||[]).map((task)=>[task.title,task.relativeDueDays]);
}
async function openTemplateEditor(templateId) {
  try {
    const template = await api(`/api/templates/${encodeURIComponent(templateId)}`);
    modalRoot.innerHTML = `<div class="modal-backdrop" data-close-modal><section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="template-modal-title"><header class="modal-head"><div><h2 id="template-modal-title">Edit program template</h2><p>Changes apply to new programs; already generated tasks are not changed.</p></div><button class="modal-close" data-action="close-modal" aria-label="Close dialog">×</button></header><form id="template-form" data-template-id="${escapeHtml(template.id)}"><div class="modal-body"><div class="form-grid">${formField("Template name","templateName","text",{required:true,value:template.name})}${formField("Description","templateDescription","text",{value:template.description})}</div><div class="section-label">Template tasks · relative to program start date</div><div class="table-wrap"><table class="task-table"><thead><tr><th>Task</th><th>Days before / after start</th><th>Priority</th><th>Planning phase</th></tr></thead><tbody>${template.tasks.map((task,index)=>`<tr><td><input class="template-task-title" aria-label="Task ${index+1} title" value="${escapeHtml(task.title)}" required><input class="template-task-description" aria-label="Task ${index+1} description" value="${escapeHtml(task.description)}"></td><td><input class="template-task-days" aria-label="Task ${index+1} relative due days" type="number" step="1" value="${task.relativeDueDays}" required></td><td><select class="template-task-priority" aria-label="Task ${index+1} priority"><option ${task.priority==="Low"?"selected":""}>Low</option><option ${task.priority==="Medium"?"selected":""}>Medium</option><option ${task.priority==="High"?"selected":""}>High</option></select></td><td><input class="template-task-milestone" aria-label="Task ${index+1} planning phase" value="${escapeHtml(task.milestone)}" required></td></tr>`).join("")}</tbody></table></div></div><footer class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button type="submit" class="button primary">Save template</button></footer></form></section></div>`;
  } catch(error) { showToast(error.message,true); }
}
async function showReplan() {
  const project = state.projectData.project;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-close-modal><section class="modal" role="dialog" aria-modal="true" aria-labelledby="replan-title"><header class="modal-head"><div><h2 id="replan-title">Adjust program dates</h2><p>Preview the impact before updating outstanding task deadlines.</p></div><button class="modal-close" data-action="close-modal" aria-label="Close dialog">×</button></header><form id="replan-form"><div class="modal-body"><div class="form-field"><label for="new-start-date">New program start date</label><input id="new-start-date" name="startDate" type="date" required value="${escapeHtml(project.startDate)}"></div><div id="replan-preview" class="preview-box" style="margin-top:13px"></div></div><footer class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button type="submit" class="button primary">Confirm date change</button></footer></form></section></div>`;
  const form = modalRoot.querySelector("#replan-form");
  const preview = modalRoot.querySelector("#replan-preview");
  const update = async () => {
    try {
      const result = await api("/api/projects/date-preview",{method:"POST",body:JSON.stringify({projectId:project.id,startDate:form.startDate.value})});
      preview.innerHTML = `<h3>${result.shiftDays===0?"No date shift":`Shift of ${Math.abs(result.shiftDays)} day${Math.abs(result.shiftDays)===1?"":"s"} ${result.shiftDays>0?"later":"earlier"}`} · ${result.changes.length} outstanding deadlines change</h3>${result.changes.length?result.changes.slice(0,12).map((item)=>`<div class="preview-task"><span>${escapeHtml(item.title)}</span><span>${dateLabel(item.oldDate,{month:"short",day:"numeric"})} → ${dateLabel(item.newDate,{month:"short",day:"numeric"})}</span></div>`).join("")+(result.changes.length>12?`<div class="form-hint">and ${result.changes.length-12} more…</div>`:""):`<div class="form-hint">Completed tasks and manually overridden deadlines will be preserved.</div>`}`;
    } catch (error) { preview.innerHTML = `<div class="inline-error">${escapeHtml(error.message)}</div>`; }
  };
  form.startDate.addEventListener("change",update);
  form.addEventListener("submit",async(event)=>{
    event.preventDefault();
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}/start-date`,{method:"PATCH",body:JSON.stringify({startDate:form.startDate.value})});
      modalRoot.innerHTML="";
      await refresh();
      await openProject(project.id);
      showToast("Program timeline updated; eligible task deadlines shifted.");
    } catch(error) { showToast(error.message,true); }
  });
  update();
}
async function checkAirtableSchema(button) {
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const result = await api("/api/integrations/airtable/schema");
    if(result.missingTables.length) showToast(`Schema access works, but these tables are missing: ${result.missingTables.join(", ")}.`,true);
    else showToast(`Airtable schema access verified: ${result.tables.length} tables found.`);
  } catch(error) { showToast(error.message,true); }
  finally { if(button.isConnected){button.disabled=false;button.textContent="Check schema access";} }
}
async function syncAirtable(button) {
  button.disabled = true;
  button.textContent = "Syncing…";
  try {
    state.airtableSync = await api("/api/integrations/airtable/sync",{method:"POST",body:"{}"});
    await refresh();
    showToast(`Airtable sync complete: ${Object.keys(state.airtableSync.tables).length} tables; ${state.airtableSync.updatedWorkRecords} Work updates written; ${state.airtableSync.conflicts.length} conflicts.`);
  } catch(error) { showToast(error.message,true); }
  finally { if(button.isConnected){button.disabled=false;button.textContent="↻ Sync all Airtable tables";} }
}
document.addEventListener("click",async(event)=>{
  const nav = event.target.closest("[data-nav]");
  if (nav) { event.preventDefault(); setNavigation(nav.dataset.nav); return; }
  const airtableTable = event.target.closest("[data-airtable-table]");
  if (airtableTable) {
    state.airtableData.selectedTableId = airtableTable.dataset.airtableTable;
    state.airtableData.query = "";
    state.airtableData.offset = 0;
    await loadAirtableRecords(0);
    return;
  }
  const airtablePage = event.target.closest("[data-airtable-page]");
  if (airtablePage) { await loadAirtableRecords(Number(airtablePage.dataset.airtablePage)); return; }
  const projectLink = event.target.closest("[data-project]");
  if (projectLink) { await openProject(projectLink.dataset.project); return; }
  const calendarView = event.target.closest("[data-calendar-view]");
  if (calendarView) { state.calendar.view = calendarView.dataset.calendarView; render(); return; }
  const calendarStep = event.target.closest("[data-calendar-step]");
  if (calendarStep) {
    const step = Number(calendarStep.dataset.calendarStep);
    if (state.calendar.view === "week") state.calendar.cursor = shiftDay(state.calendar.cursor, step * 7);
    else { const date = parseDay(state.calendar.cursor); state.calendar.cursor = isoDay(new Date(date.getFullYear(), date.getMonth() + step, 1)); }
    render(); return;
  }
  if (event.target.closest("[data-calendar-today]")) { state.calendar.cursor = today(); render(); return; }
  const calendarWeek = event.target.closest("[data-calendar-week]");
  if (calendarWeek) { state.calendar = { ...state.calendar, view: "week", cursor: calendarWeek.dataset.calendarWeek }; render(); return; }
  const taskLink = event.target.closest("[data-task]");
  if (taskLink) { await openTask(taskLink.dataset.task); return; }
  const templateLink = event.target.closest("[data-edit-template]");
  if (templateLink) { await openTemplateEditor(templateLink.dataset.editTemplate); return; }
  const tab = event.target.closest("[data-project-tab]");
  if (tab && state.projectData) { state.projectTab=tab.dataset.projectTab; renderProjectPage(); return; }
  const filter = event.target.closest("[data-my-filter]");
  if (filter) { state.myTaskFilter=filter.dataset.myFilter; render(); return; }
  const notificationRead = event.target.closest("[data-read-notification]");
  if (notificationRead) {
    try { await api(`/api/notifications/${encodeURIComponent(notificationRead.dataset.readNotification)}`,{method:"PATCH"}); await refresh(); }
    catch(error) { showToast(error.message,true); }
    return;
  }
  const accountToggle = event.target.closest("[data-account-toggle]");
  if (accountToggle) {
    try {
      await api(`/api/users/${encodeURIComponent(accountToggle.dataset.accountToggle)}/active`, {
        method: "PATCH", body: JSON.stringify({ active: accountToggle.dataset.active === "true" })
      });
      await refresh();
      showToast("Account access updated.");
    } catch (error) { showToast(error.message, true); }
    return;
  }
  const action = event.target.closest("[data-action]");
  if (action) {
    if (action.dataset.action==="logout") {
      try { await api("/api/auth/logout",{method:"POST",body:"{}"}); state.data=null; renderLogin("You have signed out."); }
      catch(error) { showToast(error.message,true); }
    }
    else if (action.dataset.action==="create-project") showProjectForm();
    else if (action.dataset.action==="create-task") showTaskForm();
    else if (action.dataset.action==="replan") showReplan();
    else if (action.dataset.action==="clear-project-filters") {
      state.projectSearch="";
      state.projectStatus="all";
      state.projectFilters={city:"all",state:"all",programType:"all",host:"all",manager:"all",dateFrom:"",dateTo:"",sort:"date-asc"};
      render();
    }
    else if (action.dataset.action==="close-modal") modalRoot.innerHTML="";
    else if (action.dataset.action==="airtable-check") await checkAirtableSchema(action);
    else if (action.dataset.action==="airtable-sync") await syncAirtable(action);
    else if (action.dataset.action==="airtable-refresh-data") await loadAirtableTables();
    else if (action.dataset.action==="mark-all-read") {
      for (const notification of state.data.notifications.filter((item)=>!item.isRead)) {
        try { await api(`/api/notifications/${encodeURIComponent(notification.id)}`,{method:"PATCH"}); } catch(error) { showToast(error.message,true); return; }
      }
      await refresh();
    }
    return;
  }
  if (event.target.matches("[data-close-modal]")) modalRoot.innerHTML="";
});
document.addEventListener("input",(event)=>{
  if(event.target.matches('[data-filter="project-search"]')) { state.projectSearch=event.target.value; render(); const field=document.querySelector('[data-filter="project-search"]'); field?.focus(); field?.setSelectionRange(state.projectSearch.length,state.projectSearch.length); }
  if(event.target.matches('[data-filter="task-search"]')) { state.taskSearch=event.target.value; render(); const field=document.querySelector('[data-filter="task-search"]'); field?.focus(); field?.setSelectionRange(state.taskSearch.length,state.taskSearch.length); }
});
document.addEventListener("change",(event)=>{
  if(event.target.matches('[data-filter="project-status"]')) { state.projectStatus=event.target.value; render(); }
  if(event.target.matches("[data-project-filter]")) {
    state.projectFilters[event.target.dataset.projectFilter]=event.target.value;
    render();
  }
  if(event.target.matches('[data-filter="task-status"]')) { state.taskStatusFilter=event.target.value; render(); }
  if(event.target.matches('[data-filter="task-sort"]')) { state.taskSort=event.target.value; render(); }
  if(event.target.matches("[data-calendar-program]")) { state.calendar.programId=event.target.value; render(); }
  if(event.target.id==="user-select") {
    state.userId=event.target.value;
    localStorage.setItem("nmu-demo-user",state.userId);
    state.projectId=null;
    state.projectData=null;
    refresh();
  }
});
document.addEventListener("submit",async(event)=>{
  if(event.target.id==="airtable-search-form") {
    event.preventDefault();
    state.airtableData.query = String(new FormData(event.target).get("query") || "").trim();
    await loadAirtableRecords(0);
  }
  if(event.target.id==="login-form") {
    event.preventDefault();
    const data=new FormData(event.target);
    const submit=event.target.querySelector('[type="submit"]');
    submit.disabled=true;
    try {
      await api("/api/auth/login",{method:"POST",body:JSON.stringify({email:data.get("email"),password:data.get("password")})});
      await refresh();
    } catch(error) { renderLogin(error.message); }
  }
  if(event.target.id==="create-user-form") {
    event.preventDefault();
    const data=new FormData(event.target);
    const submit=event.target.querySelector('[type="submit"]');
    submit.disabled=true;
    try {
      await api("/api/users",{method:"POST",body:JSON.stringify({
        name:data.get("newUserName"),email:data.get("newUserEmail"),
        role:data.get("newUserRole"),password:data.get("newUserPassword")
      })});
      await refresh();
      showToast("Account created. Share the temporary password privately.");
    } catch(error) { showToast(error.message,true); submit.disabled=false; }
  }
  if(event.target.id==="change-password-form") {
    event.preventDefault();
    const data=new FormData(event.target);
    const submit=event.target.querySelector('[type="submit"]');
    const newPassword=String(data.get("newPassword")||"");
    if(newPassword!==String(data.get("confirmPassword")||"")) {
      showToast("The new passwords do not match.",true);
      return;
    }
    submit.disabled=true;
    try {
      await api("/api/auth/password",{method:"PATCH",body:JSON.stringify({
        currentPassword:data.get("currentPassword"),newPassword
      })});
      event.target.reset();
      showToast("Password updated. Other active sessions were signed out.");
    } catch(error) { showToast(error.message,true); }
    finally { submit.disabled=false; }
  }
  if(event.target.id==="project-form") {
    event.preventDefault();
    const formData=new FormData(event.target);
    const input=Object.fromEntries(formData.entries());
    const submit=event.target.querySelector('[type="submit"]');
    submit.disabled=true;
    try {
      const result=await api("/api/projects",{method:"POST",body:JSON.stringify(input)});
      modalRoot.innerHTML="";
      state.page="projects";
      await refresh();
      await openProject(result.projectId);
      showToast(`Program created with ${result.taskCount} generated tasks.`);
    } catch(error) { showToast(error.message,true); submit.disabled=false; }
  }
  if(event.target.id==="create-task-form") {
    event.preventDefault();
    const data=new FormData(event.target);
    const submit=event.target.querySelector('[type="submit"]');
    submit.disabled=true;
    try {
      await api(`/api/projects/${encodeURIComponent(event.target.dataset.projectId)}/tasks`,{
        method:"POST",
        body:JSON.stringify({
          title:data.get("title"),description:data.get("description"),
          dueDate:data.get("dueDate"),milestone:data.get("milestone"),
          priority:data.get("priority"),assignedUserId:data.get("assignedUserId"),
          dependencyIds:data.getAll("dependencyIds")
        })
      });
      const projectId=event.target.dataset.projectId;
      modalRoot.innerHTML="";
      await refresh();
      await openProject(projectId);
      state.projectTab="tasks";
      renderProjectPage();
      showToast("Task added to the program.");
    } catch(error) { showToast(error.message,true); submit.disabled=false; }
  }
  if(event.target.id==="task-form") {
    event.preventDefault();
    const taskId=event.target.dataset.taskId;
    const data=new FormData(event.target);
    const comment=String(data.get("comment")||"").trim();
    const save=event.target.querySelector('[type="submit"]');
    save.disabled=true;
    try {
      if(event.target.querySelector("#task-due-date")?.type==="date"&&data.get("dueDate")!==event.target.dataset.originalDueDate) {
        await api(`/api/tasks/${encodeURIComponent(taskId)}/due-date`,{method:"PATCH",body:JSON.stringify({dueDate:data.get("dueDate")})});
      }
      if(event.target.querySelector("#task-status")) await api(`/api/tasks/${encodeURIComponent(taskId)}/status`,{method:"PATCH",body:JSON.stringify({status:data.get("status"),overrideReason:data.get("overrideReason")||""})});
      if(event.target.querySelector("#task-assignee")) await api(`/api/tasks/${encodeURIComponent(taskId)}/assignee`,{method:"PATCH",body:JSON.stringify({assignedUserId:data.get("assignedUserId")})});
      if(comment) await api(`/api/tasks/${encodeURIComponent(taskId)}/comments`,{method:"POST",body:JSON.stringify({content:comment})});
      const projectId=state.data.tasks.find((task)=>task.id===taskId)?.projectId;
      modalRoot.innerHTML="";
      await refresh();
      if(projectId===state.projectId) await openProject(projectId);
      showToast("Task updates saved.");
    } catch(error) { showToast(error.message,true); save.disabled=false; }
  }
  if(event.target.id==="template-form") {
    event.preventDefault();
    const form=event.target;
    const save=form.querySelector('[type="submit"]');
    const tasks=[...form.querySelectorAll(".template-task-title")].map((field,index)=>({
      title:field.value,
      description:form.querySelectorAll(".template-task-description")[index].value,
      relativeDueDays:form.querySelectorAll(".template-task-days")[index].value,
      priority:form.querySelectorAll(".template-task-priority")[index].value,
      milestone:form.querySelectorAll(".template-task-milestone")[index].value
    }));
    save.disabled=true;
    try {
      await api(`/api/templates/${encodeURIComponent(form.dataset.templateId)}`,{method:"PATCH",body:JSON.stringify({
        name:form.templateName.value,description:form.templateDescription.value,tasks
      })});
      modalRoot.innerHTML="";
      await refresh();
      showToast("Program template updated.");
    } catch(error) { showToast(error.message,true); save.disabled=false; }
  }
});
document.addEventListener("keydown",(event)=>{ if(event.key==="Escape"&&modalRoot.innerHTML)modalRoot.innerHTML=""; });
refresh();
