// Data access for the app. Airtable is the only data store: this module reads the
// tables into plain objects shaped like the rows the server works with, and writes
// every change straight back to Airtable through airtable-client.js.
import {
  T, F, WORK_READ_ONLY, WORK_WRITABLE, WORK_CREATE_ONLY, RIGHTS, COMPUTED_TYPES, COMPUTED_OK, compareSchema
} from "./airtable-schema.js";

// ---------------------------------------------------------------- value helpers

// The REST API returns links as ["recXXX"]; some tools return [{ id }].
export const linkedIds = (value) => (Array.isArray(value) ? value : [])
  .map((item) => (typeof item === "string" ? item : item?.id)).filter((id) => typeof id === "string" && id);
export function textValue(value) {
  if (Array.isArray(value)) return textValue(value[0]);
  if (value && typeof value === "object") return String(value.name ?? value.email ?? "").trim();
  return value === null || value === undefined ? "" : String(value).trim();
}
export function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export const dateValue = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  const day = raw ? String(raw).slice(0, 10) : "";
  return isValidDate(day) ? day : null;
};
const numberValue = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
};
export function addDays(date, days) {
  const result = new Date(`${date}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + Number(days));
  return result.toISOString().slice(0, 10);
}

export function rightsToRole(value) {
  const rights = (Array.isArray(value) ? value : [value]).map((item) => textValue(item).toLowerCase());
  if (rights.some((item) => ["admin", "administrator"].includes(item))) return "admin";
  if (rights.some((item) => ["program manager", "manager", "program_manager"].includes(item))) return "program_manager";
  if (rights.some((item) => ["employee", "contributor", "staff"].includes(item))) return "employee";
  if (rights.some((item) => ["external partner", "partner", "external_partner"].includes(item))) return "external_partner";
  return null;
}
export function taskStatusToApp(value) {
  const status = textValue(value).toLowerCase();
  if (["complete", "completed", "done"].includes(status)) return "Completed";
  if (["in progress", "in-progress", "started", "active"].includes(status)) return "In Progress";
  return "Not Started";
}
export function programStatusToApp(value) {
  const status = textValue(value).toLowerCase();
  if (status.includes("complete") || status.includes("done")) return "Completed";
  if (status.includes("risk")) return "At Risk";
  if (status.includes("track") || status.includes("active")) return "On Track";
  return "Planning";
}
const ALIASES = {
  "not started": ["not started", "not begun", "to do", "todo", "open"],
  "in progress": ["in progress", "started", "active", "doing", "working"],
  completed: ["completed", "complete", "done", "finished"],
  planning: ["planning", "planned", "upcoming", "scheduled", "not started", "pending"],
  "on track": ["on track", "active", "in progress", "ongoing", "running"],
  "at risk": ["at risk", "delayed", "behind", "blocked"],
  admin: ["admin", "administrator"],
  "program manager": ["program manager", "manager"],
  employee: ["employee", "contributor", "staff"],
  "external partner": ["external partner", "partner"]
};

// Effective due date: manual override, then the app's planned date, then the base's formulas.
export function workDueDate(fields = {}) {
  return dateValue(fields[F.work.dueOverride]) || dateValue(fields[F.work.plannedDue])
    || dateValue(fields[F.work.effectiveDue]) || dateValue(fields[F.work.formulaDue]);
}

export function assertWorkWriteFields(records, { creating = false } = {}) {
  const allowed = creating ? [...WORK_WRITABLE, ...WORK_CREATE_ONLY] : WORK_WRITABLE;
  for (const record of records) {
    for (const name of Object.keys(record.fields || {})) {
      if (WORK_READ_ONLY.includes(name) || !allowed.includes(name)) {
        throw new Error(`The app may not write Work.${name}.`);
      }
    }
  }
}

// ---------------------------------------------------------------- store

export function createAirtableStore({ client, cacheMs = 15_000, schemaCacheMs = 300_000 }) {
  const cache = new Map();
  let schemaCache = null;
  let lastRead = null;
  let lastWrite = null;
  let readFailures = 0;
  const failures = [];

  // Tables are cached for `cacheMs`. After that the cached copy is still served while a
  // fresh copy loads in the background, so changes made in Airtable appear within
  // seconds without slowing requests. A table the app just wrote to is always re-read.
  function fetchTable(table, previous) {
    const promise = client.listRecords(table).then((records) => {
      cache.set(table, { records, expires: Date.now() + cacheMs });
      lastRead = new Date().toISOString();
      return records;
    }, (error) => {
      if (previous) cache.set(table, previous); else cache.delete(table);
      readFailures++;
      throw error;
    });
    cache.set(table, { ...previous, promise });
    return promise;
  }
  async function loadTable(table) {
    const cached = cache.get(table);
    if (cached?.records && cached.expires > Date.now()) return cached.records;
    if (cached?.records && cacheMs > 0) {
      if (!cached.promise) fetchTable(table, { records: cached.records, expires: cached.expires }).catch(() => {});
      return cached.records;
    }
    return cached?.promise || fetchTable(table);
  }
  const invalidate = (...tables) => tables.forEach((table) => cache.delete(table));
  // Tables the app adds to the base. Until `airtable:setup` has created them the app
  // still works; it just has no comments, activity, notifications or resources yet.
  const OPTIONAL = new Set([T.comments, T.activity, T.notifications, T.resources, T.regions, T.sites, T.instructors, T.roles]);
  const missingTables = new Set();
  const loadOptional = (table) => loadTable(table).then((records) => { missingTables.delete(table); return records; }, (error) => {
    if (!OPTIONAL.has(table) || ![403, 404].includes(error.status)) throw error;
    missingTables.add(table);
    return [];
  });

  async function schema({ fresh = false } = {}) {
    if (!fresh && schemaCache && schemaCache.expires > Date.now()) return schemaCache.tables;
    const tables = await client.getSchema();
    schemaCache = { tables, expires: Date.now() + schemaCacheMs };
    return tables;
  }
  const liveField = async (table, name) => (await schema()).find((item) => item.name === table)?.fields.find((field) => field.name === name) || null;

  // Picks the base's own select option for a value (case and common synonyms ignored).
  async function choice(table, field, value) {
    if (value === null || value === undefined) return value;
    const live = await liveField(table, field);
    const wanted = String(value).toLowerCase();
    const options = ALIASES[wanted] || [wanted];
    const picked = live?.choices?.find((item) => options.includes(item.toLowerCase())) || value;
    return live?.type === "multipleSelects" ? [picked] : picked;
  }
  // Like choice(), but returns undefined when the base's select has no matching option,
  // so an optional value is left empty instead of failing the whole write (a token
  // without Creator access can't add new options to a select).
  async function optionalChoice(table, field, value) {
    const live = await liveField(table, field);
    if (!["singleSelect", "multipleSelects"].includes(live?.type)) return choice(table, field, value);
    const picked = await choice(table, field, value);
    return (live.choices || []).includes(Array.isArray(picked) ? picked[0] : picked) ? picked : undefined;
  }
  async function assertWritable(table, names) {
    // A field added since the schema was cached (e.g. by airtable:setup) shouldn't
    // need a restart: re-read the schema once before reporting it missing.
    const has = (tables) => {
      const found = tables.find((item) => item.name === table);
      return found && names.every((name) => found.fields.some((field) => field.name === name));
    };
    if (!has(await schema())) await schema({ fresh: true });
    const live = (await schema()).find((item) => item.name === table);
    if (!live) throw Object.assign(new Error(`The Airtable base has no "${table}" table. Run npm run airtable:setup -- --apply.`), { status: 503 });
    for (const name of names) {
      const field = live.fields.find((item) => item.name === name);
      if (!field) throw Object.assign(new Error(`Airtable table "${table}" has no "${name}" field. Run npm run airtable:setup -- --apply.`), { status: 503 });
      if (COMPUTED_TYPES.has(field.type)) throw Object.assign(new Error(`${table}.${name} is a ${field.type} field in Airtable and cannot be written.`), { status: 503 });
    }
  }
  const fieldNames = (records) => [...new Set(records.flatMap((record) => Object.keys(record.fields)))];
  async function write(kind, table, records, options = {}) {
    if (!records.length) return [];
    if (table === T.work) assertWorkWriteFields(kind === "delete" ? [] : records, { creating: kind === "create" });
    if (kind !== "delete") {
      // Leave formula versions of optional fields (Session Name, End Date) to the base.
      const live = (await schema()).find((item) => item.name === table);
      const skip = new Set((live?.fields || []).filter((field) => COMPUTED_TYPES.has(field.type) && COMPUTED_OK.has(`${table}.${field.name}`)).map((field) => field.name));
      if (skip.size) records = records.map((record) => ({ ...record, fields: Object.fromEntries(Object.entries(record.fields).filter(([name]) => !skip.has(name))) }));
      await assertWritable(table, fieldNames(records));
    }
    try {
      const result = kind === "create" ? await client.createRecords(table, records, { typecast: true, ...options })
        : kind === "update" ? await client.updateRecords(table, records, { typecast: true, ...options })
          : await client.deleteRecords(table, records);
      lastWrite = { at: new Date().toISOString(), table, kind, count: records.length };
      return result;
    } catch (error) {
      failures.unshift({ at: new Date().toISOString(), table, kind, message: error.message });
      failures.length = Math.min(failures.length, 20);
      throw error;
    } finally {
      invalidate(table);
    }
  }
  const create = (table, records) => write("create", table, records);
  const update = (table, records) => write("update", table, records);
  const destroy = (table, ids) => write("delete", table, ids);
  async function dateFor(table, field, isoTimestamp) {
    return (await liveField(table, field))?.type === "dateTime" ? isoTimestamp : isoTimestamp.slice(0, 10);
  }

  // ------------------------------------------------------------ reading

  async function model() {
    const [userRecords, templateRecords, stepRecords, sessionRecords, workRecords, commentRecords, activityRecords, notificationRecords, resourceRecords,
      regionRecords, siteRecords, instructorRecords, roleRecords] =
      await Promise.all([T.users, T.templates, T.steps, T.sessions, T.work, T.comments, T.activity, T.notifications, T.resources,
        T.regions, T.sites, T.instructors, T.roles].map(loadOptional));
    // Roles (job roles in the base): name from the table's primary field.
    const rolesTable = roleRecords.length ? (await schema()).find((table) => table.name === T.roles) : null;
    const rolePrimary = rolesTable?.fields.find((field) => field.id === rolesTable.primaryFieldId)?.name || F.roles.name;
    const roleNames = new Map(roleRecords.map((record) => [record.id, textValue(record.fields?.[rolePrimary])]));

    const users = userRecords.map((record) => {
      const f = record.fields || {};
      const email = textValue(f[F.users.email]).toLowerCase();
      const role = rightsToRole(f[F.users.rights]);
      return {
        id: record.id, email, role,
        name: [textValue(f[F.users.firstName]), textValue(f[F.users.lastName])].filter(Boolean).join(" ") || email || record.id,
        password_hash: textValue(f[F.users.passwordHash]) || null,
        role_ids: linkedIds(f[F.users.roles]),
        is_active: Boolean(role) && !f[F.users.disabled] && !/inactive|disabled|former|archived/i.test(textValue(f[F.users.status]))
      };
    });
    const usersById = new Map(users.map((user) => [user.id, user]));

    const templates = templateRecords.filter((record) => !/archiv|inactive|retired/i.test(textValue(record.fields?.[F.templates.status]))).map((record) => ({
      id: record.id,
      name: textValue(record.fields?.[F.templates.name]) || textValue(Object.values(record.fields || {})[0]) || record.id,
      program_type: textValue(record.fields?.[F.templates.deliveryType]),
      description: textValue(record.fields?.[F.templates.description])
    })).sort((a, b) => a.name.localeCompare(b.name));
    const stepsById = new Map(stepRecords.map((record) => [record.id, record]));
    const templateTasks = [];
    for (const template of templates) {
      const listed = linkedIds(templateRecords.find((record) => record.id === template.id).fields?.[F.templates.steps]);
      const steps = stepRecords.filter((record) => linkedIds(record.fields?.[F.steps.template]).includes(template.id) || listed.includes(record.id));
      steps.sort((a, b) => (numberValue(a.fields?.[F.steps.days]) ?? 0) - (numberValue(b.fields?.[F.steps.days]) ?? 0)
        || (numberValue(a.fields?.[F.steps.order]) ?? 1e9) - (numberValue(b.fields?.[F.steps.order]) ?? 1e9)
        || String(a.createdTime).localeCompare(String(b.createdTime)));
      steps.forEach((record, index) => {
        const f = record.fields || {};
        const legacy = F.steps.legacyDependencies.map((name) => linkedIds(f[name])).flat()[0];
        const legacyIndex = legacy ? steps.findIndex((item) => item.id === legacy) + 1 : null;
        templateTasks.push({
          id: record.id, template_id: template.id, order: index,
          title: textValue(f[F.steps.title]) || textValue(f.Unique) || `Step ${index + 1}`,
          description: textValue(f[F.steps.description]),
          relative_due_days: numberValue(f[F.steps.days]) ?? 0,
          role_ids: linkedIds(f[F.steps.roles]),
          role_name: linkedIds(f[F.steps.roles]).map((id) => roleNames.get(id)).filter(Boolean).join(", "),
          default_role: (() => {
            const mapped = linkedIds(f[F.steps.roles]).map((id) => rightsToRole(roleNames.get(id))).find(Boolean);
            return ["admin", "employee"].includes(mapped) ? mapped : "program_manager";
          })(),
          priority: ["High", "Medium", "Low"].find((level) => level.toLowerCase() === textValue(f[F.steps.priority]).toLowerCase()) || "Medium",
          milestone: textValue(f[F.steps.milestone]) || "Planning",
          dependency_index: numberValue(f[F.steps.dependsOn]) ?? (legacyIndex || null)
        });
      });
    }

    const regions = regionRecords.map((record) => ({ id: record.id, name: textValue(record.fields?.[F.regions.name]) || record.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const regionsById = new Map(regions.map((region) => [region.id, region]));
    const sites = siteRecords.map((record) => {
      const f = record.fields || {};
      const location = textValue(f[F.sites.location]);
      const [city, ...rest] = location.split(",");
      const regionId = linkedIds(f[F.sites.region])[0] || null;
      const name = textValue(f[F.sites.name]);
      return {
        id: record.id, name, location, city: city.trim(), state: rest.join(",").trim(),
        region_id: regionId, region: regionsById.get(regionId)?.name || "",
        label: textValue(f[F.sites.label]) || [name, location].filter(Boolean).join(" · ") || record.id
      };
    }).sort((a, b) => a.label.localeCompare(b.label));
    const sitesById = new Map(sites.map((site) => [site.id, site]));
    const instructorsById = new Map(instructorRecords.map((record) => [record.id, textValue(record.fields?.[F.instructors.name])]));

    const projects = [];
    for (const record of sessionRecords) {
      const f = record.fields || {};
      const start = dateValue(f[F.sessions.startDate]);
      if (!start) continue;
      const end = dateValue(f[F.sessions.endDate]);
      let details = {};
      try { details = JSON.parse(textValue(f[F.sessions.details]) || "{}"); } catch { details = {}; }
      const site = sitesById.get(linkedIds(f[F.sessions.site])[0]) || null;
      const city = site?.city || textValue(details.city);
      const state = site?.state || textValue(details.state);
      const hours = numberValue(f[F.sessions.hours]);
      const instructorNames = linkedIds(f[F.sessions.instructors]).map((id) => instructorsById.get(id)).filter(Boolean);
      projects.push({
        id: record.id, name: textValue(f[F.sessions.name]) || `Session ${record.id}`,
        description: textValue(f[F.sessions.description]),
        program_type: textValue(f[F.sessions.programType]) || "Community",
        location: site?.location || [city, state].filter(Boolean).join(", ") || site?.region || "Location not set",
        host_organization: site?.name || textValue(details.hostOrganization),
        site_id: site?.id || null, region: site?.region || "",
        start_date: start, end_date: end && end >= start ? end : start,
        status: programStatusToApp(f[F.sessions.status]),
        project_manager_id: linkedIds(f[F.sessions.manager])[0] || null,
        team_ids: linkedIds(f[F.sessions.team]),
        // The JSON as stored, for writing back; `details` below adds derived values.
        raw_details: details,
        deleted_at: textValue(details.deletedAt) || null, deleted_by: textValue(details.deletedBy) || null,
        details: {
          ...details, city, state,
          deliveryType: details.deliveryType || "",
          programHours: hours ?? details.programHours ?? null,
          leadInstructors: instructorNames.join(", ") || details.leadInstructors || "",
          region: site?.region || "",
          sourceTemplateId: linkedIds(f[F.sessions.template])[0] || details.sourceTemplateId || null
        },
        created_at: record.createdTime
      });
    }
    // Programs moved to the trash keep their records but drop out of every view
    // (their tasks, comments and files too) until restored.
    const trashedProjects = projects.filter((project) => project.deleted_at)
      .sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
    for (let index = projects.length - 1; index >= 0; index--) if (projects[index].deleted_at) projects.splice(index, 1);
    const trashedById = new Map(trashedProjects.map((project) => [project.id, project]));
    const trashedTaskCounts = new Map();
    for (const record of workRecords) {
      const id = linkedIds(record.fields?.[F.work.session]).find((item) => trashedById.has(item));
      if (id) trashedTaskCounts.set(id, (trashedTaskCounts.get(id) || 0) + 1);
    }
    trashedProjects.forEach((project) => { project.task_count = trashedTaskCounts.get(project.id) || 0; });
    projects.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.name.localeCompare(b.name));
    const projectsById = new Map(projects.map((project) => [project.id, project]));

    const tasks = [];
    for (const record of workRecords) {
      const f = record.fields || {};
      const project = projectsById.get(linkedIds(f[F.work.session]).find((id) => projectsById.has(id)));
      if (!project) continue;
      const stepId = linkedIds(f[F.work.step])[0] || null;
      const step = stepsById.get(stepId)?.fields || {};
      const ownerIds = linkedIds(f[F.work.owners]).filter((id) => usersById.has(id));
      const override = dateValue(f[F.work.dueOverride]);
      const stepDays = numberValue(step[F.steps.days]);
      tasks.push({
        id: record.id, project_id: project.id, template_task_id: stepId,
        title: textValue(f[F.work.title]) || textValue(step[F.steps.title]) || textValue(f.Unique) || "Untitled task",
        description: textValue(f[F.work.description]) || textValue(step[F.steps.description]),
        assignee_ids: ownerIds, assigned_user_id: ownerIds[0] || null,
        status: taskStatusToApp(f[F.work.status]),
        priority: ["High", "Medium", "Low"].find((level) => level.toLowerCase() === textValue(f[F.work.priority]).toLowerCase())
          || ["High", "Medium", "Low"].find((level) => level.toLowerCase() === textValue(step[F.steps.priority]).toLowerCase()) || "Medium",
        due_date: workDueDate(f) || (stepDays !== null ? addDays(project.start_date, stepDays) : project.start_date),
        due_date_override: Boolean(override), planned_due: dateValue(f[F.work.plannedDue]),
        milestone: textValue(f[F.work.milestone]) || textValue(step[F.steps.milestone]) || "Planning",
        completed_at: dateValue(f[F.work.completedDate]),
        prerequisite_ids: linkedIds(f[F.work.prerequisites]),
        step_dependency_ids: F.steps.legacyDependencies.map((name) => linkedIds(step[name])).flat(),
        created_at: record.createdTime
      });
    }
    // Prerequisites: the task's own links; older Work rows fall back to Step dependencies.
    const byProjectStep = new Map(tasks.filter((task) => task.template_task_id).map((task) => [`${task.project_id}:${task.template_task_id}`, task.id]));
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
      const links = task.prerequisite_ids.length ? task.prerequisite_ids
        : task.step_dependency_ids.map((stepId) => byProjectStep.get(`${task.project_id}:${stepId}`)).filter(Boolean);
      task.prerequisite_ids = links.filter((id) => id !== task.id && tasksById.get(id)?.project_id === task.project_id);
      delete task.step_dependency_ids;
    }
    tasks.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.title.localeCompare(b.title));

    const comments = commentRecords.map((record) => ({
      id: record.id, task_id: linkedIds(record.fields?.[F.comments.work])[0] || null,
      user_id: linkedIds(record.fields?.[F.comments.author])[0] || null,
      content: textValue(record.fields?.[F.comments.text]), created_at: record.createdTime
    })).filter((comment) => tasksById.has(comment.task_id));
    const activities = activityRecords.map((record) => ({
      id: record.id, project_id: linkedIds(record.fields?.[F.activity.session])[0] || null,
      task_id: linkedIds(record.fields?.[F.activity.work])[0] || null,
      user_id: linkedIds(record.fields?.[F.activity.user])[0] || null,
      action: textValue(record.fields?.[F.activity.action]), details: textValue(record.fields?.[F.activity.details]),
      created_at: record.createdTime
    }));
    const notifications = notificationRecords.map((record) => ({
      id: record.id, user_id: linkedIds(record.fields?.[F.notifications.user])[0] || null,
      project_id: linkedIds(record.fields?.[F.notifications.session])[0] || null,
      message: textValue(record.fields?.[F.notifications.message]),
      is_read: Boolean(record.fields?.[F.notifications.read]), created_at: record.createdTime
    }));
    const resources = resourceRecords.map((record) => {
      const f = record.fields || {};
      const attachment = Array.isArray(f[F.resources.file]) ? f[F.resources.file][0] : null;
      const taskId = linkedIds(f[F.resources.work])[0] || null;
      return {
        id: record.id, kind: textValue(f[F.resources.kind]) === "File" || attachment ? "File" : "Link",
        title: textValue(f[F.resources.title]) || textValue(f[F.resources.fileName]) || attachment?.filename || textValue(f[F.resources.url]),
        url: textValue(f[F.resources.url]) || null,
        file_url: attachment?.url || null,
        file_name: textValue(f[F.resources.fileName]) || attachment?.filename || null,
        size: numberValue(f[F.resources.size]) ?? attachment?.size ?? null,
        content_type: textValue(f[F.resources.contentType]) || attachment?.type || null,
        task_id: taskId,
        project_id: linkedIds(f[F.resources.session])[0] || tasksById.get(taskId)?.project_id || null,
        user_id: linkedIds(f[F.resources.addedBy])[0] || null,
        created_at: record.createdTime
      };
    }).filter((item) => projectsById.has(item.project_id) && (item.kind === "Link" ? item.url : true));
    const newestFirst = (a, b) => String(b.created_at).localeCompare(String(a.created_at));
    comments.sort(newestFirst); activities.sort(newestFirst); notifications.sort(newestFirst); resources.sort(newestFirst);

    return { users, usersById, templates, templateTasks, projects, projectsById, tasks, tasksById, comments, activities, notifications, resources, regions, sites, sitesById, trashedProjects, trashedById };
  }

  // ------------------------------------------------------------ writing

  async function userFields(input) {
    const fields = {};
    if (input.name !== undefined) {
      const [first, ...rest] = String(input.name).trim().split(/\s+/);
      fields[F.users.firstName] = first || "";
      fields[F.users.lastName] = rest.join(" ");
    }
    if (input.email !== undefined) fields[F.users.email] = input.email;
    if (input.role !== undefined) fields[F.users.rights] = await choice(T.users, F.users.rights, RIGHTS[input.role]);
    if (input.passwordHash !== undefined) fields[F.users.passwordHash] = input.passwordHash;
    if (input.disabled !== undefined) fields[F.users.disabled] = Boolean(input.disabled);
    return fields;
  }
  async function projectFields(input) {
    const fields = {};
    const set = (key, field, transform = (value) => value) => { if (input[key] !== undefined) fields[field] = transform(input[key]); };
    set("name", F.sessions.name); set("description", F.sessions.description);
    set("programType", F.sessions.programType);
    set("programHours", F.sessions.hours, (value) => (value === null ? "" : String(value)));
    set("siteId", F.sessions.site, (id) => (id ? [id] : []));
    set("startDate", F.sessions.startDate); set("endDate", F.sessions.endDate);
    // The base's End Date formula is built from Start Date and Duration (Days).
    if (input.startDate && input.endDate) {
      fields[F.sessions.duration] = Math.round((Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / 86400000);
    }
    set("managerId", F.sessions.manager, (id) => (id ? [id] : []));
    set("teamIds", F.sessions.team, (ids) => [...new Set(ids)]);
    set("templateId", F.sessions.template, (id) => (id ? [id] : []));
    set("details", F.sessions.details, (value) => JSON.stringify(value));
    if (input.status !== undefined) {
      // Program status is a select the base owns; if it has no matching option, leave it unset.
      const live = await liveField(T.sessions, F.sessions.status);
      const value = await choice(T.sessions, F.sessions.status, input.status);
      const known = !live || (live.choices || []).includes(Array.isArray(value) ? value[0] : value);
      if (known) fields[F.sessions.status] = value;
    }
    return fields;
  }
  async function taskFields(input) {
    const fields = {};
    const set = (key, field, transform = (value) => value) => { if (input[key] !== undefined) fields[field] = transform(input[key]); };
    set("title", F.work.title); set("description", F.work.description); set("milestone", F.work.milestone);
    set("plannedDue", F.work.plannedDue); set("dueOverride", F.work.dueOverride);
    set("projectId", F.work.session, (id) => [id]);
    set("stepId", F.work.step, (id) => (id ? [id] : []));
    set("ownerIds", F.work.owners, (ids) => [...new Set(ids)]);
    set("prerequisiteIds", F.work.prerequisites, (ids) => [...new Set(ids)]);
    if (input.priority !== undefined) {
      const priority = await optionalChoice(T.work, F.work.priority, input.priority);
      if (priority !== undefined) fields[F.work.priority] = priority;
    }
    if (input.status !== undefined) {
      // A new task with no matching "Not Started" option is simply left blank (= not started).
      const status = input.status === "Not Started" ? await optionalChoice(T.work, F.work.status, input.status) : await choice(T.work, F.work.status, input.status);
      if (status !== undefined) fields[F.work.status] = status;
    }
    if (input.completedAt !== undefined) {
      fields[F.work.completedDate] = input.completedAt ? await dateFor(T.work, F.work.completedDate, input.completedAt) : null;
    }
    return fields;
  }

  async function createSite({ name, location, regionId }) {
    const fields = { [F.sites.name]: name, [F.sites.location]: location };
    if (regionId) fields[F.sites.region] = [regionId];
    return (await create(T.sites, [{ fields }]))[0].id;
  }
  async function createUser(input) { return (await create(T.users, [{ fields: await userFields(input) }]))[0].id; }
  async function updateUser(id, input) { await update(T.users, [{ id, fields: await userFields(input) }]); }
  async function createProject(input) { return (await create(T.sessions, [{ fields: await projectFields(input) }]))[0].id; }
  async function updateProject(id, input) { await update(T.sessions, [{ id, fields: await projectFields(input) }]); }
  async function createTasks(inputs) {
    const records = [];
    for (const input of inputs) records.push({ fields: await taskFields(input) });
    return (await create(T.work, records)).map((record) => record.id);
  }
  async function updateTasks(changes) {
    const records = [];
    for (const { id, ...input } of changes) records.push({ id, fields: await taskFields(input) });
    await update(T.work, records);
  }
  const deleteRecords = (table, ids) => destroy(table, ids);
  async function addComment({ taskId, userId, content }) {
    await create(T.comments, [{ fields: { [F.comments.text]: content, [F.comments.work]: [taskId], [F.comments.author]: [userId] } }]);
  }
  async function logActivity({ projectId, taskId = null, userId = null, action, details }) {
    const fields = { [F.activity.action]: action, [F.activity.details]: details, [F.activity.session]: [projectId] };
    if (taskId) fields[F.activity.work] = [taskId];
    if (userId) fields[F.activity.user] = [userId];
    await create(T.activity, [{ fields }]);
  }
  async function notify(items) {
    await create(T.notifications, items.filter((item) => item.userId).map(({ userId, projectId, message }) => ({ fields: {
      [F.notifications.message]: message, [F.notifications.user]: [userId],
      ...(projectId ? { [F.notifications.session]: [projectId] } : {}), [F.notifications.read]: false
    } })));
  }
  async function markNotificationRead(id) { await update(T.notifications, [{ id, fields: { [F.notifications.read]: true } }]); }
  async function updateTemplate(id, { name, description }) {
    await update(T.templates, [{ id, fields: { [F.templates.name]: name, [F.templates.description]: description } }]);
  }
  async function updateSteps(changes) {
    const records = [];
    for (const step of changes) {
      records.push({ id: step.id, fields: {
        [F.steps.title]: step.title, [F.steps.description]: step.description, [F.steps.days]: step.relativeDueDays,
        ...await (async () => { const priority = await optionalChoice(T.steps, F.steps.priority, step.priority); return priority === undefined ? {} : { [F.steps.priority]: priority }; })(),
        [F.steps.milestone]: step.milestone
      } });
    }
    await update(T.steps, records);
  }

  async function addLink({ projectId, taskId, userId, title, url }) {
    const fields = { [F.resources.title]: title, [F.resources.kind]: await choice(T.resources, F.resources.kind, "Link"), [F.resources.url]: url,
      [F.resources.session]: [projectId], [F.resources.addedBy]: [userId] };
    if (taskId) fields[F.resources.work] = [taskId];
    return (await create(T.resources, [{ fields }]))[0].id;
  }
  // Creates the Resources record, then uploads the bytes into its attachment field.
  // If the upload fails the record is removed again.
  async function addFile({ projectId, taskId, userId, fileName, contentType, data }) {
    const fields = { [F.resources.title]: fileName, [F.resources.kind]: await choice(T.resources, F.resources.kind, "File"),
      [F.resources.fileName]: fileName, [F.resources.size]: data.length, [F.resources.contentType]: contentType,
      [F.resources.session]: [projectId], [F.resources.addedBy]: [userId] };
    if (taskId) fields[F.resources.work] = [taskId];
    await assertWritable(T.resources, [F.resources.file]);
    const [record] = await create(T.resources, [{ fields }]);
    try {
      await client.uploadAttachment(record.id, F.resources.file, { contentType, filename: fileName, data });
      lastWrite = { at: new Date().toISOString(), table: T.resources, kind: "upload", count: 1 };
    } catch (error) {
      failures.unshift({ at: new Date().toISOString(), table: T.resources, kind: "upload", message: error.message });
      await destroy(T.resources, [record.id]).catch(() => {});
      throw error;
    } finally {
      invalidate(T.resources);
    }
    return record.id;
  }
  // Attachment URLs from Airtable expire after a few hours, so downloads read a fresh one.
  async function freshFileUrl(resourceId) {
    const record = await client.getRecord(T.resources, resourceId);
    const attachment = Array.isArray(record.fields?.[F.resources.file]) ? record.fields[F.resources.file][0] : null;
    return attachment?.url || null;
  }
  const removeResource = (id) => destroy(T.resources, [id]);
  // IDs of records in `table` whose link field (by schema key, e.g. "session") points at `id`.
  async function recordIdsLinkedTo(table, key, id) {
    const field = Object.entries(T).find(([, name]) => name === table)?.[0];
    const records = await loadTable(table).catch(() => []);
    return records.filter((record) => linkedIds(record.fields?.[F[field][key]]).includes(id)).map((record) => record.id);
  }

  async function checkSchema() {
    const tables = await schema({ fresh: true });
    return { tables, ...compareSchema(tables) };
  }
  async function browseTable(tableId, { query = "", limit = 25, offset = 0 } = {}) {
    const table = (await schema()).find((item) => item.id === tableId || item.name === tableId);
    if (!table) return null;
    const records = await loadTable(table.id);
    const needle = query.toLowerCase();
    const matching = needle ? records.filter((record) => JSON.stringify(record.fields || {}).toLowerCase().includes(needle)) : records;
    const page = matching.slice(offset, offset + limit).map((record) => ({ id: record.id, fields: record.fields || {}, syncedAt: record.createdTime }));
    const recordLabels = {};
    for (const linkedId of new Set(table.fields.map((field) => field.linkedTableId).filter(Boolean))) {
      const linked = (await schema()).find((item) => item.id === linkedId);
      const primary = linked?.fields.find((field) => field.id === linked.primaryFieldId)?.name;
      for (const record of await loadTable(linkedId)) {
        const f = record.fields || {};
        const person = [textValue(f[F.users.firstName]), textValue(f[F.users.lastName])].filter(Boolean).join(" ");
        const label = (primary && textValue(f[primary])) || person || textValue(f[F.steps.title]);
        if (label) recordLabels[record.id] = label;
      }
    }
    return { table: { id: table.id, name: table.name, fields: table.fields }, records: page, recordLabels, total: matching.length };
  }
  const status = () => ({ configured: client.configured, missingTables: [...missingTables], lastRead, lastWrite, recentFailures: failures.slice(0, 5), retries: client.stats?.retries || 0, readFailures });

  return {
    client, schema, model, invalidate, loadTable, status, checkSchema, browseTable,
    createUser, updateUser, createProject, updateProject, createTasks, updateTasks, deleteRecords,
    addComment, logActivity, notify, markNotificationRead, updateTemplate, updateSteps,
    addLink, addFile, freshFileUrl, removeResource, createSite, recordIdsLinkedTo
  };
}
