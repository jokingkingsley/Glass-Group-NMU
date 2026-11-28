// NMU Program Management server. Airtable is the system of record: every read and
// write goes through airtable-store.js. There is no local database.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { airtableClientFromEnv } from "./airtable-client.js";
import { createAirtableStore, addDays, isValidDate as validateDate } from "./airtable-store.js";
import { T, MAX_UPLOAD_BYTES } from "./airtable-schema.js";
import { planDueDates } from "./plan-dates.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const authRequired = process.env.NMU_AUTH_MODE === "required" || process.env.NODE_ENV === "production";
const client = airtableClientFromEnv(process.env, process.env.NMU_AIRTABLE_MIN_INTERVAL_MS ? { minIntervalMs: Number(process.env.NMU_AIRTABLE_MIN_INTERVAL_MS) } : {});
const store = createAirtableStore({ client, cacheMs: Number(process.env.NMU_AIRTABLE_CACHE_MS || 15_000) });

const nowISO = () => new Date().toISOString();
const roleLabel = {
  admin: "Administrator",
  program_manager: "Program Manager",
  employee: "Employee",
  external_partner: "External Partner"
};

// ------------------------------------------------------------------ authentication

const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const sessionSecret = process.env.NMU_SESSION_SECRET
  || createHash("sha256").update(`nmu-session:${process.env.AIRTABLE_API_KEY || randomBytes(32).toString("hex")}`).digest("hex");
const revokedSessions = new Map();
const failedLoginAttempts = new Map();

function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  return `${salt}:${scryptSync(password, salt, 64).toString("base64url")}`;
}
function verifyPassword(password, storedHash) {
  const [salt, encodedHash] = String(storedHash || "").split(":");
  if (!salt || !encodedHash) return false;
  const expected = Buffer.from(encodedHash, "base64url");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
// A session is a signed cookie: user, expiry, and a fingerprint of the password hash,
// so changing a password ends every other session. Nothing is stored server-side.
const passwordFingerprint = (hash) => createHash("sha256").update(String(hash || "")).digest("base64url").slice(0, 16);
const sign = (payload) => createHmac("sha256", sessionSecret).update(payload).digest("base64url");
function issueSession(account) {
  const payload = Buffer.from(JSON.stringify({
    u: account.id, e: Date.now() + sessionLifetimeMs, f: passwordFingerprint(account.password_hash), n: randomBytes(9).toString("base64url")
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function readSession(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!(session.e > Date.now()) || revokedSessions.has(session.n)) return null;
    return session;
  } catch {
    return null;
  }
}
function readCookie(request, name) {
  const cookie = request.headers.cookie || "";
  const value = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : "";
}
function setSessionCookie(response, token, maxAge) {
  const secure = process.env.NODE_ENV === "production" || process.env.NMU_AUTH_MODE === "required";
  response.setHeader("Set-Cookie", `nmu_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
}
function verifySameOrigin(request) {
  if (!authRequired) return true;
  const origin = request.headers.origin;
  if (!origin) return ["GET", "HEAD", "OPTIONS"].includes(request.method);
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}
const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email, role: user.role });
const activeUser = (model, id) => {
  const user = model.usersById.get(id);
  return user?.is_active ? user : null;
};
function currentUser(request, model) {
  if (authRequired) {
    const session = readSession(readCookie(request, "nmu_session"));
    const user = session && activeUser(model, session.u);
    return user && session.f === passwordFingerprint(user.password_hash) ? user : null;
  }
  // Local demo mode: the x-demo-user header picks the identity (first admin by default).
  const demoId = request.headers["x-demo-user"];
  return (demoId && activeUser(model, demoId))
    || model.users.find((user) => user.is_active && user.role === "admin") || null;
}

// Creates (or gives a password to) the administrator named by NMU_ADMIN_EMAIL.
let adminBootstrap = null;
async function ensureAdministrator() {
  if (!authRequired || !client.configured) return;
  const email = String(process.env.NMU_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.NMU_ADMIN_PASSWORD || "");
  if (!email || password.length < 12) {
    console.warn("Authentication is required, but NMU_ADMIN_EMAIL and a 12+ character NMU_ADMIN_PASSWORD are needed to provision the initial administrator.");
    return;
  }
  const model = await store.model();
  const existing = model.users.find((user) => user.email === email);
  if (!existing) {
    await store.createUser({ name: String(process.env.NMU_ADMIN_NAME || "NMU Administrator").trim(), email, role: "admin", passwordHash: hashPassword(password) });
  } else if (existing.role !== "admin" || !existing.password_hash) {
    const updates = {};
    if (existing.role !== "admin") updates.role = "admin";
    if (existing.role !== "admin" || !existing.password_hash) updates.passwordHash = hashPassword(password);
    await store.updateUser(existing.id, updates);
  }
}
const administratorReady = () => {
  adminBootstrap ||= ensureAdministrator().catch((error) => {
    adminBootstrap = null;
    throw error;
  });
  return adminBootstrap;
};

// ------------------------------------------------------------------ permissions

const canManage = (user) => user.role === "admin";
const canManageTemplates = (user) => canManage(user) || user.role === "program_manager";
const isTaskOwner = (task, userId) => task.assignee_ids.includes(userId);
function projectMemberIds(model, project) {
  const ids = new Set([project.project_manager_id, ...project.team_ids]);
  for (const task of model.tasks) if (task.project_id === project.id) task.assignee_ids.forEach((id) => ids.add(id));
  ids.delete(null);
  return ids;
}
function canAccessProject(model, user, projectId) {
  const project = model.projectsById.get(projectId);
  if (!project) return false;
  if (canManage(user)) return true;
  return projectMemberIds(model, project).has(user.id);
}
const canViewProject = (model, user, projectId) => model.projectsById.has(projectId)
  && (["program_manager", "employee"].includes(user.role) || canAccessProject(model, user, projectId));
function canEditTask(model, user, task) {
  return canManage(user) || (user.role === "program_manager" && canAccessProject(model, user, task.project_id))
    || (["employee", "external_partner"].includes(user.role) && isTaskOwner(task, user.id));
}
// Who gets a template step's task: a teammate linked to the step's Role in Airtable;
// otherwise by app role (the program manager for manager steps).
function resolveStepOwner(model, step, managerId) {
  if (step.role_ids?.length) {
    const match = model.users.filter((user) => user.is_active && user.role !== "external_partner" && user.role_ids.some((id) => step.role_ids.includes(id)))
      .sort((a, b) => (a.id === managerId ? -1 : b.id === managerId ? 1 : a.name.localeCompare(b.name)))[0];
    if (match) return match.id;
  }
  return resolveRoleAssignment(model, step.default_role, managerId);
}
function resolveRoleAssignment(model, role, managerId) {
  if (role === "program_manager") return managerId;
  if (role === "admin" || role === "employee") {
    const match = model.users.filter((user) => user.is_active && user.role === role).sort((a, b) => a.name.localeCompare(b.name))[0];
    if (match) return match.id;
  }
  return managerId;
}

// Files and links: internal teammates on a program can add them to the program;
// anyone who can edit a task can add them to that task. Partners see only their tasks'.
function canAddResource(model, user, projectId, task) {
  if (task) return canEditTask(model, user, task) || (user.role !== "external_partner" && canAccessProject(model, user, projectId));
  return user.role !== "external_partner" && canAccessProject(model, user, projectId);
}
function canSeeResource(model, user, resource) {
  if (!canViewProject(model, user, resource.project_id)) return false;
  if (user.role !== "external_partner") return true;
  const task = model.tasksById.get(resource.task_id);
  return Boolean(task && isTaskOwner(task, user.id));
}
const canRemoveResource = (model, user, resource) => resource.user_id === user.id || canManage(user)
  || (user.role === "program_manager" && canAccessProject(model, user, resource.project_id));
function resourceResponse(model, resource, viewer) {
  let host = null;
  try { host = resource.url ? new URL(resource.url).hostname.replace(/^www\./, "") : null; } catch {}
  return {
    id: resource.id, kind: resource.kind, title: resource.title, url: resource.url, host,
    fileName: resource.file_name, size: resource.size, contentType: resource.content_type,
    downloadUrl: resource.kind === "File" ? `/api/resources/${encodeURIComponent(resource.id)}/file` : null,
    taskId: resource.task_id, taskTitle: model.tasksById.get(resource.task_id)?.title || null,
    addedBy: model.usersById.get(resource.user_id)?.name || "Unknown", createdAt: resource.created_at,
    canRemove: canRemoveResource(model, viewer, resource)
  };
}
function cleanUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) && url.href.length <= 2000 ? url.href : null;
  } catch {
    return null;
  }
}

// Trash: admins, and program managers on the program, can move a program to the
// trash and restore it. Only admins can delete it for good.
const canTrashProject = (user, project) => canManage(user)
  || (user.role === "program_manager" && [project.project_manager_id, ...project.team_ids].includes(user.id));

// ------------------------------------------------------------------ responses

function taskResponse(model, task, viewer) {
  const dependencies = task.prerequisite_ids.map((id) => model.tasksById.get(id)).filter(Boolean)
    .map((item) => ({ id: item.id, title: item.title, status: item.status }));
  const isBlocked = task.status !== "Completed" && dependencies.some((item) => item.status !== "Completed");
  const assignees = task.assignee_ids.map((id) => model.usersById.get(id)).filter(Boolean).map((user) => ({ id: user.id, name: user.name }));
  return {
    id: task.id, projectId: task.project_id, title: task.title, description: task.description,
    assignedUserId: task.assigned_user_id, assignees, assigneeIds: assignees.map((item) => item.id),
    assigneeName: assignees.map((item) => item.name).join(", ") || null,
    status: isBlocked ? "Blocked" : task.status,
    priority: task.priority, dueDate: task.due_date, dueDateOverride: task.due_date_override,
    milestone: task.milestone, completedAt: task.completed_at, isBlocked,
    dependencies, canEdit: canEditTask(model, viewer, task)
  };
}
function projectResponse(model, project) {
  const tasks = model.tasks.filter((task) => task.project_id === project.id);
  const completed = tasks.filter((task) => task.status === "Completed").length;
  const { city = "", state = "", deliveryType = "", region = "" } = project.details;
  return {
    id: project.id, name: project.name, description: project.description, programType: project.program_type,
    location: project.location, hostOrganization: project.host_organization, startDate: project.start_date,
    city, state, deliveryType, region, siteId: project.site_id,
    endDate: project.end_date, status: project.status, projectManagerId: project.project_manager_id,
    projectManagerName: model.usersById.get(project.project_manager_id)?.name || null,
    progress: tasks.length ? Math.round(completed / tasks.length * 100) : 0,
    taskCount: tasks.length, completedCount: completed, details: project.details
  };
}
const visibleProjects = (model, user) => (["admin", "program_manager", "employee"].includes(user.role)
  ? model.projects : model.projects.filter((project) => canAccessProject(model, user, project.id)));
function templateResponse(model, template, { full = true } = {}) {
  return {
    id: template.id, name: template.name, programType: template.program_type, description: template.description,
    tasks: model.templateTasks.filter((step) => step.template_id === template.id).map((step) => ({
      id: step.id, title: step.title, description: step.description, relativeDueDays: step.relative_due_days,
      priority: step.priority, milestone: step.milestone,
      ...(full ? { defaultRole: step.default_role, roleName: step.role_name || "", dependencyIndex: step.dependency_index } : {})
    }))
  };
}
const integrationStatus = () => {
  const status = store.status();
  return {
    airtableConfigured: status.configured, live: true, missingTables: status.missingTables, maxUploadBytes: MAX_UPLOAD_BYTES, lastRead: status.lastRead, lastWrite: status.lastWrite,
    recentFailures: status.recentFailures, refreshSeconds: Math.round((Number(process.env.NMU_AIRTABLE_CACHE_MS) || 15_000) / 1000)
  };
};

function send(response, status, body, contentType = "application/json; charset=utf-8") {
  response.writeHead(status, { "content-type": contentType, "access-control-allow-origin": "same-origin" });
  response.end(contentType.startsWith("application/json") ? JSON.stringify(body) : body);
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("Request body must be valid JSON.")); }
    });
    request.on("error", reject);
  });
}
// Raw request body (file uploads), capped at `limit` bytes.
function readRaw(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      // Too big: keep reading (and discarding) so the 413 reply can still be sent.
      if (size > limit) return reject(Object.assign(new Error("Files can be up to 5 MB. For bigger files, add a Google Drive link instead."), { status: 413 }));
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
const pathId = (path, prefix, suffix = "") => decodeURIComponent(path.slice(prefix.length, suffix ? -suffix.length : undefined));
const logActivity = (projectId, taskId, userId, action, details) => store.logActivity({ projectId, taskId, userId, action, details });
const notifyUsers = (items) => store.notify(items);
const shiftDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

// ------------------------------------------------------------------ routes

async function handleApi(request, response, url) {
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/auth/config") {
    let administratorConfigured = false;
    let administratorError = null;
    if (client.configured) {
      try {
        await administratorReady();
        const model = await store.model();
        administratorConfigured = model.users.some((user) => user.role === "admin" && user.is_active && user.password_hash);
        if (!administratorConfigured) {
          const email = String(process.env.NMU_ADMIN_EMAIL || "").trim();
          const password = String(process.env.NMU_ADMIN_PASSWORD || "");
          administratorError = !email || password.length < 12
            ? "Set NMU_ADMIN_EMAIL and a 12+ character NMU_ADMIN_PASSWORD in the service variables to provision the first administrator."
            : "No active Airtable Users record has administrator access and a password. Check the Users table's Rights and App Access Disabled fields.";
        }
      } catch (error) {
        administratorError = `Could not verify or provision the administrator in Airtable: ${error.message}`;
      }
    } else {
      administratorError = "Airtable is not connected. Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID in the service variables.";
    }
    return send(response, 200, { required: authRequired, administratorConfigured, administratorError, airtableConfigured: client.configured });
  }
  if (!client.configured) {
    return send(response, 503, { error: "Airtable is not connected. Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID in the service variables and restart." });
  }
  if (request.method === "POST" && path === "/api/auth/login") {
    if (!authRequired) return send(response, 404, { error: "Authentication is not enabled in local demo mode." });
    if (!verifySameOrigin(request)) return send(response, 403, { error: "Request origin was not allowed." });
    const forwardedFor = request.headers["x-forwarded-for"];
    const address = (typeof forwardedFor === "string" ? forwardedFor.split(",").at(-1)?.trim() : "") || request.socket.remoteAddress || "unknown";
    const attempt = failedLoginAttempts.get(address);
    if (attempt && attempt.until > Date.now() && attempt.count >= 8) {
      return send(response, 429, { error: "Too many sign-in attempts. Wait 15 minutes and try again." });
    }
    const input = await readBody(request);
    await administratorReady();
    const email = String(input.email || "").trim().toLowerCase();
    const password = String(input.password || "");
    const account = (await store.model()).users.find((user) => user.email === email && user.is_active);
    const isValid = account?.password_hash && password.length <= 1024 && verifyPassword(password, account.password_hash);
    if (!isValid) {
      const current = attempt && attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 15 * 60 * 1000 };
      current.count++;
      failedLoginAttempts.set(address, current);
      return send(response, 401, { error: "Email or password is incorrect." });
    }
    failedLoginAttempts.delete(address);
    setSessionCookie(response, issueSession(account), Math.floor(sessionLifetimeMs / 1000));
    return send(response, 200, { user: publicUser(account) });
  }

  let model = await store.model();
  const user = currentUser(request, model);
  if (!user) return send(response, 401, { error: authRequired ? "Sign in to continue." : "No active administrator found in the Airtable Users table." });
  if (authRequired && !verifySameOrigin(request)) return send(response, 403, { error: "Request origin was not allowed." });

  if (request.method === "POST" && path === "/api/auth/logout") {
    const session = readSession(readCookie(request, "nmu_session"));
    if (session) {
      revokedSessions.set(session.n, session.e);
      for (const [nonce, expires] of revokedSessions) if (expires < Date.now()) revokedSessions.delete(nonce);
    }
    setSessionCookie(response, "", 0);
    return send(response, 200, { ok: true });
  }
  if (request.method === "PATCH" && path === "/api/auth/password") {
    const input = await readBody(request);
    const currentPassword = String(input.currentPassword || "");
    const newPassword = String(input.newPassword || "");
    if (!verifyPassword(currentPassword, user.password_hash)) return send(response, 400, { error: "Current password is incorrect." });
    if (newPassword.length < 12 || newPassword.length > 1024) {
      return send(response, 400, { error: "Passwords must be between 12 and 1,024 characters." });
    }
    const passwordHash = hashPassword(newPassword);
    await store.updateUser(user.id, { passwordHash });
    // Other sessions end (their fingerprint no longer matches); this one is renewed.
    if (authRequired) setSessionCookie(response, issueSession({ ...user, password_hash: passwordHash }), Math.floor(sessionLifetimeMs / 1000));
    return send(response, 200, { ok: true });
  }
  if (request.method === "GET" && path === "/api/users") {
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can view account management." });
    const accounts = model.users.filter((account) => account.role).sort((a, b) => a.name.localeCompare(b.name))
      .map((account) => ({ ...publicUser(account), active: account.is_active }));
    return send(response, 200, { users: accounts });
  }
  if (request.method === "POST" && path === "/api/users") {
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can create accounts." });
    const input = await readBody(request);
    const name = String(input.name || "").trim();
    const email = String(input.email || "").trim().toLowerCase();
    const password = String(input.password || "");
    const role = String(input.role || "");
    if (!name || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return send(response, 400, { error: "Enter a valid name and email address." });
    }
    if (password.length < 12 || password.length > 1024) {
      return send(response, 400, { error: "Passwords must be between 12 and 1,024 characters." });
    }
    if (!roleLabel[role]) return send(response, 400, { error: "Choose a valid account role." });
    if (model.users.some((account) => account.email === email)) return send(response, 409, { error: "An account with that email already exists." });
    const id = await store.createUser({ name, email, role, passwordHash: hashPassword(password) });
    return send(response, 201, { user: { id, name, email, role } });
  }
  if (request.method === "PATCH" && path.startsWith("/api/users/") && path.endsWith("/active")) {
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can manage account access." });
    const accountId = pathId(path, "/api/users/", "/active");
    const input = await readBody(request);
    if (typeof input.active !== "boolean") return send(response, 400, { error: "Account active state must be true or false." });
    const target = model.usersById.get(accountId);
    if (!target || !target.role) return send(response, 404, { error: "Account not found." });
    if (!input.active && target.id === user.id) return send(response, 400, { error: "You cannot disable your own account." });
    if (!input.active && target.role === "admin" && model.users.filter((item) => item.role === "admin" && item.is_active).length <= 1) {
      return send(response, 400, { error: "At least one active administrator account is required." });
    }
    await store.updateUser(target.id, { disabled: !input.active });
    return send(response, 200, { ok: true });
  }
  if (request.method === "GET" && path === "/api/bootstrap") {
    const projects = visibleProjects(model, user);
    const tasks = projects.flatMap((project) => model.tasks
      .filter((task) => task.project_id === project.id && (user.role !== "external_partner" || isTaskOwner(task, user.id)))
      .map((task) => ({ ...taskResponse(model, task, user), projectName: project.name, projectStatus: project.status })));
    const notifications = model.notifications.filter((item) => item.user_id === user.id).slice(0, 20)
      .map((item) => ({ id: item.id, message: item.message, isRead: item.is_read, createdAt: item.created_at, projectId: item.project_id }));
    return send(response, 200, {
      currentUser: { ...publicUser(user), roleLabel: roleLabel[user.role] },
      users: model.users.filter((item) => item.is_active).sort((a, b) => a.name.localeCompare(b.name))
        .map((item) => ({ id: item.id, name: item.name, role: item.role })),
      projects: projects.map((project) => projectResponse(model, project)), tasks, notifications,
      templates: model.templates.map((template) => templateResponse(model, template)),
      integration: integrationStatus(),
      trash: model.trashedProjects.filter((project) => canTrashProject(user, project)).map((project) => ({
        id: project.id, name: project.name, startDate: project.start_date, taskCount: project.task_count,
        deletedAt: project.deleted_at, deletedBy: model.usersById.get(project.deleted_by)?.name || "Unknown",
        canDeleteForever: canManage(user)
      })),
      sites: model.sites.map((site) => ({ id: site.id, label: site.label, name: site.name, location: site.location, city: site.city, state: site.state, region: site.region })),
      regions: model.regions.map((region) => ({ id: region.id, name: region.name })),
      visibleProjectCount: projects.length
    });
  }
  if (request.method === "GET" && path === "/api/projects") {
    return send(response, 200, visibleProjects(model, user).map((project) => projectResponse(model, project)));
  }
  if (request.method === "GET" && path.startsWith("/api/templates/")) {
    if (!canManageTemplates(user)) return send(response, 403, { error: "Only administrators and program managers can edit program templates." });
    const template = model.templates.find((item) => item.id === pathId(path, "/api/templates/"));
    if (!template) return send(response, 404, { error: "Template not found." });
    return send(response, 200, templateResponse(model, template, { full: false }));
  }
  if (request.method === "PATCH" && path.startsWith("/api/templates/")) {
    if (!canManageTemplates(user)) return send(response, 403, { error: "Only administrators and program managers can edit program templates." });
    const template = model.templates.find((item) => item.id === pathId(path, "/api/templates/"));
    if (!template) return send(response, 404, { error: "Template not found." });
    const input = await readBody(request);
    if (typeof input.name !== "string" || !input.name.trim() || !Array.isArray(input.tasks)) {
      return send(response, 400, { error: "A template name and task list are required." });
    }
    const storedSteps = model.templateTasks.filter((step) => step.template_id === template.id);
    if (input.tasks.length !== storedSteps.length || input.tasks.some((task) =>
      typeof task.title !== "string" || !task.title.trim() || !Number.isInteger(Number(task.relativeDueDays))
      || !["Low", "Medium", "High"].includes(task.priority) || typeof task.milestone !== "string" || !task.milestone.trim())) {
      return send(response, 400, { error: "Each existing template task needs a title, whole-number relative deadline, priority, and milestone." });
    }
    await store.updateTemplate(template.id, { name: input.name.trim(), description: String(input.description || "") });
    await store.updateSteps(input.tasks.map((task, index) => ({
      id: storedSteps[index].id, title: task.title.trim(), description: String(task.description || ""),
      relativeDueDays: Number(task.relativeDueDays), priority: task.priority, milestone: task.milestone.trim()
    })));
    return send(response, 200, { ok: true });
  }
  if (request.method === "GET" && path.startsWith("/api/projects/")) {
    const projectId = pathId(path, "/api/projects/");
    if (!canViewProject(model, user, projectId)) return send(response, 404, { error: "Project not found." });
    const project = model.projectsById.get(projectId);
    const managerId = project.project_manager_id;
    const members = [...projectMemberIds(model, project)].map((id) => model.usersById.get(id)).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((member) => ({
        ...publicUser(member),
        projectRole: member.id === managerId ? "Project Manager" : member.role === "external_partner" ? "Host Partner" : "Team Member"
      }));
    const tasks = model.tasks.filter((task) => task.project_id === projectId
      && (user.role !== "external_partner" || isTaskOwner(task, user.id))).map((task) => taskResponse(model, task, user));
    const activities = model.activities.filter((item) => item.project_id === projectId).slice(0, 30)
      .map((item) => ({ id: item.id, action: item.action, details: item.details, createdAt: item.created_at, userName: model.usersById.get(item.user_id)?.name || "System" }));
    const taskIds = new Set(model.tasks.filter((task) => task.project_id === projectId).map((task) => task.id));
    const comments = model.comments.filter((item) => taskIds.has(item.task_id)).slice(0, 30)
      .map((item) => ({ id: item.id, taskId: item.task_id, userName: model.usersById.get(item.user_id)?.name || "Unknown", content: item.content, createdAt: item.created_at }));
    const partner = user.role === "external_partner";
    const resources = model.resources.filter((item) => item.project_id === projectId && canSeeResource(model, user, item))
      .map((item) => resourceResponse(model, item, user));
    const visibleProject = projectResponse(model, project);
    if (partner) visibleProject.details = {};
    return send(response, 200, {
      project: visibleProject,
      members: partner ? members.filter((member) => member.id === user.id) : members,
      tasks,
      activities: partner ? activities.filter((item) => item.userName === user.name) : activities,
      comments: partner ? comments.filter((item) => tasks.some((task) => task.id === item.taskId)) : comments,
      resources
    });
  }
  if (request.method === "POST" && path === "/api/projects") {
    if (user.role === "employee" || user.role === "external_partner") return send(response, 403, { error: "You do not have permission to create programs." });
    const input = await readBody(request);
    // A program happens at a Site. Pick an existing one, or give city/state/host to add one.
    const site = input.siteId ? model.sitesById.get(String(input.siteId)) : null;
    if (input.siteId && !site) return send(response, 400, { error: "Choose a valid site." });
    const location = site ? (site.location || site.region || site.label) : String(input.location || [input.city, input.state].filter(Boolean).join(", ")).trim();
    const region = input.regionId ? model.regions.find((item) => item.id === String(input.regionId)) : null;
    if (input.regionId && !region) return send(response, 400, { error: "Choose a valid region." });
    const endDate = String(input.endDate || input.startDate || "");
    if (["name", "programType", "projectManagerId"].some((key) => !String(input[key] || "").trim())) return send(response, 400, { error: "Complete all required project fields." });
    if (!location) return send(response, 400, { error: "Choose a site, or enter a city and state for a new one." });
    if (!site && !String(input.hostOrganization || "").trim()) return send(response, 400, { error: "Enter the host organization for the new site." });
    if (!validateDate(input.startDate) || !validateDate(endDate) || endDate < input.startDate) return send(response, 400, { error: "Enter valid program dates; the end date must be on or after the start date." });
    const manager = activeUser(model, input.projectManagerId);
    if (!manager || manager.role === "external_partner") return send(response, 400, { error: "Choose an internal employee as the project manager." });
    // Extra team members (besides the manager), chosen in the form.
    const teamIds = [...new Set((Array.isArray(input.teamIds) ? input.teamIds : []).map(String))].filter((id) => id !== manager.id);
    if (teamIds.length > 50 || teamIds.some((id) => !activeUser(model, id))) return send(response, 400, { error: "Choose active teammates for the program team." });
    if (user.id !== manager.id && !teamIds.includes(user.id)) teamIds.push(user.id);
    const creationMode = input.creationMode === "scratch" ? "scratch" : "template";
    const template = creationMode === "template" && input.templateId ? model.templates.find((item) => item.id === input.templateId) : null;
    if (creationMode === "template" && !template) return send(response, 400, { error: "Choose a valid task template, or select Create from scratch." });
    const programHours = input.programHours === "" || input.programHours === undefined || input.programHours === null ? null : Number(input.programHours);
    if (programHours !== null && (!Number.isFinite(programHours) || programHours < 0 || programHours > 24)) {
      return send(response, 400, { error: "Program hours must be between 0 and 24." });
    }
    const name = String(input.name).trim();
    const city = String(input.city || location.split(",")[0] || "").trim();
    const state = String(input.state || location.split(",").slice(1).join(",") || "").trim();
    const leadInstructors = String(input.leadInstructors || "").trim();
    const details = {
      deliveryType: String(input.deliveryType || ""), leadInstructors,
      primaryContact: input.primaryContact || "", contactEmail: input.contactEmail || "",
      shippingAddress: input.shippingAddress || "", participants: Number(input.participants || 0),
      instructorRequirements: input.instructorRequirements || "", volunteerRequirements: input.volunteerRequirements || "",
      specialRequirements: input.specialRequirements || "", notes: input.notes || "", creationMode
    };
    const siteId = site?.id || await store.createSite({
      name: String(input.hostOrganization).trim(), location: [city, state].filter(Boolean).join(", "), regionId: region?.id || null
    });
    const projectId = await store.createProject({
      name, description: String(input.description || ""), programType: input.programType, siteId, programHours,
      startDate: input.startDate, endDate, status: "Planning", managerId: manager.id,
      teamIds, templateId: template?.id || null, details
    });
    const steps = template ? model.templateTasks.filter((step) => step.template_id === template.id) : [];
    // Prep steps that would already be in the past are fitted between today and the start.
    const plan = planDueDates(input.startDate, steps.map((step) => step.relative_due_days));
    let taskIds = [];
    try {
      const owners = steps.map((step) => resolveStepOwner(model, step, manager.id));
      taskIds = await store.createTasks(steps.map((step, index) => ({
        projectId, stepId: step.id, title: step.title, description: step.description, ownerIds: [owners[index]],
        status: "Not Started", priority: step.priority, plannedDue: plan.dates[index], milestone: step.milestone
      })));
      const links = steps.map((step, index) => ({ id: taskIds[index], prerequisiteIds: step.dependency_index ? [taskIds[step.dependency_index - 1]].filter(Boolean) : [] }))
        .filter((item) => item.prerequisiteIds.length);
      await store.updateTasks(links);
      // One notification per person rather than one per task.
      const assigned = new Map();
      owners.forEach((ownerId, index) => { if (ownerId !== user.id) assigned.set(ownerId, [...(assigned.get(ownerId) || []), steps[index].title]); });
      await notifyUsers([...assigned].map(([userId, titles]) => ({
        userId, projectId,
        message: titles.length === 1 ? `New task assigned: ${titles[0]} — ${name}` : `${titles.length} new tasks assigned in ${name}`
      })));
      await logActivity(projectId, null, user.id, "Project created", (template ? `${name} created from ${template.name}.` : `${name} created from scratch.`)
        + (plan.compressed ? ` The template expects ${plan.neededDays} days of lead time but the program starts in ${plan.leadDays}, so earlier steps were fitted between today and the start date.` : ""));
      if (steps.length && taskIds.length !== steps.length) throw new Error(`Only ${taskIds.length} of ${steps.length} template tasks were created in Airtable.`);
    } catch (error) {
      // Best effort: leave no half-built program behind.
      await store.deleteRecords("Work", taskIds).catch(() => {});
      await store.deleteRecords("Session", [projectId]).catch(() => {});
      throw error;
    }
    return send(response, 201, { projectId, taskCount: taskIds.length, compressed: plan.compressed, leadDays: plan.leadDays, neededDays: plan.neededDays });
  }
  if (request.method === "POST" && path.startsWith("/api/projects/") && path.endsWith("/tasks")) {
    const projectId = pathId(path, "/api/projects/", "/tasks");
    const project = model.projectsById.get(projectId);
    if (!project || !(canManage(user) || (user.role === "program_manager" && canAccessProject(model, user, projectId)))) {
      return send(response, 404, { error: "Program not found or you do not have permission to add tasks." });
    }
    const input = await readBody(request);
    const title = String(input.title || "").trim();
    const dueDate = String(input.dueDate || "");
    const milestone = String(input.milestone || "Program operations").trim();
    const priority = String(input.priority || "Medium");
    const assignedUserId = input.assignedUserId ? String(input.assignedUserId) : null;
    const description = String(input.description || "").trim();
    const dependencyIds = Array.isArray(input.dependencyIds) ? [...new Set(input.dependencyIds.map(String))] : [];
    if (!title || title.length > 200 || !milestone || milestone.length > 100 || description.length > 4000) {
      return send(response, 400, { error: "Enter a task name (up to 200 characters), description (up to 4,000 characters), and planning phase (up to 100 characters)." });
    }
    if (dependencyIds.length > 100) return send(response, 400, { error: "A task can have at most 100 prerequisites." });
    if (!validateDate(dueDate)) return send(response, 400, { error: "Enter a valid task deadline." });
    if (!["Low", "Medium", "High"].includes(priority)) return send(response, 400, { error: "Choose Low, Medium, or High priority." });
    if (assignedUserId) {
      const assignee = activeUser(model, assignedUserId);
      if (!assignee || assignee.role === "external_partner") return send(response, 400, { error: "Choose an active internal teammate as the task owner." });
    }
    if (dependencyIds.some((id) => model.tasksById.get(id)?.project_id !== projectId)) {
      return send(response, 400, { error: "Every prerequisite must be a different task in this program." });
    }
    // A date picked by hand is kept when the program timeline moves.
    const [taskId] = await store.createTasks([{
      projectId, title, description, ownerIds: assignedUserId ? [assignedUserId] : [], status: "Not Started",
      priority, dueOverride: dueDate, milestone, prerequisiteIds: dependencyIds
    }]);
    if (assignedUserId && assignedUserId !== user.id) await notifyUsers([{ userId: assignedUserId, projectId, message: `New task assigned: ${title} — ${project.name}` }]);
    await logActivity(projectId, taskId, user.id, "Task created", `${title} added with ${priority.toLowerCase()} priority.`);
    return send(response, 201, { taskId });
  }

  const taskRoute = path.match(/^\/api\/tasks\/([^/]+)(?:\/([a-z-]+))?$/);
  if (taskRoute) {
    const [, rawId, action = ""] = taskRoute;
    const task = model.tasksById.get(decodeURIComponent(rawId));
    if (request.method === "PATCH" && action === "status") {
      if (!task || !canEditTask(model, user, task)) return send(response, 404, { error: "Task not found or you do not have permission to update it." });
      const input = await readBody(request);
      if (!["Not Started", "In Progress", "Completed"].includes(input.status)) return send(response, 400, { error: "Choose a valid task status." });
      if (input.status === "Completed") {
        const open = task.prerequisite_ids.map((id) => model.tasksById.get(id)).filter((item) => item && item.status !== "Completed");
        if (open.length && !(canManage(user) && String(input.overrideReason || "").trim())) {
          return send(response, 409, { error: "Complete prerequisite tasks before marking this task done.", prerequisites: open.map((item) => item.title) });
        }
        if (open.length) await logActivity(task.project_id, task.id, user.id, "Dependency override", `Authorized override: ${String(input.overrideReason).trim()}`);
      }
      await store.updateTasks([{ id: task.id, status: input.status, completedAt: input.status === "Completed" ? nowISO() : null }]);
      await logActivity(task.project_id, task.id, user.id, "Status changed", `${task.title}: ${task.status} → ${input.status}.`);
      if (input.status === "Completed") {
        const done = (id) => id === task.id || model.tasksById.get(id)?.status === "Completed";
        const ready = model.tasks.filter((item) => item.prerequisite_ids.includes(task.id) && item.status === "Not Started" && item.prerequisite_ids.every(done));
        await notifyUsers(ready.flatMap((item) => (item.assignee_ids.length ? item.assignee_ids : [user.id])
          .map((userId) => ({ userId, projectId: task.project_id, message: `Task is now ready: ${item.title}` }))));
      }
      return send(response, 200, { ok: true });
    }
    if (request.method === "PATCH" && action === "due-date") {
      if (!["admin", "program_manager"].includes(user.role)) return send(response, 403, { error: "Only management can override task deadlines." });
      if (!task || !canAccessProject(model, user, task.project_id)) return send(response, 404, { error: "Task not found." });
      const input = await readBody(request);
      if (!validateDate(input.dueDate)) return send(response, 400, { error: "Enter a valid task deadline." });
      await store.updateTasks([{ id: task.id, dueOverride: input.dueDate }]);
      await logActivity(task.project_id, task.id, user.id, "Deadline overridden", `${task.title}: ${task.due_date} → ${input.dueDate}. This date will be preserved during program timeline changes.`);
      return send(response, 200, { ok: true });
    }
    if (request.method === "POST" && action === "comments") {
      if (!task || !canAccessProject(model, user, task.project_id)
        || (user.role === "external_partner" && !isTaskOwner(task, user.id))) return send(response, 404, { error: "Task not found." });
      const input = await readBody(request);
      const content = String(input.content || "").trim();
      if (!content || content.length > 2000) return send(response, 400, { error: "Enter a comment of 1–2,000 characters." });
      await store.addComment({ taskId: task.id, userId: user.id, content });
      await logActivity(task.project_id, task.id, user.id, "Comment added", content);
      return send(response, 201, { ok: true });
    }
    if (request.method === "PATCH" && action === "assignees") {
      if (!["admin", "program_manager"].includes(user.role)) return send(response, 403, { error: "Only management and program managers can change task owners." });
      if (!task || !canAccessProject(model, user, task.project_id)) return send(response, 404, { error: "Task not found." });
      const input = await readBody(request);
      const ids = Array.isArray(input.assignedUserIds) ? [...new Set(input.assignedUserIds.map(String))] : null;
      if (!ids || !ids.length || ids.length > 8) return send(response, 400, { error: "Choose between 1 and 8 task owners." });
      const owners = ids.map((id) => activeUser(model, id));
      if (owners.some((owner) => !owner || owner.role === "external_partner")) return send(response, 400, { error: "Task owners must be active internal teammates." });
      const before = task.assignee_ids;
      if (before.length === ids.length && ids.every((id, index) => before[index] === id)) return send(response, 200, { ok: true, unchanged: true });
      await store.updateTasks([{ id: task.id, ownerIds: ids }]);
      await logActivity(task.project_id, task.id, user.id, "Task owners updated", `${task.title} owners: ${owners.map((owner) => owner.name).join(", ")}.`);
      await notifyUsers(owners.filter((owner) => !before.includes(owner.id) && owner.id !== user.id)
        .map((owner) => ({ userId: owner.id, projectId: task.project_id, message: `New task assigned: ${task.title}` })));
      return send(response, 200, { ok: true });
    }
    if (request.method === "PATCH" && action === "assignee") {
      if (!["admin", "program_manager"].includes(user.role)) return send(response, 403, { error: "Only management and program managers can reassign tasks." });
      if (!task || !canAccessProject(model, user, task.project_id)) return send(response, 404, { error: "Task not found." });
      const input = await readBody(request);
      const assignee = activeUser(model, input.assignedUserId);
      if (!assignee || assignee.role === "external_partner") return send(response, 400, { error: "Choose an internal employee." });
      // The new person becomes the lead owner; other co-owners stay.
      const ownerIds = [assignee.id, ...task.assignee_ids.slice(1).filter((id) => id !== assignee.id)];
      await store.updateTasks([{ id: task.id, ownerIds }]);
      await logActivity(task.project_id, task.id, user.id, "Task reassigned", `${task.title} reassigned to ${assignee.name}.`);
      await notifyUsers([{ userId: assignee.id, projectId: task.project_id, message: `New task assigned: ${task.title}` }]);
      return send(response, 200, { ok: true });
    }
    if (request.method === "PATCH" && action === "") {
      if (!task || !canEditTask(model, user, task)) return send(response, 404, { error: "Task not found or you do not have permission to edit it." });
      const input = await readBody(request);
      const title = input.title === undefined ? task.title : String(input.title).trim();
      const description = input.description === undefined ? task.description : String(input.description).trim();
      const priority = input.priority === undefined ? task.priority : String(input.priority);
      if (!title || title.length > 200) return send(response, 400, { error: "Enter a task name of 1–200 characters." });
      if (description.length > 4000) return send(response, 400, { error: "Keep the description under 4,000 characters." });
      if (!["High", "Medium", "Low"].includes(priority)) return send(response, 400, { error: "Choose High, Medium, or Low priority." });
      const changes = [
        title !== task.title ? `name "${task.title}" → "${title}"` : "",
        description !== (task.description || "") ? "description updated" : "",
        priority !== task.priority ? `priority ${task.priority} → ${priority}` : ""
      ].filter(Boolean);
      if (!changes.length) return send(response, 200, { ok: true, unchanged: true });
      await store.updateTasks([{ id: task.id, title, description, priority }]);
      await logActivity(task.project_id, task.id, user.id, "Task edited", `${title}: ${changes.join("; ")}.`);
      return send(response, 200, { ok: true });
    }
  }

  const trashRoute = path.match(/^\/api\/projects\/([^/]+)\/(trash|restore|delete-forever)$/);
  if (trashRoute && request.method === "POST") {
    const projectId = decodeURIComponent(trashRoute[1]);
    const action = trashRoute[2];
    const project = action === "trash" ? model.projectsById.get(projectId) : model.trashedById.get(projectId);
    if (!project || !canTrashProject(user, project)) return send(response, 404, { error: "Program not found, or you can't change it." });
    if (action === "trash") {
      await store.updateProject(projectId, { details: { ...project.raw_details, deletedAt: nowISO(), deletedBy: user.id } });
      await logActivity(projectId, null, user.id, "Program moved to trash", `${project.name} was moved to the trash.`);
      return send(response, 200, { ok: true });
    }
    if (action === "restore") {
      const { deletedAt, deletedBy, ...details } = project.raw_details;
      await store.updateProject(projectId, { details });
      await logActivity(projectId, null, user.id, "Program restored", `${project.name} was restored from the trash.`);
      return send(response, 200, { ok: true });
    }
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can delete a program for good." });
    // Deletes the program, its tasks and its files/links from Airtable. Not reversible.
    const workIds = await store.recordIdsLinkedTo(T.work, "session", projectId);
    const resourceIds = await store.recordIdsLinkedTo(T.resources, "session", projectId);
    await store.deleteRecords(T.resources, resourceIds);
    await store.deleteRecords(T.work, workIds);
    await store.deleteRecords(T.sessions, [projectId]);
    return send(response, 200, { ok: true, deletedTasks: workIds.length });
  }
  const resourceRoute = path.match(/^\/api\/projects\/([^/]+)\/resources\/(links|files)$/);
  if (resourceRoute && request.method === "POST") {
    const projectId = decodeURIComponent(resourceRoute[1]);
    const project = model.projectsById.get(projectId);
    const taskId = url.searchParams.get("taskId") || null;
    const task = taskId ? model.tasksById.get(taskId) : null;
    if (!project || (taskId && task?.project_id !== projectId) || !canAddResource(model, user, projectId, task)) {
      return send(response, 404, { error: "Program or task not found, or you can't add files to it." });
    }
    if (resourceRoute[2] === "links") {
      const input = await readBody(request);
      const link = cleanUrl(input.url);
      const title = String(input.title || "").trim().slice(0, 200);
      if (!link) return send(response, 400, { error: "Enter a full web address starting with https://." });
      let label = title;
      if (!label) { try { label = new URL(link).hostname.replace(/^www\./, ""); } catch { label = link; } }
      const id = await store.addLink({ projectId, taskId, userId: user.id, title: label, url: link });
      await logActivity(projectId, taskId, user.id, "Link added", task ? `${label} added to ${task.title}.` : `${label} added to program resources.`);
      return send(response, 201, { id });
    }
    const fileName = String(url.searchParams.get("name") || "").replace(/[\\/\u0000-\u001f]/g, "_").trim().slice(0, 200);
    if (!fileName) return send(response, 400, { error: "The file needs a name." });
    const declared = Number(request.headers["content-length"] || 0);
    if (declared > MAX_UPLOAD_BYTES) return send(response, 413, { error: "Files can be up to 5 MB. For bigger files, add a Google Drive link instead." });
    const data = await readRaw(request, MAX_UPLOAD_BYTES);
    if (!data.length) return send(response, 400, { error: "The file is empty." });
    const contentType = String(request.headers["content-type"] || "application/octet-stream").split(";")[0].trim().slice(0, 120) || "application/octet-stream";
    const id = await store.addFile({ projectId, taskId, userId: user.id, fileName, contentType, data });
    await logActivity(projectId, taskId, user.id, "File uploaded", task ? `${fileName} attached to ${task.title}.` : `${fileName} added to program resources.`);
    return send(response, 201, { id });
  }
  const singleResource = path.match(/^\/api\/resources\/([^/]+)(\/file)?$/);
  if (singleResource) {
    const resource = model.resources.find((item) => item.id === decodeURIComponent(singleResource[1]));
    if (!resource || !canSeeResource(model, user, resource)) return send(response, 404, { error: "File or link not found." });
    if (request.method === "GET" && singleResource[2]) {
      if (resource.kind !== "File") return send(response, 404, { error: "This resource is a link, not a file." });
      const fileUrl = await store.freshFileUrl(resource.id);
      if (!fileUrl) return send(response, 404, { error: "Airtable has no file for this record yet." });
      response.writeHead(302, { location: fileUrl, "cache-control": "no-store", "referrer-policy": "no-referrer" });
      return response.end();
    }
    if (request.method === "DELETE" && !singleResource[2]) {
      if (!canRemoveResource(model, user, resource)) return send(response, 403, { error: "Only the person who added it or a program manager can remove it." });
      await store.removeResource(resource.id);
      await logActivity(resource.project_id, resource.task_id, user.id, resource.kind === "File" ? "File removed" : "Link removed", `${resource.title} removed.`);
      return send(response, 200, { ok: true });
    }
  }
  if (request.method === "POST" && path === "/api/projects/date-preview") {
    const input = await readBody(request);
    if (!canAccessProject(model, user, input.projectId)) return send(response, 404, { error: "Project not found." });
    if (!["admin", "program_manager"].includes(user.role)) return send(response, 403, { error: "You cannot adjust this program timeline." });
    if (!validateDate(input.startDate)) return send(response, 400, { error: "Enter a valid program start date." });
    const project = model.projectsById.get(input.projectId);
    const shift = shiftDays(project.start_date, input.startDate);
    const changes = model.tasks.filter((task) => task.project_id === project.id && task.status !== "Completed" && !task.due_date_override)
      .map((task) => ({ id: task.id, title: task.title, oldDate: task.due_date, newDate: addDays(task.due_date, shift) }));
    return send(response, 200, { shiftDays: shift, changes });
  }
  if (request.method === "PATCH" && path.startsWith("/api/projects/") && path.endsWith("/start-date")) {
    const projectId = pathId(path, "/api/projects/", "/start-date");
    if (!canAccessProject(model, user, projectId) || !["admin", "program_manager"].includes(user.role)) return send(response, 403, { error: "You cannot adjust this program timeline." });
    const input = await readBody(request);
    if (!validateDate(input.startDate)) return send(response, 400, { error: "Enter a valid program start date." });
    const project = model.projectsById.get(projectId);
    const shift = shiftDays(project.start_date, input.startDate);
    const tasks = model.tasks.filter((task) => task.project_id === projectId && !task.due_date_override);
    const moving = tasks.filter((task) => task.status !== "Completed");
    // Open tasks move. Completed tasks keep their date: one that still follows the
    // base's Due Date formula is pinned with Planned Due Date so the formula can't move it.
    await store.updateTasks([
      ...moving.map((task) => ({ id: task.id, plannedDue: addDays(task.due_date, shift) })),
      ...tasks.filter((task) => task.status === "Completed" && !task.planned_due).map((task) => ({ id: task.id, plannedDue: task.due_date }))
    ]);
    await store.updateProject(projectId, { startDate: input.startDate, endDate: addDays(project.end_date, shift) });
    await logActivity(projectId, null, user.id, "Timeline updated", `Program start date changed from ${project.start_date} to ${input.startDate}. ${moving.length} task dates adjusted; completed and manually overridden dates preserved.`);
    await notifyUsers([...projectMemberIds(model, project)].filter((id) => id !== user.id)
      .map((userId) => ({ userId, projectId, message: `Program timeline updated: ${project.name}` })));
    return send(response, 200, { ok: true });
  }
  if (request.method === "PATCH" && path.startsWith("/api/notifications/")) {
    const notification = model.notifications.find((item) => item.id === pathId(path, "/api/notifications/") && item.user_id === user.id);
    if (!notification) return send(response, 404, { error: "Notification not found." });
    await store.markNotificationRead(notification.id);
    return send(response, 200, { ok: true });
  }

  // Sync status: how fresh the data is and whether recent Airtable writes worked.
  if (request.method === "GET" && path === "/api/integrations/airtable/status") {
    response.setHeader("cache-control", "no-store");
    return send(response, 200, integrationStatus());
  }
  if (request.method === "GET" && path === "/api/integrations/airtable/tables") {
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can inspect Airtable data." });
    response.setHeader("cache-control", "no-store");
    const tables = await store.schema();
    const counted = [];
    for (const table of tables) {
      counted.push({ id: table.id, name: table.name, fields: table.fields, recordCount: (await store.loadTable(table.id)).length, syncedAt: store.status().lastRead });
    }
    return send(response, 200, { tables: counted });
  }
  const airtableRecordsPrefix = "/api/integrations/airtable/tables/";
  if (request.method === "GET" && path.startsWith(airtableRecordsPrefix) && path.endsWith("/records")) {
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can inspect Airtable data." });
    response.setHeader("cache-control", "no-store");
    let tableId;
    try {
      tableId = pathId(path, airtableRecordsPrefix, "/records");
    } catch {
      return send(response, 400, { error: "Invalid Airtable table identifier." });
    }
    const limitValue = Number.parseInt(url.searchParams.get("limit") || "25", 10);
    const offsetValue = Number.parseInt(url.searchParams.get("offset") || "0", 10);
    const limit = Number.isSafeInteger(limitValue) ? Math.min(100, Math.max(1, limitValue)) : 25;
    const offset = Number.isSafeInteger(offsetValue) ? Math.max(0, offsetValue) : 0;
    const query = String(url.searchParams.get("q") || "").trim().slice(0, 200);
    const result = await store.browseTable(tableId, { query, limit, offset });
    if (!result) return send(response, 404, { error: "Airtable table not found." });
    result.table.syncedAt = store.status().lastRead;
    return send(response, 200, { ...result, limit, offset, query });
  }
  if (request.method === "GET" && path === "/api/integrations/airtable/schema") {
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can inspect the Airtable connection." });
    const result = await store.checkSchema();
    return send(response, 200, result);
  }
  return send(response, 404, { error: "API route not found." });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png"
};
const server = createServer(async (request, response) => {
  let pathname = "";
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    pathname = url.pathname;
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const filePath = normalize(join(publicDir, requestedPath));
    if (filePath !== publicDir && !filePath.startsWith(`${publicDir}/`)) return send(response, 403, "Forbidden", "text/plain; charset=utf-8");
    const content = await readFile(filePath);
    return send(response, 200, content, mimeTypes[extname(filePath)] || "application/octet-stream");
  } catch (error) {
    if (error.code === "ENOENT" && pathname && !pathname.startsWith("/api/")) {
      return send(response, 404, "Not found.", "text/plain; charset=utf-8");
    }
    // Airtable errors (rate limit after retries, missing fields, bad token) surface as 502/503.
    const status = error.name === "AirtableError" ? (error.status === 401 || error.status === 403 ? 502 : error.status >= 500 || error.status === 429 ? 503 : 502)
      : error.status || 500;
    if (status >= 500) console.error(error);
    if (!response.headersSent) send(response, status, { error: error.name === "AirtableError" ? `Airtable request failed: ${error.message}` : error.message || "Unexpected server error." });
    else response.end();
  }
});
const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => {
  console.log(`NMU Program Management running at http://localhost:${port}`);
  if (!client.configured) console.warn("Airtable is not configured: set AIRTABLE_API_KEY and AIRTABLE_BASE_ID.");
  else {
    console.log(`Using Airtable base ${process.env.AIRTABLE_BASE_ID}.`);
    administratorReady().catch((error) => console.error(`Could not provision the administrator in Airtable: ${error.message}`));
  }
});
