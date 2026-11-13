import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AIRTABLE_TABLE_NAMES, appStatusToAirtable, airtableStatusToApp,
  fetchAirtableRecords, fetchAirtableSchema, linkedRecordIds,
  updateAirtableRecords
} from "./airtable-sync.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const dataDir = join(root, ".data");
await mkdir(dataDir, { recursive: true });
const database = new DatabaseSync(process.env.NMU_DATABASE_PATH || join(dataDir, "nmu.sqlite"));
const authRequired = process.env.NMU_AUTH_MODE === "required" || process.env.NODE_ENV === "production";
database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('admin','program_manager','employee','external_partner')),
    password_hash TEXT, is_active INTEGER NOT NULL DEFAULT 1, airtable_record_id TEXT
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    program_type TEXT NOT NULL, location TEXT NOT NULL, host_organization TEXT DEFAULT '',
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Planning',
    project_manager_id TEXT REFERENCES users(id), details_json TEXT NOT NULL DEFAULT '{}',
    airtable_record_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_role TEXT NOT NULL DEFAULT 'Member', PRIMARY KEY(project_id,user_id)
  );
  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, program_type TEXT NOT NULL, description TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS template_tasks (
    id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    title TEXT NOT NULL, description TEXT DEFAULT '', relative_due_days INTEGER NOT NULL,
    default_role TEXT NOT NULL, priority TEXT NOT NULL, milestone TEXT NOT NULL,
    dependency_index INTEGER
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    template_task_id TEXT REFERENCES template_tasks(id), title TEXT NOT NULL, description TEXT DEFAULT '',
    assigned_user_id TEXT REFERENCES users(id), status TEXT NOT NULL DEFAULT 'Not Started'
      CHECK(status IN ('Not Started','In Progress','Blocked','Completed')),
    priority TEXT NOT NULL DEFAULT 'Medium', due_date TEXT NOT NULL, due_date_override INTEGER NOT NULL DEFAULT 0,
    milestone TEXT NOT NULL DEFAULT 'Planning', completed_at TEXT, airtable_record_id TEXT UNIQUE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    prerequisite_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY(task_id,prerequisite_task_id), CHECK(task_id <> prerequisite_task_id)
  );
  CREATE TABLE IF NOT EXISTS task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, user_id TEXT REFERENCES users(id),
    action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT REFERENCES projects(id),
    message TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS airtable_tables (
    table_id TEXT PRIMARY KEY, table_name TEXT NOT NULL UNIQUE, fields_json TEXT NOT NULL,
    synced_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS airtable_records (
    table_id TEXT NOT NULL REFERENCES airtable_tables(table_id) ON DELETE CASCADE,
    record_id TEXT NOT NULL, fields_json TEXT NOT NULL, synced_at TEXT NOT NULL,
    PRIMARY KEY(table_id,record_id)
  );
  CREATE TABLE IF NOT EXISTS airtable_work_sync (
    record_id TEXT PRIMARY KEY, remote_json TEXT NOT NULL, local_json TEXT NOT NULL,
    synced_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS airtable_sync_conflicts (
    record_id TEXT NOT NULL, field_name TEXT NOT NULL, local_json TEXT NOT NULL,
    remote_json TEXT NOT NULL, detected_at TEXT NOT NULL,
    PRIMARY KEY(record_id,field_name)
  );
  CREATE INDEX IF NOT EXISTS task_project_idx ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS task_assignee_idx ON tasks(assigned_user_id);
  -- A task can have several owners. tasks.assigned_user_id stays the primary owner
  -- (used by Airtable sync and older code); the triggers keep both in step.
  CREATE TABLE IF NOT EXISTS task_assignees (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(task_id,user_id)
  );
  CREATE INDEX IF NOT EXISTS task_assignees_user_idx ON task_assignees(user_id);
  CREATE TRIGGER IF NOT EXISTS task_primary_owner_insert AFTER INSERT ON tasks
    WHEN NEW.assigned_user_id IS NOT NULL
    BEGIN INSERT OR IGNORE INTO task_assignees(task_id,user_id,position) VALUES(NEW.id,NEW.assigned_user_id,0); END;
  CREATE TRIGGER IF NOT EXISTS task_primary_owner_update AFTER UPDATE OF assigned_user_id ON tasks
    WHEN OLD.assigned_user_id IS NOT NEW.assigned_user_id
    BEGIN
      DELETE FROM task_assignees WHERE task_id=NEW.id AND user_id=OLD.assigned_user_id;
      INSERT OR IGNORE INTO task_assignees(task_id,user_id,position)
        SELECT NEW.id,NEW.assigned_user_id,0 WHERE NEW.assigned_user_id IS NOT NULL;
    END;
  CREATE INDEX IF NOT EXISTS activity_project_idx ON activity_logs(project_id,created_at);
`);
// Existing databases: give every task's primary owner a task_assignees row.
database.exec(`INSERT OR IGNORE INTO task_assignees(task_id,user_id,position)
  SELECT id,assigned_user_id,0 FROM tasks WHERE assigned_user_id IS NOT NULL`);
const userColumns = new Set(database.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
if (!userColumns.has("password_hash")) database.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
if (!userColumns.has("is_active")) database.exec("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1");
if (!userColumns.has("airtable_record_id")) database.exec("ALTER TABLE users ADD COLUMN airtable_record_id TEXT");
const taskColumns = new Set(database.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name));
if (!taskColumns.has("airtable_record_id")) database.exec("ALTER TABLE tasks ADD COLUMN airtable_record_id TEXT");
database.exec("CREATE UNIQUE INDEX IF NOT EXISTS task_airtable_record_idx ON tasks(airtable_record_id) WHERE airtable_record_id IS NOT NULL");

const nowISO = () => new Date().toISOString();
const dateOnly = (date) => date.toISOString().slice(0, 10);
const offsetDate = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
};
const users = [
  ["u-catalina", "Catalina", "catalina@nmu.demo", "admin"],
  ["u-mary", "Mary", "mary@nmu.demo", "employee"],
  ["u-jordan", "Jordan Ellis", "jordan@nmu.demo", "program_manager"],
  ["u-taylor", "Taylor Brooks", "taylor@nmu.demo", "admin"],
  ["u-casey", "Casey Nguyen", "casey@nmu.demo", "employee"],
  ["u-sam", "Sam Okafor", "sam@nmu.demo", "employee"],
  ["u-partner", "Alex Rivera", "alex@partner.demo", "external_partner"]
];
const templateDefs = [
  {
    id: "tpl-community", name: "Community Swim Program", programType: "Community",
    description: "Core outreach, staffing, compliance, delivery, and wrap-up workflow.",
    tasks: [
      ["Contact host organization", "Confirm interest, facilities, and local point of contact.", -120, "program_manager", "High", "Host coordination", null],
      ["Define program dates and responsibilities", "Align the host and NMU team on the operating plan.", -112, "admin", "High", "Planning", null],
      ["Research funding opportunities", "Identify grants and sponsorship opportunities.", -105, "employee", "Medium", "Funding", null],
      ["Confirm local partners", "Map community partners and referral channels.", -90, "program_manager", "Medium", "Partnerships", null],
      ["Recruit instructors", "Recruit qualified swim instructors for the program.", -70, "program_manager", "High", "Staffing", null],
      ["Recruit volunteers", "Confirm volunteer coverage and responsibilities.", -63, "employee", "Medium", "Staffing", null],
      ["Complete background checks", "Submit and verify required staff clearances.", -42, "employee", "High", "Compliance", 5],
      ["Prepare registration materials", "Prepare accessible registration and participant information.", -38, "employee", "Medium", "Registration", null],
      ["Order program supplies", "Order and confirm delivery of required equipment.", -28, "employee", "High", "Supplies", null],
      ["Coordinate program marketing", "Share approved program details with the community.", -24, "employee", "Medium", "Outreach", 1],
      ["Finalize staff schedules", "Confirm instructor and volunteer shift coverage.", -14, "program_manager", "High", "Staffing", 4],
      ["Conduct instructor training", "Train and brief program staff.", -7, "program_manager", "High", "Training", 7],
      ["Confirm supplies and host readiness", "Verify equipment arrival and host readiness.", -2, "employee", "High", "Readiness", 8],
      ["Launch program", "Deliver the first program session.", 0, "program_manager", "High", "Program execution", null],
      ["Collect participant feedback", "Collect feedback from participants and host.", 10, "program_manager", "Medium", "Post-program", null],
      ["Complete final program report", "Summarize attendance, outcomes, and lessons learned.", 30, "admin", "Medium", "Post-program", null]
    ]
  },
  {
    id: "tpl-school", name: "School Partnership Series", programType: "School",
    description: "A school-focused workflow with additional calendar and registration coordination.",
    tasks: [
      ["Confirm school partnership", "Confirm school sponsor, facilities, and dates.", -105, "program_manager", "High", "Host coordination", null],
      ["Review school calendar and logistics", "Check calendar, pool access, and transportation.", -85, "program_manager", "High", "Planning", null],
      ["Secure program funding", "Confirm grant or sponsor coverage.", -75, "employee", "High", "Funding", null],
      ["Recruit instructors", "Recruit instructors for the school series.", -60, "program_manager", "High", "Staffing", null],
      ["Prepare family registration", "Prepare registration and family communications.", -45, "employee", "Medium", "Registration", null],
      ["Complete background checks", "Verify staff clearances before assigning sessions.", -35, "employee", "High", "Compliance", 4],
      ["Order swim supplies", "Prepare and ship supplies for the school.", -21, "employee", "Medium", "Supplies", null],
      ["Confirm student roster", "Coordinate the latest participant roster with the school.", -7, "program_manager", "High", "Readiness", null],
      ["Deliver swim series", "Run the scheduled school program.", 0, "program_manager", "High", "Program execution", null],
      ["Share outcomes with school", "Compile outcomes and close the partner loop.", 14, "admin", "Medium", "Post-program", null]
    ]
  },
  {
    id: "tpl-clinic", name: "Swim Safety Clinic", programType: "Clinic",
    description: "A streamlined single-event clinic plan.",
    tasks: [
      ["Confirm community host", "Confirm venue, date, and event expectations.", -60, "program_manager", "High", "Host coordination", null],
      ["Confirm event budget", "Confirm event funding and purchase approvals.", -45, "employee", "Medium", "Funding", null],
      ["Recruit clinic instructors", "Recruit qualified instructors.", -35, "program_manager", "High", "Staffing", null],
      ["Complete staff clearances", "Verify all event staff clearances.", -21, "employee", "High", "Compliance", 3],
      ["Promote clinic registration", "Distribute approved event registration information.", -18, "employee", "Medium", "Outreach", null],
      ["Prepare clinic equipment", "Prepare equipment and confirm delivery.", -7, "employee", "Medium", "Supplies", null],
      ["Deliver swim safety clinic", "Host the clinic and record attendance.", 0, "program_manager", "High", "Program execution", null],
      ["Send follow-up and report", "Collect feedback and share an event summary.", 7, "admin", "Low", "Post-program", null]
    ]
  }
];

function seedTemplates() {
  if (database.prepare("SELECT COUNT(*) AS count FROM templates").get().count) return;
  const insertTemplate = database.prepare("INSERT INTO templates(id,name,program_type,description) VALUES(?,?,?,?)");
  const insertTemplateTask = database.prepare(`INSERT INTO template_tasks
    (id,template_id,title,description,relative_due_days,default_role,priority,milestone,dependency_index)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const templateTaskIds = new Map();
  for (const template of templateDefs) {
    insertTemplate.run(template.id, template.name, template.programType, template.description);
    templateTaskIds.set(template.id, []);
    template.tasks.forEach((task, index) => {
      const taskId = `${template.id}-task-${index + 1}`;
      templateTaskIds.get(template.id).push(taskId);
      insertTemplateTask.run(taskId, template.id, ...task);
    });
  }
}

function seedDemoData() {
  if (database.prepare("SELECT COUNT(*) AS count FROM users").get().count) return;
  const insertUser = database.prepare("INSERT INTO users(id,name,email,role) VALUES(?,?,?,?)");
  for (const user of users) insertUser.run(...user);
  seedTemplates();
  const projects = [
    { id: "p-seattle", name: "Seattle Swim Program", type: "Community", location: "Seattle, WA", host: "Rainier Community Center", start: 35, end: 49, status: "On Track", manager: "u-jordan", template: "tpl-community", progress: 0.56 },
    { id: "p-tacoma", name: "Tacoma Swim Program", type: "Community", location: "Tacoma, WA", host: "Eastside Community Hub", start: 16, end: 30, status: "At Risk", manager: "u-jordan", template: "tpl-community", progress: 0.31 },
    { id: "p-portland", name: "Portland Swim Program", type: "School", location: "Portland, OR", host: "Portland Public Schools", start: 77, end: 91, status: "Planning", manager: "u-catalina", template: "tpl-school", progress: 0.19 },
    { id: "p-spokane", name: "Spokane Water Safety Clinic", type: "Clinic", location: "Spokane, WA", host: "South Hill YMCA", start: 51, end: 52, status: "Planning", manager: "u-jordan", template: "tpl-clinic", progress: 0.12 },
    { id: "p-everett", name: "Everett Summer Swim", type: "Community", location: "Everett, WA", host: "Everett Parks & Recreation", start: -35, end: -21, status: "Completed", manager: "u-catalina", template: "tpl-community", progress: 1 },
    { id: "p-olympia", name: "Olympia School Swim Series", type: "School", location: "Olympia, WA", host: "Capital School District", start: 112, end: 126, status: "Planning", manager: "u-jordan", template: "tpl-school", progress: 0.08 }
  ];
  const insertProject = database.prepare(`INSERT INTO projects
    (id,name,description,program_type,location,host_organization,start_date,end_date,status,project_manager_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertMember = database.prepare("INSERT INTO project_members(project_id,user_id,project_role) VALUES(?,?,?)");
  const insertTask = database.prepare(`INSERT INTO tasks
    (id,project_id,template_task_id,title,description,assigned_user_id,status,priority,due_date,milestone,completed_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertDependency = database.prepare("INSERT INTO task_dependencies(task_id,prerequisite_task_id) VALUES(?,?)");
  const roleOwner = { admin: "u-catalina", program_manager: "u-jordan", employee: "u-casey" };
  for (const [projectIndex, project] of projects.entries()) {
    const startDate = offsetDate(project.start);
    const endDate = offsetDate(project.end);
    insertProject.run(project.id, project.name, `${project.type} swim program with ${project.host}.`, project.type,
      project.location, project.host, startDate, endDate, project.status, project.manager, nowISO(), nowISO());
    const members = new Set([project.manager, "u-catalina", "u-mary", "u-casey", "u-sam"]);
    if (project.id === "p-seattle") members.add("u-partner");
    for (const userId of members) insertMember.run(project.id, userId, userId === project.manager ? "Project Manager" : userId === "u-partner" ? "Host Partner" : "Team Member");
    const template = templateDefs.find((item) => item.id === project.template);
    const demoTaskLimit = project.template === "tpl-community" ? 9 : project.template === "tpl-school" ? 8 : 7;
    const taskIds = [];
    template.tasks.slice(0, demoTaskLimit).forEach((task, taskIndex) => {
      const [title, description, relativeDays, role, priority, milestone, dependencyIndex] = task;
      const id = `${project.id}-task-${taskIndex + 1}`;
      taskIds.push(id);
      const dueDate = offsetDate(project.start + relativeDays);
      const status = project.status === "Completed" || (taskIndex / demoTaskLimit < project.progress)
        ? "Completed"
        : taskIndex % 7 === 5 && projectIndex < 3 ? "In Progress" : "Not Started";
      const assignee = project.id === "p-seattle" && taskIndex === 0
        ? "u-partner"
        : role === "program_manager" ? project.manager : roleOwner[role] ?? project.manager;
      insertTask.run(id, project.id, `${project.template}-task-${taskIndex + 1}`, title, description,
        assignee, status, priority, dueDate, milestone, status === "Completed" ? nowISO() : null, nowISO(), nowISO());
      if (dependencyIndex !== null) insertDependency.run(id, `${project.id}-task-${dependencyIndex}`);
    });
  }
  const addActivity = database.prepare("INSERT INTO activity_logs(id,project_id,task_id,user_id,action,details,created_at) VALUES(?,?,?,?,?,?,?)");
  const activitySamples = [
    ["p-seattle", "p-seattle-task-1", "u-jordan", "Project created", "Seattle Swim Program created from the Community Swim Program template.", -11],
    ["p-seattle", "p-seattle-task-5", "u-jordan", "Task assigned", "Recruit instructors assigned to Jordan Ellis.", -4],
    ["p-tacoma", "p-tacoma-task-1", "u-mary", "Update added", "Host is confirming pool availability for the proposed dates.", -3],
    ["p-portland", "p-portland-task-1", "u-catalina", "Project created", "Portland Swim Program created from the School Partnership Series template.", -2],
    ["p-spokane", "p-spokane-task-3", "u-jordan", "Task completed", "Clinic instructors confirmed.", -1]
  ];
  for (const [projectId, taskId, userId, action, details, days] of activitySamples) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    addActivity.run(randomUUID(), projectId, taskId, userId, action, details, date.toISOString());
  }
  const addComment = database.prepare("INSERT INTO task_comments(id,task_id,user_id,content,created_at) VALUES(?,?,?,?,?)");
  addComment.run(randomUUID(), "p-seattle-task-5", "u-jordan", "Host has shared two instructor referrals to follow up with.", nowISO());
  addComment.run(randomUUID(), "p-tacoma-task-1", "u-mary", "Waiting on final pool availability confirmation.", nowISO());
  const addNotification = database.prepare("INSERT INTO notifications(id,user_id,project_id,message,is_read,created_at) VALUES(?,?,?,?,?,?)");
  addNotification.run(randomUUID(), "u-jordan", "p-tacoma", "Tacoma Swim Program has overdue preparation work.", 0, nowISO());
  addNotification.run(randomUUID(), "u-catalina", "p-seattle", "Review the upcoming Seattle program timeline.", 0, nowISO());
}
seedTemplates();
if (authRequired) {
  const adminEmail = String(process.env.NMU_ADMIN_EMAIL || "").trim().toLowerCase();
  const adminPassword = String(process.env.NMU_ADMIN_PASSWORD || "");
  const adminName = String(process.env.NMU_ADMIN_NAME || "NMU Administrator").trim();
  if (adminEmail && adminPassword.length >= 12) {
    const existing = database.prepare("SELECT id,role,password_hash FROM users WHERE email=?").get(adminEmail);
    if (!existing) {
      const salt = randomBytes(16).toString("base64url");
      const hash = scryptSync(adminPassword, salt, 64).toString("base64url");
      database.prepare("INSERT INTO users(id,name,email,role,password_hash) VALUES(?,?,?,'admin',?)")
        .run(randomUUID(), adminName, adminEmail, `${salt}:${hash}`);
    } else if (existing.role === "admin" && !existing.password_hash) {
      const salt = randomBytes(16).toString("base64url");
      const hash = scryptSync(adminPassword, salt, 64).toString("base64url");
      database.prepare("UPDATE users SET password_hash=? WHERE id=?").run(`${salt}:${hash}`, existing.id);
    }
  } else {
    console.warn("Authentication is required, but NMU_ADMIN_EMAIL and a 12+ character NMU_ADMIN_PASSWORD are needed to provision the initial administrator.");
  }
} else {
  seedDemoData();
}

const roleLabel = {
  admin: "Administrator",
  program_manager: "Program Manager",
  employee: "Employee",
  external_partner: "External Partner"
};
const getUser = (id) => database.prepare("SELECT id,name,email,role FROM users WHERE id=? AND is_active=1").get(id);
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const hashSessionToken = (token) => createHash("sha256").update(token).digest("hex");
function readCookie(request, name) {
  const cookie = request.headers.cookie || "";
  const value = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : "";
}
const getCurrentUser = (request) => {
  if (authRequired) {
    const token = readCookie(request, "nmu_session");
    if (!token) return null;
    const session = database.prepare("SELECT user_id,expires_at FROM auth_sessions WHERE token_hash=?").get(hashSessionToken(token));
    if (!session || session.expires_at <= nowISO()) return null;
    return getUser(session.user_id) || null;
  }
  return getUser(request.headers["x-demo-user"] || "u-catalina") || getUser("u-catalina");
};
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
const canManage = (user) => user.role === "admin";
const canManageTemplates = (user) => canManage(user) || user.role === "program_manager";
const isMember = (projectId, userId) => Boolean(database.prepare("SELECT 1 FROM project_members WHERE project_id=? AND user_id=?").get(projectId, userId));
function canAccessProject(user, projectId) {
  if (canManage(user)) return true;
  if (user.role === "program_manager") {
    const project = database.prepare("SELECT project_manager_id FROM projects WHERE id=?").get(projectId);
    return project?.project_manager_id === user.id || isMember(projectId, user.id);
  }
  return isMember(projectId, user.id) || Boolean(database.prepare(
    "SELECT 1 FROM tasks t JOIN task_assignees ta ON ta.task_id=t.id WHERE t.project_id=? AND ta.user_id=?"
  ).get(projectId, user.id));
}
function canViewProject(user, projectId) {
  return user.role === "program_manager" || canAccessProject(user, projectId);
}
const isTaskOwner = (taskId, userId) => Boolean(database.prepare(
  "SELECT 1 FROM task_assignees WHERE task_id=? AND user_id=?").get(taskId, userId));
function canEditTask(user, task) {
  return canManage(user) || (user.role === "program_manager" && canAccessProject(user, task.project_id))
    || (["employee", "external_partner"].includes(user.role) && isTaskOwner(task.id, user.id));
}
function logActivity(projectId, taskId, userId, action, details) {
  database.prepare("INSERT INTO activity_logs(id,project_id,task_id,user_id,action,details,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(randomUUID(), projectId, taskId, userId, action, details, nowISO());
}
function notifyUser(userId, projectId, message) {
  database.prepare("INSERT INTO notifications(id,user_id,project_id,message,created_at) VALUES(?,?,?,?,?)")
    .run(randomUUID(), userId, projectId, message, nowISO());
}
const projectRows = (user) => {
  const where = canManage(user) || user.role === "program_manager" ? ""
    : "WHERE EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=?) OR EXISTS(SELECT 1 FROM tasks t JOIN task_assignees ta ON ta.task_id=t.id WHERE t.project_id=p.id AND ta.user_id=?)";
  const params = canManage(user) || user.role === "program_manager" ? [] : [user.id, user.id];
  return database.prepare(`SELECT p.*,u.name AS manager_name,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) AS task_count,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status='Completed') AS completed_count
    FROM projects p LEFT JOIN users u ON u.id=p.project_manager_id ${where} ORDER BY p.start_date`).all(...params);
};
const taskRows = (projectId) => database.prepare(`SELECT t.*,u.name AS assignee_name,
    COALESCE((SELECT json_group_array(json_object('id',x.id,'name',x.name)) FROM
      (SELECT au.id,au.name FROM task_assignees ta JOIN users au ON au.id=ta.user_id
        WHERE ta.task_id=t.id ORDER BY ta.position,au.name) x),'[]') AS assignees_json,
    COALESCE((SELECT json_group_array(json_object('id',p.id,'title',p.title,'status',p.status))
      FROM task_dependencies d JOIN tasks p ON p.id=d.prerequisite_task_id WHERE d.task_id=t.id),'[]') AS dependencies_json
    FROM tasks t LEFT JOIN users u ON u.id=t.assigned_user_id WHERE t.project_id=? ORDER BY t.due_date,t.title`).all(projectId);
function taskResponse(row, viewer) {
  const dependencies = JSON.parse(row.dependencies_json || "[]");
  const isBlocked = row.status !== "Completed" && dependencies.some((item) => item.status !== "Completed");
  return {
    id: row.id, projectId: row.project_id, title: row.title, description: row.description,
    assignedUserId: row.assigned_user_id,
    assignees: JSON.parse(row.assignees_json || "[]"),
    assigneeIds: JSON.parse(row.assignees_json || "[]").map((item) => item.id),
    assigneeName: JSON.parse(row.assignees_json || "[]").map((item) => item.name).join(", ") || row.assignee_name,
    status: isBlocked ? "Blocked" : row.status,
    priority: row.priority, dueDate: row.due_date, dueDateOverride: Boolean(row.due_date_override),
    milestone: row.milestone, completedAt: row.completed_at, isBlocked,
    dependencies, canEdit: canEditTask(viewer, row)
  };
}
function projectResponse(row) {
  const details = JSON.parse(row.details_json || "{}");
  const [city, ...stateParts] = String(row.location || "").split(",");
  return {
    id: row.id, name: row.name, description: row.description, programType: row.program_type,
    location: row.location, hostOrganization: row.host_organization, startDate: row.start_date,
    city: details.city || city.trim(), state: details.state || stateParts.join(",").trim(),
    deliveryType: details.deliveryType || "",
    endDate: row.end_date, status: row.status, projectManagerId: row.project_manager_id,
    projectManagerName: row.manager_name, progress: Number(row.task_count) ? Math.round(row.completed_count / row.task_count * 100) : 0,
    taskCount: Number(row.task_count), completedCount: Number(row.completed_count),
    details
  };
}
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
function addDays(date, days) {
  const result = new Date(`${date}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + Number(days));
  return dateOnly(result);
}
function validateDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function resolveRoleAssignment(role, managerId) {
  if (role === "program_manager") return managerId;
  if (role === "admin" || role === "employee") {
    const assignee = database.prepare("SELECT id FROM users WHERE role=? AND is_active=1 ORDER BY name LIMIT 1").get(role);
    if (assignee) return assignee.id;
  }
  return managerId;
}

const airtableConfig = () => ({
  apiKey: process.env.AIRTABLE_API_KEY,
  baseId: process.env.AIRTABLE_BASE_ID,
  apiRoot: process.env.AIRTABLE_API_ROOT
});
const jsonValue = (value) => JSON.stringify(value ?? null);
const normalizedDate = (value) => {
  if (!value) return null;
  const date = String(value).slice(0, 10);
  return validateDate(date) ? date : null;
};
const firstNumber = (...values) => {
  for (const value of values.flat(Infinity)) {
    if (value === null || value === undefined || String(value).trim() === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
};
const linkedIds = (fields, name) => linkedRecordIds(fields[name]);
const fieldChoices = (table, fieldName) => table.fields.find((field) => field.name === fieldName)?.choices || [];
function appStatusForProject(value) {
  const status = String(value || "").toLowerCase();
  if (status.includes("complete") || status.includes("done")) return "Completed";
  if (status.includes("risk")) return "At Risk";
  if (status.includes("track") || status.includes("active")) return "On Track";
  return "Planning";
}

let airtableSyncInProgress = false;
async function syncAirtableBase(user) {
  if (airtableSyncInProgress) {
    const error = new Error("An Airtable sync is already running. Wait for it to finish.");
    error.status = 409;
    throw error;
  }
  airtableSyncInProgress = true;
  try {
    return await runAirtableSync(user);
  } finally {
    airtableSyncInProgress = false;
  }
}

async function runAirtableSync(user) {
  const config = airtableConfig();
  const schema = await fetchAirtableSchema(config);
  const tablesByName = new Map(schema.map((table) => [table.name, table]));
  const missingTables = AIRTABLE_TABLE_NAMES.filter((name) => !tablesByName.has(name));
  if (missingTables.length) {
    throw new Error(`The Airtable base is missing expected tables: ${missingTables.join(", ")}.`);
  }
  const requiredFields = [
    ["Session", ["Session Name", "Start Date", "End Date", "Site"]],
    ["Site", ["Program Name", "Program Location"]],
    ["Steps", ["Unique", "Short Description", "Long Description", "Days"]],
    ["Users", ["Email Address", "First Name", "Last Name"]],
    ["Work", ["Unique", "Steps", "Session", "Due Date", "Completed Date", "Status", "Assignee"]]
  ];
  for (const required of requiredFields) {
    const table = tablesByName.get(required[0]);
    const names = new Set(table.fields.map((field) => field.name));
    const missing = required[1].filter((field) => !names.has(field));
    if (missing.length) throw new Error(`Airtable table "${required[0]}" is missing fields: ${missing.join(", ")}.`);
  }
  const stepFields = new Set(tablesByName.get("Steps").fields.map((field) => field.name));
  const stepDependencyField = ["Dependencies", "Dependancies"].find((name) => stepFields.has(name));
  if (!stepDependencyField) {
    throw new Error('Airtable table "Steps" is missing field "Dependencies" (the existing "Dependancies" spelling is also supported).');
  }

  const recordsByTable = new Map();
  for (const table of schema) {
    recordsByTable.set(table.name, await fetchAirtableRecords(config, table.id));
  }
  const recordMaps = new Map([...recordsByTable].map(([name, records]) =>
    [name, new Map(records.map((record) => [record.id, record]))]));
  const sessions = recordsByTable.get("Session");
  const sites = recordMaps.get("Site");
  const steps = recordMaps.get("Steps");
  const airtableUsers = recordMaps.get("Users");
  const workTable = tablesByName.get("Work");
  const adminUser = database.prepare("SELECT id FROM users WHERE id=? AND is_active=1").get(user.id);
  if (!adminUser) throw new Error("The current administrator account is not active.");

  const syncTime = nowISO();
  const syncedCounts = {};
  const conflicts = [];
  const outbound = [];
  let outboundRecordCount = 0;
  let importedProjectCount = 0;
  const workRecords = recordsByTable.get("Work");
  let importedTaskCount = 0;

  const saveMetadata = database.prepare(`INSERT INTO airtable_tables(table_id,table_name,fields_json,synced_at)
    VALUES(?,?,?,?) ON CONFLICT(table_id) DO UPDATE SET table_name=excluded.table_name,
    fields_json=excluded.fields_json,synced_at=excluded.synced_at`);
  const saveRecord = database.prepare(`INSERT INTO airtable_records(table_id,record_id,fields_json,synced_at)
    VALUES(?,?,?,?) ON CONFLICT(table_id,record_id) DO UPDATE SET
    fields_json=excluded.fields_json,synced_at=excluded.synced_at`);
  database.exec("BEGIN");
  try {
    for (const table of schema) {
      const records = recordsByTable.get(table.name);
      saveMetadata.run(table.id, table.name, JSON.stringify(table.fields), syncTime);
      for (const record of records) saveRecord.run(table.id, record.id, JSON.stringify(record.fields || {}), syncTime);
      syncedCounts[table.name] = records.length;
    }

    const updateUser = database.prepare("UPDATE users SET airtable_record_id=? WHERE lower(email)=lower(?)");
    for (const record of airtableUsers.values()) {
      const fields = record.fields || {};
      const email = String(fields["Email Address"] || "").trim();
      if (email) updateUser.run(record.id, email);
    }

    const upsertProject = database.prepare(`INSERT INTO projects
      (id,name,description,program_type,location,host_organization,start_date,end_date,status,
       project_manager_id,airtable_record_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(airtable_record_id) DO UPDATE SET name=excluded.name,description=excluded.description,
      program_type=excluded.program_type,location=excluded.location,host_organization=excluded.host_organization,
      start_date=excluded.start_date,end_date=excluded.end_date,status=excluded.status,updated_at=excluded.updated_at`);
    const findProject = database.prepare("SELECT id,created_at FROM projects WHERE airtable_record_id=?");
    const addProjectMember = database.prepare(`INSERT OR IGNORE INTO project_members(project_id,user_id,project_role)
      VALUES(?,?,'Project Manager')`);
    const siteValue = (site, field) => {
      const value = site?.fields?.[field];
      if (Array.isArray(value)) {
        const first = value[0];
        return first && typeof first === "object" ? String(first.name || "") : String(first || "");
      }
      return String(value || "");
    };
    const programs = recordMaps.get("Programs");
    for (const record of sessions) {
      const fields = record.fields || {};
      const site = sites.get(linkedIds(fields, "Site")[0]);
      const startDate = normalizedDate(fields["Start Date"]);
      const duration = firstNumber(fields["Duration (Days)"]);
      const endDate = normalizedDate(fields["End Date"])
        || (startDate && duration !== null ? addDays(startDate, duration) : null);
      if (!startDate || !endDate || endDate < startDate) continue;
      const existing = findProject.get(record.id);
      const id = existing?.id || randomUUID();
      const sessionName = String(fields["Session Name"] || "").trim();
      const linkedProgram = programs.get(linkedIds(site?.fields || {}, "Program Name")[0]);
      const programName = String(linkedProgram?.fields?.Name || siteValue(site, "Program Name")).trim();
      const projectName = programName && sessionName && programName !== sessionName
        ? `${programName} · ${sessionName}`
        : programName || sessionName || `Airtable session ${record.id}`;
      const locationValue = fields["Program Location"] || siteValue(site, "Program Location")
        || siteValue(site, "Region Site") || "Location not set";
      const location = Array.isArray(locationValue) ? String(locationValue[0] || "Location not set") : String(locationValue);
      upsertProject.run(id, projectName, "", "Community", location, "", startDate, endDate,
        appStatusForProject(fields.Status), user.id, record.id, existing?.created_at || syncTime, syncTime);
      addProjectMember.run(id, user.id);
      importedProjectCount++;
    }

    const upsertTask = database.prepare(`INSERT INTO tasks
      (id,project_id,template_task_id,title,description,assigned_user_id,status,priority,due_date,
       milestone,completed_at,airtable_record_id,created_at,updated_at)
      VALUES(?,?,NULL,?,?,?,?,'Medium',?,'Planning',?,?,?,?)
      ON CONFLICT(airtable_record_id) DO UPDATE SET project_id=excluded.project_id,title=excluded.title,
      description=excluded.description,assigned_user_id=excluded.assigned_user_id,status=excluded.status,
      due_date=excluded.due_date,completed_at=excluded.completed_at,updated_at=excluded.updated_at`);
    const getTask = database.prepare("SELECT * FROM tasks WHERE airtable_record_id=?");
    const getProject = database.prepare("SELECT id,start_date FROM projects WHERE airtable_record_id=?");
    const getUserByAirtableId = database.prepare("SELECT id FROM users WHERE airtable_record_id=? AND is_active=1");
    const getAccountById = database.prepare("SELECT airtable_record_id FROM users WHERE id=?");
    const saveShadow = database.prepare(`INSERT INTO airtable_work_sync(record_id,remote_json,local_json,synced_at)
      VALUES(?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET remote_json=excluded.remote_json,
      local_json=excluded.local_json,synced_at=excluded.synced_at`);
    const getShadow = database.prepare("SELECT remote_json,local_json FROM airtable_work_sync WHERE record_id=?");
    const clearConflict = database.prepare("DELETE FROM airtable_sync_conflicts WHERE record_id=? AND field_name=?");
    const saveConflict = database.prepare(`INSERT INTO airtable_sync_conflicts(record_id,field_name,local_json,remote_json,detected_at)
      VALUES(?,?,?,?,?) ON CONFLICT(record_id,field_name) DO UPDATE SET local_json=excluded.local_json,
      remote_json=excluded.remote_json,detected_at=excluded.detected_at`);
    const workToTask = new Map();
    const workLinkedStepIds = new Map();
    const taskStepIds = new Map();
    for (const record of workRecords) {
      const fields = record.fields || {};
      const sessionId = linkedIds(fields, "Session")[0];
      const project = sessionId ? getProject.get(sessionId) : null;
      const stepId = linkedIds(fields, "Steps")[0];
      const step = stepId ? steps.get(stepId) : null;
      if (!project || !step) continue;
      const prior = getTask.get(record.id);
      const shadow = getShadow.get(record.id);
      const stepFields = step.fields || {};
      const remote = {
        status: airtableStatusToApp(fields.Status),
        dueDate: normalizedDate(fields["Due Date"])
          || addDays(project.start_date, firstNumber(fields["Days (from Steps)"], stepFields.Days) ?? 0),
        completedAt: normalizedDate(fields["Completed Date"]),
        assignee: linkedIds(fields, "Assignee")[0] || null
      };
      const priorRemote = shadow ? JSON.parse(shadow.remote_json) : null;
      const priorLocal = shadow ? JSON.parse(shadow.local_json) : null;
      let local = prior ? {
        status: prior.status,
        dueDate: prior.due_date,
        completedAt: normalizedDate(prior.completed_at),
        assignee: prior.assigned_user_id
          ? getAccountById.get(prior.assigned_user_id)?.airtable_record_id || null
          : null
      } : { ...remote };

      if (priorRemote && priorLocal) {
        for (const field of ["status", "dueDate", "completedAt", "assignee"]) {
          const remoteChanged = jsonValue(remote[field]) !== jsonValue(priorRemote[field]);
          const localChanged = jsonValue(local[field]) !== jsonValue(priorLocal[field]);
          if (remoteChanged && localChanged && jsonValue(remote[field]) !== jsonValue(local[field])) {
            conflicts.push({ recordId: record.id, field, local: local[field], airtable: remote[field] });
            saveConflict.run(record.id, field, jsonValue(local[field]), jsonValue(remote[field]), syncTime);
            continue;
          }
          clearConflict.run(record.id, field);
          if (localChanged && !remoteChanged) {
            const values = remote[field] === local[field] ? null : local[field];
            if (values !== null || (field === "completedAt" && local[field] === null)) {
              const airtableField = {
                status: "Status", dueDate: "Due Date", completedAt: "Completed Date", assignee: "Assignee"
              }[field];
              let value = values;
              if (field === "status") value = appStatusToAirtable(local.status, fieldChoices(workTable, "Status"));
              if (field === "assignee") value = local.assignee ? [{ id: local.assignee }] : [];
              outbound.push({ id: record.id, fields: { [airtableField]: value } });
              remote[field] = local[field];
            }
          } else if (remoteChanged && !localChanged) {
            local[field] = remote[field];
          }
        }
      } else {
        clearConflict.run(record.id, "status");
        clearConflict.run(record.id, "dueDate");
        clearConflict.run(record.id, "completedAt");
        clearConflict.run(record.id, "assignee");
      }

      const userId = local.assignee ? getUserByAirtableId.get(local.assignee)?.id || null : null;
      const title = String(stepFields["Short Description"] || stepFields.Unique || fields.Unique || `Task ${record.id}`);
      const description = String(stepFields["Long Description"] || stepFields["Short Description"] || "");
      const taskId = prior?.id || randomUUID();
      const completedAt = local.completedAt || (local.status === "Completed" ? syncTime : null);
      upsertTask.run(taskId, project.id, title, description, userId, local.status, local.dueDate,
        completedAt, record.id, prior?.created_at || syncTime, syncTime);
      workToTask.set(record.id, taskId);
      taskStepIds.set(taskId, stepId);
      workLinkedStepIds.set(taskId, linkedIds(stepFields, stepDependencyField));
      if (!priorRemote) {
        local = {
          status: local.status,
          dueDate: local.dueDate,
          completedAt: normalizedDate(completedAt),
          assignee: userId ? getAccountById.get(userId)?.airtable_record_id || null : null
        };
        saveShadow.run(record.id, jsonValue(remote), jsonValue(local), syncTime);
      } else if (!conflicts.some((conflict) => conflict.recordId === record.id)) {
        const freshTask = getTask.get(record.id);
        const syncedLocal = {
          status: freshTask.status,
          dueDate: freshTask.due_date,
          completedAt: normalizedDate(freshTask.completed_at),
          assignee: freshTask.assigned_user_id
            ? getAccountById.get(freshTask.assigned_user_id)?.airtable_record_id || null
            : null
        };
        saveShadow.run(record.id, jsonValue(remote), jsonValue(syncedLocal), syncTime);
      }
    }
    const dependencyStepMap = new Map();
    for (const [taskId, stepId] of taskStepIds) {
      const work = workRecords.find((record) => workToTask.get(record.id) === taskId);
      const sessionId = linkedIds(work?.fields || {}, "Session")[0];
      dependencyStepMap.set(`${sessionId}:${stepId}`, taskId);
    }
    const replaceDependencies = database.prepare("DELETE FROM task_dependencies WHERE task_id=?");
    const addDependency = database.prepare("INSERT OR IGNORE INTO task_dependencies(task_id,prerequisite_task_id) VALUES(?,?)");
    for (const [taskId, dependencyIds] of workLinkedStepIds) {
      replaceDependencies.run(taskId);
      const work = workRecords.find((record) => workToTask.get(record.id) === taskId);
      const sessionId = linkedIds(work?.fields || {}, "Session")[0];
      for (const dependencyId of dependencyIds) {
        const prerequisite = dependencyStepMap.get(`${sessionId}:${dependencyId}`);
        if (prerequisite && prerequisite !== taskId) addDependency.run(taskId, prerequisite);
      }
    }
    importedTaskCount = workToTask.size;
    if (outbound.length) {
      const byRecordId = new Map();
      for (const update of outbound) {
        const merged = byRecordId.get(update.id) || { id: update.id, fields: {} };
        Object.assign(merged.fields, update.fields);
        byRecordId.set(update.id, merged);
      }
      const outboundRecords = [...byRecordId.values()];
      await updateAirtableRecords(config, workTable.id, outboundRecords);
      outboundRecordCount = outboundRecords.length;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return {
    tables: syncedCounts,
    projects: importedProjectCount,
    tasks: importedTaskCount,
    updatedWorkRecords: outboundRecordCount,
    conflicts
  };
}

async function handleApi(request, response, url) {
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/auth/config") {
    return send(response, 200, {
      required: authRequired,
      administratorConfigured: Boolean(database.prepare("SELECT 1 FROM users WHERE role='admin' AND password_hash IS NOT NULL AND is_active=1").get())
    });
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
    const email = String(input.email || "").trim().toLowerCase();
    const password = String(input.password || "");
    const account = database.prepare("SELECT id,name,email,role,password_hash FROM users WHERE email=? AND is_active=1").get(email);
    const isValid = account?.password_hash && password.length <= 1024 && verifyPassword(password, account.password_hash);
    if (!isValid) {
      const current = attempt && attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 15 * 60 * 1000 };
      current.count++;
      failedLoginAttempts.set(address, current);
      return send(response, 401, { error: "Email or password is incorrect." });
    }
    failedLoginAttempts.delete(address);
    database.prepare("DELETE FROM auth_sessions WHERE expires_at<=?").run(nowISO());
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
    database.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
      .run(hashSessionToken(token), account.id, expiresAt, nowISO());
    setSessionCookie(response, token, Math.floor(sessionLifetimeMs / 1000));
    return send(response, 200, { user: { id: account.id, name: account.name, email: account.email, role: account.role } });
  }
  const user = getCurrentUser(request);
  if (authRequired && !user) return send(response, 401, { error: "Sign in to continue." });
  if (authRequired && !verifySameOrigin(request)) return send(response, 403, { error: "Request origin was not allowed." });
  if (airtableSyncInProgress && path !== "/api/auth/config") {
    return send(response, 409, { error: "Airtable sync is in progress. Try again shortly." });
  }
  if (request.method === "POST" && path === "/api/auth/logout") {
    const token = readCookie(request, "nmu_session");
    if (token) database.prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(hashSessionToken(token));
    setSessionCookie(response, "", 0);
    return send(response, 200, { ok: true });
  }
  if (request.method === "PATCH" && path === "/api/auth/password") {
    const input = await readBody(request);
    const currentPassword = String(input.currentPassword || "");
    const newPassword = String(input.newPassword || "");
    const account = database.prepare("SELECT password_hash FROM users WHERE id=?").get(user.id);
    if (!verifyPassword(currentPassword, account?.password_hash)) return send(response, 400, { error: "Current password is incorrect." });
    if (newPassword.length < 12 || newPassword.length > 1024) {
      return send(response, 400, { error: "Passwords must be between 12 and 1,024 characters." });
    }
    const token = readCookie(request, "nmu_session");
    const tokenHash = hashSessionToken(token);
    database.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashPassword(newPassword), user.id);
    database.prepare("DELETE FROM auth_sessions WHERE user_id=? AND token_hash<>?").run(user.id, tokenHash);
    return send(response, 200, { ok: true });
  }
  if (request.method === "GET" && path === "/api/users") {
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can view account management." });
    const accounts = database.prepare(`SELECT id,name,email,role,is_active AS active
      FROM users ORDER BY name`).all().map((account) => ({ ...account, active: Boolean(account.active) }));
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
    if (!["admin", "program_manager", "employee", "external_partner"].includes(role)) {
      return send(response, 400, { error: "Choose a valid account role." });
    }
    try {
      const id = randomUUID();
      database.prepare("INSERT INTO users(id,name,email,role,password_hash) VALUES(?,?,?,?,?)")
        .run(id, name, email, role, hashPassword(password));
      return send(response, 201, { user: { id, name, email, role } });
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed: users.email")) {
        return send(response, 409, { error: "An account with that email already exists." });
      }
      throw error;
    }
  }
  if (request.method === "PATCH" && path.startsWith("/api/users/") && path.endsWith("/active")) {
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can manage account access." });
    const accountId = decodeURIComponent(path.slice("/api/users/".length, -"/active".length));
    const input = await readBody(request);
    if (typeof input.active !== "boolean") return send(response, 400, { error: "Account active state must be true or false." });
    const target = database.prepare("SELECT id,role,is_active FROM users WHERE id=?").get(accountId);
    if (!target) return send(response, 404, { error: "Account not found." });
    if (!input.active && target.id === user.id) return send(response, 400, { error: "You cannot disable your own account." });
    if (!input.active && target.role === "admin") {
      const activeAdmins = database.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND is_active=1").get().count;
      if (activeAdmins <= 1) return send(response, 400, { error: "At least one active administrator account is required." });
    }
    database.prepare("UPDATE users SET is_active=? WHERE id=?").run(input.active ? 1 : 0, target.id);
    if (!input.active) database.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(target.id);
    return send(response, 200, { ok: true });
  }
  if (request.method === "GET" && path === "/api/bootstrap") {
    const projects = projectRows(user).map(projectResponse);
    const visibleIds = new Set(projects.map((project) => project.id));
    const tasks = projects.flatMap((project) => taskRows(project.id)
      .filter((task) => user.role !== "external_partner" || isTaskOwner(task.id, user.id))
      .map((task) => ({ ...taskResponse(task, user), projectName: project.name, projectStatus: project.status })));
    const notifications = database.prepare("SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(user.id)
      .map((item) => ({ id: item.id, message: item.message, isRead: Boolean(item.is_read), createdAt: item.created_at, projectId: item.project_id }));
    const templates = database.prepare("SELECT id,name,program_type AS programType,description FROM templates ORDER BY name").all()
      .map((template) => ({
        ...template,
        tasks: database.prepare(`SELECT id,title,description,relative_due_days AS relativeDueDays,priority,milestone,
          default_role AS defaultRole,dependency_index AS dependencyIndex
          FROM template_tasks WHERE template_id=? ORDER BY rowid`).all(template.id)
      }));
    return send(response, 200, {
      currentUser: { ...user, roleLabel: roleLabel[user.role] },
      users: database.prepare("SELECT id,name,role FROM users WHERE is_active=1 ORDER BY name").all(),
      projects, tasks, notifications,
      templates,
      integration: {
        airtableConfigured: Boolean(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID),
        airtableTablesSynced: database.prepare("SELECT COUNT(*) AS count FROM airtable_tables").get().count,
        airtableLastSync: database.prepare("SELECT MAX(synced_at) AS synced_at FROM airtable_tables").get().synced_at
      },
      visibleProjectCount: visibleIds.size
    });
  }
  if (request.method === "GET" && path === "/api/projects") {
    return send(response, 200, projectRows(user).map(projectResponse));
  }
  if (request.method === "GET" && path.startsWith("/api/templates/")) {
    if (!canManageTemplates(user)) return send(response, 403, { error: "Only administrators and program managers can edit program templates." });
    const templateId = decodeURIComponent(path.slice("/api/templates/".length));
    const template = database.prepare("SELECT id,name,program_type AS programType,description FROM templates WHERE id=?").get(templateId);
    if (!template) return send(response, 404, { error: "Template not found." });
    const tasks = database.prepare(`SELECT id,title,description,relative_due_days AS relativeDueDays,priority,milestone
      FROM template_tasks WHERE template_id=? ORDER BY rowid`).all(templateId);
    return send(response, 200, { ...template, tasks });
  }
  if (request.method === "PATCH" && path.startsWith("/api/templates/")) {
    if (!canManageTemplates(user)) return send(response, 403, { error: "Only administrators and program managers can edit program templates." });
    const templateId = decodeURIComponent(path.slice("/api/templates/".length));
    const template = database.prepare("SELECT * FROM templates WHERE id=?").get(templateId);
    if (!template) return send(response, 404, { error: "Template not found." });
    const input = await readBody(request);
    if (typeof input.name !== "string" || !input.name.trim() || !Array.isArray(input.tasks)) {
      return send(response, 400, { error: "A template name and task list are required." });
    }
    const storedTasks = database.prepare("SELECT id FROM template_tasks WHERE template_id=? ORDER BY rowid").all(templateId);
    if (input.tasks.length !== storedTasks.length || input.tasks.some((task) =>
      typeof task.title !== "string" || !task.title.trim() || !Number.isInteger(Number(task.relativeDueDays))
      || !["Low", "Medium", "High"].includes(task.priority) || typeof task.milestone !== "string" || !task.milestone.trim())) {
      return send(response, 400, { error: "Each existing template task needs a title, whole-number relative deadline, priority, and milestone." });
    }
    database.exec("BEGIN");
    try {
      database.prepare("UPDATE templates SET name=?,description=? WHERE id=?").run(input.name.trim(), String(input.description || ""), templateId);
      const updateTask = database.prepare("UPDATE template_tasks SET title=?,description=?,relative_due_days=?,priority=?,milestone=? WHERE id=?");
      for (const [index, task] of input.tasks.entries()) {
        updateTask.run(task.title.trim(), String(task.description || ""), Number(task.relativeDueDays), task.priority, task.milestone.trim(), storedTasks[index].id);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return send(response, 200, { ok: true });
  }
  if (request.method === "GET" && path.startsWith("/api/projects/")) {
    const projectId = decodeURIComponent(path.slice("/api/projects/".length));
    if (!canViewProject(user, projectId)) return send(response, 404, { error: "Project not found." });
    const row = database.prepare(`SELECT p.*,u.name AS manager_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) AS task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status='Completed') AS completed_count
      FROM projects p LEFT JOIN users u ON u.id=p.project_manager_id WHERE p.id=?`).get(projectId);
    if (!row) return send(response, 404, { error: "Project not found." });
    const members = database.prepare(`SELECT u.id,u.name,u.email,u.role,pm.project_role AS projectRole
      FROM project_members pm JOIN users u ON u.id=pm.user_id WHERE pm.project_id=? ORDER BY u.name`).all(projectId);
    const activities = database.prepare(`SELECT a.*,u.name AS user_name FROM activity_logs a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.project_id=? ORDER BY a.created_at DESC LIMIT 30`).all(projectId)
      .map((item) => ({ id: item.id, action: item.action, details: item.details, createdAt: item.created_at, userName: item.user_name || "System" }));
    const tasks = taskRows(projectId)
      .filter((item) => user.role !== "external_partner" || isTaskOwner(item.id, user.id))
      .map((item) => taskResponse(item, user));
    const visibleMembers = user.role === "external_partner" ? members.filter((member) => member.id === user.id) : members;
    const comments = database.prepare(`SELECT c.*,u.name AS user_name FROM task_comments c JOIN users u ON u.id=c.user_id
      JOIN tasks t ON t.id=c.task_id WHERE t.project_id=? ORDER BY c.created_at DESC LIMIT 30`).all(projectId)
      .map((item) => ({ id: item.id, taskId: item.task_id, userName: item.user_name, content: item.content, createdAt: item.created_at }));
    const visibleActivities = user.role === "external_partner" ? activities.filter((item) => item.userName === user.name) : activities;
    const visibleComments = user.role === "external_partner" ? comments.filter((item) => tasks.some((task) => task.id === item.taskId)) : comments;
    const visibleProject = projectResponse(row);
    if (user.role === "external_partner") visibleProject.details = {};
    return send(response, 200, { project: visibleProject, members: visibleMembers, tasks, activities: visibleActivities, comments: visibleComments });
  }
  if (request.method === "POST" && path === "/api/projects") {
    if (user.role === "employee" || user.role === "external_partner") return send(response, 403, { error: "You do not have permission to create programs." });
    const input = await readBody(request);
    const location = String(input.location || [input.city, input.state].filter(Boolean).join(", ")).trim();
    const endDate = String(input.endDate || input.startDate || "");
    const required = ["name", "programType", "projectManagerId"];
    if (required.some((key) => !String(input[key] || "").trim())) return send(response, 400, { error: "Complete all required project fields." });
    if (!location) return send(response, 400, { error: "Enter a program city and state." });
    if (!validateDate(input.startDate) || !validateDate(endDate) || endDate < input.startDate) return send(response, 400, { error: "Enter valid program dates; the end date must be on or after the start date." });
    const manager = getUser(input.projectManagerId);
    if (!manager || manager.role === "external_partner") return send(response, 400, { error: "Choose an internal employee as the project manager." });
    const creationMode = input.creationMode === "scratch" ? "scratch" : "template";
    const template = creationMode === "template" && input.templateId
      ? database.prepare("SELECT * FROM templates WHERE id=?").get(input.templateId)
      : null;
    if (creationMode === "template" && !template) return send(response, 400, { error: "Choose a valid task template, or select Create from scratch." });
    const programHours = input.programHours === "" || input.programHours === undefined
      ? null
      : Number(input.programHours);
    if (programHours !== null && (!Number.isFinite(programHours) || programHours < 0 || programHours > 24)) {
      return send(response, 400, { error: "Program hours must be between 0 and 24." });
    }
    const id = randomUUID();
    const timestamp = nowISO();
    const managerId = input.projectManagerId;
    const insertProject = database.prepare(`INSERT INTO projects
      (id,name,description,program_type,location,host_organization,start_date,end_date,status,project_manager_id,details_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const details = {
      primaryContact: input.primaryContact || "", contactEmail: input.contactEmail || "",
      shippingAddress: input.shippingAddress || "", participants: Number(input.participants || 0),
      instructorRequirements: input.instructorRequirements || "", volunteerRequirements: input.volunteerRequirements || "",
      specialRequirements: input.specialRequirements || "", notes: input.notes || "",
      city: String(input.city || location.split(",")[0] || "").trim(),
      state: String(input.state || location.split(",").slice(1).join(",") || "").trim(),
      deliveryType: String(input.deliveryType || ""), programHours,
      leadInstructors: String(input.leadInstructors || "").trim(),
      creationMode, sourceTemplateId: template?.id || null
    };
    database.exec("BEGIN");
    try {
      insertProject.run(id, input.name.trim(), input.description || "", input.programType, location,
        input.hostOrganization || "", input.startDate, endDate, "Planning", managerId, JSON.stringify(details), timestamp, timestamp);
      const members = new Set([managerId, user.id]);
      const addMember = database.prepare("INSERT OR IGNORE INTO project_members(project_id,user_id,project_role) VALUES(?,?,?)");
      for (const memberId of members) addMember.run(id, memberId, memberId === managerId ? "Project Manager" : "Team Member");
      const templateTasks = template
        ? database.prepare("SELECT * FROM template_tasks WHERE template_id=? ORDER BY rowid").all(template.id)
        : [];
      const createdIds = [];
      const insertTask = database.prepare(`INSERT INTO tasks
        (id,project_id,template_task_id,title,description,assigned_user_id,status,priority,due_date,milestone,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertDependency = database.prepare("INSERT INTO task_dependencies(task_id,prerequisite_task_id) VALUES(?,?)");
      for (const task of templateTasks) {
        const taskId = randomUUID();
        createdIds.push(taskId);
        const assignedUser = resolveRoleAssignment(task.default_role, managerId);
        insertTask.run(taskId, id, task.id, task.title, task.description, assignedUser, "Not Started",
          task.priority, addDays(input.startDate, task.relative_due_days), task.milestone, timestamp, timestamp);
        if (task.dependency_index !== null) {
          const prerequisite = createdIds[task.dependency_index - 1];
          if (prerequisite) insertDependency.run(taskId, prerequisite);
        }
        if (assignedUser !== user.id) notifyUser(assignedUser, id, `New task assigned: ${task.title} — ${input.name.trim()}`);
      }
      logActivity(id, null, user.id, "Project created",
        template ? `${input.name.trim()} created from ${template.name}.` : `${input.name.trim()} created from scratch.`);
      database.exec("COMMIT");
      return send(response, 201, { projectId: id, taskCount: createdIds.length });
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  if (request.method === "POST" && path.startsWith("/api/projects/") && path.endsWith("/tasks")) {
    const projectId = decodeURIComponent(path.slice("/api/projects/".length, -"/tasks".length));
    const project = database.prepare("SELECT id,name FROM projects WHERE id=?").get(projectId);
    if (!project || !(canManage(user) || (user.role === "program_manager" && canAccessProject(user, projectId)))) {
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
      const assignee = getUser(assignedUserId);
      if (!assignee || assignee.role === "external_partner") return send(response, 400, { error: "Choose an active internal teammate as the task owner." });
    }
    if (dependencyIds.length) {
      const placeholders = dependencyIds.map(() => "?").join(",");
      const validDependencies = database.prepare(`SELECT id FROM tasks WHERE project_id=? AND id IN (${placeholders})`).all(projectId, ...dependencyIds);
      if (validDependencies.length !== dependencyIds.length) {
        return send(response, 400, { error: "Every prerequisite must be a different task in this program." });
      }
    }
    const timestamp = nowISO();
    const taskId = randomUUID();
    database.exec("BEGIN");
    try {
      database.prepare(`INSERT INTO tasks
        (id,project_id,template_task_id,title,description,assigned_user_id,status,priority,due_date,due_date_override,milestone,created_at,updated_at)
        VALUES(?,?,NULL,?,?,?,'Not Started',?,?,1,?,?,?)`)
        .run(taskId, projectId, title, description, assignedUserId, priority, dueDate, milestone, timestamp, timestamp);
      const addDependency = database.prepare("INSERT INTO task_dependencies(task_id,prerequisite_task_id) VALUES(?,?)");
      for (const prerequisiteId of dependencyIds) addDependency.run(taskId, prerequisiteId);
      if (assignedUserId) {
        database.prepare("INSERT OR IGNORE INTO project_members(project_id,user_id,project_role) VALUES(?,?,'Member')")
          .run(projectId, assignedUserId);
        if (assignedUserId !== user.id) notifyUser(assignedUserId, projectId, `New task assigned: ${title} — ${project.name}`);
      }
      logActivity(projectId, taskId, user.id, "Task created", `${title} added with ${priority.toLowerCase()} priority.`);
      database.exec("COMMIT");
      return send(response, 201, { taskId });
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  if (request.method === "PATCH" && path.startsWith("/api/tasks/") && path.endsWith("/status")) {
    const taskId = decodeURIComponent(path.slice("/api/tasks/".length, -"/status".length));
    const task = database.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
    if (!task || !canEditTask(user, task)) return send(response, 404, { error: "Task not found or you do not have permission to update it." });
    const input = await readBody(request);
    const allowed = ["Not Started", "In Progress", "Completed"];
    if (!allowed.includes(input.status)) return send(response, 400, { error: "Choose a valid task status." });
    if (input.status === "Completed") {
      const prerequisites = database.prepare(`SELECT p.title FROM task_dependencies d JOIN tasks p ON p.id=d.prerequisite_task_id
        WHERE d.task_id=? AND p.status!='Completed'`).all(taskId);
      if (prerequisites.length && !(canManage(user) && String(input.overrideReason || "").trim())) {
        return send(response, 409, { error: "Complete prerequisite tasks before marking this task done.", prerequisites: prerequisites.map((item) => item.title) });
      }
      if (prerequisites.length) logActivity(task.project_id, taskId, user.id, "Dependency override", `Authorized override: ${String(input.overrideReason).trim()}`);
    }
    const completedAt = input.status === "Completed" ? nowISO() : null;
    database.prepare("UPDATE tasks SET status=?,completed_at=?,updated_at=? WHERE id=?").run(input.status, completedAt, nowISO(), taskId);
    logActivity(task.project_id, taskId, user.id, "Status changed", `${task.title}: ${task.status} → ${input.status}.`);
    const newlyReady = database.prepare(`SELECT t.id,t.title,t.assigned_user_id FROM task_dependencies d JOIN tasks t ON t.id=d.task_id
      WHERE d.prerequisite_task_id=? AND t.status='Not Started' AND NOT EXISTS
      (SELECT 1 FROM task_dependencies d2 JOIN tasks p ON p.id=d2.prerequisite_task_id WHERE d2.task_id=t.id AND p.status!='Completed')`).all(taskId);
    const ownersOf = database.prepare("SELECT user_id FROM task_assignees WHERE task_id=? ORDER BY position");
    for (const ready of newlyReady) {
      const owners = ownersOf.all(ready.id).map((row) => row.user_id);
      for (const ownerId of owners.length ? owners : [user.id]) notifyUser(ownerId, task.project_id, `Task is now ready: ${ready.title}`);
    }
    return send(response, 200, { ok: true });
  }
  if (request.method === "PATCH" && path.startsWith("/api/tasks/") && path.endsWith("/due-date")) {
    if (!["admin", "program_manager"].includes(user.role)) return send(response, 403, { error: "Only management can override task deadlines." });
    const taskId = decodeURIComponent(path.slice("/api/tasks/".length, -"/due-date".length));
    const task = database.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
    if (!task || !canAccessProject(user, task.project_id)) return send(response, 404, { error: "Task not found." });
    const input = await readBody(request);
    if (!validateDate(input.dueDate)) return send(response, 400, { error: "Enter a valid task deadline." });
    database.prepare("UPDATE tasks SET due_date=?,due_date_override=1,updated_at=? WHERE id=?").run(input.dueDate, nowISO(), taskId);
    logActivity(task.project_id, taskId, user.id, "Deadline overridden", `${task.title}: ${task.due_date} → ${input.dueDate}. This date will be preserved during program timeline changes.`);
    return send(response, 200, { ok: true });
  }
  if (request.method === "POST" && path.startsWith("/api/tasks/") && path.endsWith("/comments")) {
    const taskId = decodeURIComponent(path.slice("/api/tasks/".length, -"/comments".length));
    const task = database.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
    if (!task || !canAccessProject(user, task.project_id)
      || (user.role === "external_partner" && !isTaskOwner(task.id, user.id))) return send(response, 404, { error: "Task not found." });
    const input = await readBody(request);
    const content = String(input.content || "").trim();
    if (!content || content.length > 2000) return send(response, 400, { error: "Enter a comment of 1–2,000 characters." });
    database.prepare("INSERT INTO task_comments(id,task_id,user_id,content,created_at) VALUES(?,?,?,?,?)")
      .run(randomUUID(), taskId, user.id, content, nowISO());
    logActivity(task.project_id, taskId, user.id, "Comment added", content);
    return send(response, 201, { ok: true });
  }
  if (request.method === "PATCH" && path.startsWith("/api/tasks/") && path.endsWith("/assignees")) {
    if (!["admin", "program_manager"].includes(user.role)) return send(response, 403, { error: "Only management and program managers can change task owners." });
    const taskId = decodeURIComponent(path.slice("/api/tasks/".length, -"/assignees".length));
    const task = database.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
    if (!task || !canAccessProject(user, task.project_id)) return send(response, 404, { error: "Task not found." });
    const input = await readBody(request);
    const ids = Array.isArray(input.assignedUserIds) ? [...new Set(input.assignedUserIds.map(String))] : null;
    if (!ids || !ids.length || ids.length > 8) return send(response, 400, { error: "Choose between 1 and 8 task owners." });
    const owners = ids.map((id) => getUser(id));
    if (owners.some((owner) => !owner || owner.role === "external_partner")) return send(response, 400, { error: "Task owners must be active internal teammates." });
    const before = database.prepare("SELECT user_id FROM task_assignees WHERE task_id=?").all(taskId).map((row) => row.user_id);
    const unchanged = before.length === ids.length && ids.every((id) => before.includes(id)) && task.assigned_user_id === ids[0];
    if (unchanged) return send(response, 200, { ok: true, unchanged: true });
    database.exec("BEGIN");
    try {
      database.prepare("UPDATE tasks SET assigned_user_id=?,updated_at=? WHERE id=?").run(ids[0], nowISO(), taskId);
      database.prepare("DELETE FROM task_assignees WHERE task_id=?").run(taskId);
      const insertOwner = database.prepare("INSERT INTO task_assignees(task_id,user_id,position) VALUES(?,?,?)");
      const addMember = database.prepare("INSERT OR IGNORE INTO project_members(project_id,user_id,project_role) VALUES(?,?,?)");
      ids.forEach((id, index) => { insertOwner.run(taskId, id, index); addMember.run(task.project_id, id, "Team Member"); });
      logActivity(task.project_id, taskId, user.id, "Task owners updated", `${task.title} owners: ${owners.map((owner) => owner.name).join(", ")}.`);
      for (const owner of owners) {
        if (!before.includes(owner.id) && owner.id !== user.id) notifyUser(owner.id, task.project_id, `New task assigned: ${task.title}`);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return send(response, 200, { ok: true });
  }
  if (request.method === "PATCH" && /^\/api\/tasks\/[^/]+$/.test(path)) {
    const taskId = decodeURIComponent(path.slice("/api/tasks/".length));
    const task = database.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
    if (!task || !canEditTask(user, task)) return send(response, 404, { error: "Task not found or you do not have permission to edit it." });
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
    database.prepare("UPDATE tasks SET title=?,description=?,priority=?,updated_at=? WHERE id=?").run(title, description, priority, nowISO(), taskId);
    logActivity(task.project_id, taskId, user.id, "Task edited", `${title}: ${changes.join("; ")}.`);
    return send(response, 200, { ok: true });
  }
  if (request.method === "PATCH" && path.startsWith("/api/tasks/") && path.endsWith("/assignee")) {
    if (!["admin", "program_manager"].includes(user.role)) return send(response, 403, { error: "Only management and program managers can reassign tasks." });
    const taskId = decodeURIComponent(path.slice("/api/tasks/".length, -"/assignee".length));
    const task = database.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
    if (!task || !canAccessProject(user, task.project_id)) return send(response, 404, { error: "Task not found." });
    const input = await readBody(request);
    const assignee = getUser(input.assignedUserId);
    if (!assignee || assignee.role === "external_partner") return send(response, 400, { error: "Choose an internal employee." });
    database.prepare("UPDATE tasks SET assigned_user_id=?,updated_at=? WHERE id=?").run(assignee.id, nowISO(), taskId);
    database.prepare("INSERT OR IGNORE INTO project_members(project_id,user_id,project_role) VALUES(?,?,?)").run(task.project_id, assignee.id, "Team Member");
    logActivity(task.project_id, taskId, user.id, "Task reassigned", `${task.title} reassigned to ${assignee.name}.`);
    notifyUser(assignee.id, task.project_id, `New task assigned: ${task.title}`);
    return send(response, 200, { ok: true });
  }
  if (request.method === "POST" && path === "/api/projects/date-preview") {
    const input = await readBody(request);
    if (!canAccessProject(user, input.projectId)) return send(response, 404, { error: "Project not found." });
    if (!["admin", "program_manager"].includes(user.role)) return send(response, 403, { error: "You cannot adjust this program timeline." });
    if (!validateDate(input.startDate)) return send(response, 400, { error: "Enter a valid program start date." });
    const project = database.prepare("SELECT * FROM projects WHERE id=?").get(input.projectId);
    const shift = Math.round((Date.parse(`${input.startDate}T00:00:00Z`) - Date.parse(`${project.start_date}T00:00:00Z`)) / 86400000);
    const tasks = database.prepare("SELECT id,title,due_date,status,due_date_override FROM tasks WHERE project_id=? ORDER BY due_date").all(project.id);
    return send(response, 200, { shiftDays: shift, changes: tasks.filter((task) => task.status !== "Completed" && !task.due_date_override)
      .map((task) => ({ id: task.id, title: task.title, oldDate: task.due_date, newDate: addDays(task.due_date, shift) })) });
  }
  if (request.method === "PATCH" && path.startsWith("/api/projects/") && path.endsWith("/start-date")) {
    const projectId = decodeURIComponent(path.slice("/api/projects/".length, -"/start-date".length));
    if (!canAccessProject(user, projectId) || !["admin", "program_manager"].includes(user.role)) return send(response, 403, { error: "You cannot adjust this program timeline." });
    const input = await readBody(request);
    if (!validateDate(input.startDate)) return send(response, 400, { error: "Enter a valid program start date." });
    const project = database.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
    const shift = Math.round((Date.parse(`${input.startDate}T00:00:00Z`) - Date.parse(`${project.start_date}T00:00:00Z`)) / 86400000);
    const updateTask = database.prepare("UPDATE tasks SET due_date=?,updated_at=? WHERE id=?");
    const tasks = database.prepare("SELECT id,due_date,status,due_date_override FROM tasks WHERE project_id=?").all(projectId);
    for (const task of tasks) if (task.status !== "Completed" && !task.due_date_override) updateTask.run(addDays(task.due_date, shift), nowISO(), task.id);
    database.prepare("UPDATE projects SET start_date=?,end_date=?,updated_at=? WHERE id=?")
      .run(input.startDate, addDays(project.end_date, shift), nowISO(), projectId);
    logActivity(projectId, null, user.id, "Timeline updated", `Program start date changed from ${project.start_date} to ${input.startDate}. ${tasks.filter((task) => task.status !== "Completed" && !task.due_date_override).length} task dates adjusted; completed and manually overridden dates preserved.`);
    const members = database.prepare("SELECT user_id FROM project_members WHERE project_id=?").all(projectId);
    for (const member of members) if (member.user_id !== user.id) notifyUser(member.user_id, projectId, `Program timeline updated: ${project.name}`);
    return send(response, 200, { ok: true });
  }
  if (request.method === "PATCH" && path.startsWith("/api/notifications/")) {
    const notificationId = decodeURIComponent(path.slice("/api/notifications/".length));
    const result = database.prepare("UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?").run(notificationId, user.id);
    return result.changes ? send(response, 200, { ok: true }) : send(response, 404, { error: "Notification not found." });
  }
  if (request.method === "GET" && path === "/api/integrations/airtable/tables") {
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can inspect synchronized Airtable data." });
    response.setHeader("cache-control", "no-store");
    const tables = database.prepare(`SELECT t.table_id AS id,t.table_name AS name,t.fields_json AS fields,
      t.synced_at AS syncedAt,(SELECT COUNT(*) FROM airtable_records r WHERE r.table_id=t.table_id) AS recordCount
      FROM airtable_tables t ORDER BY t.table_name`).all()
      .map((table) => ({ ...table, fields: JSON.parse(table.fields) }));
    return send(response, 200, { tables });
  }
  const airtableRecordsPrefix = "/api/integrations/airtable/tables/";
  if (request.method === "GET" && path.startsWith(airtableRecordsPrefix) && path.endsWith("/records")) {
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can inspect synchronized Airtable data." });
    response.setHeader("cache-control", "no-store");
    let tableId;
    try {
      tableId = decodeURIComponent(path.slice(airtableRecordsPrefix.length, -"/records".length));
    } catch {
      return send(response, 400, { error: "Invalid Airtable table identifier." });
    }
    const table = database.prepare("SELECT table_id AS id,table_name AS name,fields_json AS fields,synced_at AS syncedAt FROM airtable_tables WHERE table_id=?").get(tableId);
    if (!table) return send(response, 404, { error: "Airtable table has not been synchronized yet." });
    const limitValue = Number.parseInt(url.searchParams.get("limit") || "25", 10);
    const offsetValue = Number.parseInt(url.searchParams.get("offset") || "0", 10);
    const limit = Number.isSafeInteger(limitValue) ? Math.min(100, Math.max(1, limitValue)) : 25;
    const offset = Number.isSafeInteger(offsetValue) ? Math.max(0, offsetValue) : 0;
    const query = String(url.searchParams.get("q") || "").trim().slice(0, 200);
    const where = query ? "WHERE table_id=? AND instr(lower(fields_json),lower(?))>0" : "WHERE table_id=?";
    const params = query ? [tableId, query] : [tableId];
    const total = database.prepare(`SELECT COUNT(*) AS count FROM airtable_records ${where}`).get(...params).count;
    const records = database.prepare(`SELECT record_id AS id,fields_json AS fields,synced_at AS syncedAt
      FROM airtable_records ${where} ORDER BY record_id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map((record) => ({ ...record, fields: JSON.parse(record.fields) }));
    const labelRows = database.prepare("SELECT record_id AS id,fields_json FROM airtable_records").all();
    const recordLabels = {};
    for (const row of labelRows) {
      const fields = JSON.parse(row.fields_json);
      const label = ["Name", "Unique", "Session Name", "Program Name", "Instructor Name", "Role Name",
        "List Name (Unique)", "Email Address", "Short Description"].map((key) => fields[key])
        .find((value) => typeof value === "string" && value.trim());
      const personName = [fields["First Name"], fields["Last Name"]].filter((value) => typeof value === "string" && value.trim()).join(" ");
      if (label || personName) recordLabels[row.id] = label || personName;
    }
    table.fields = JSON.parse(table.fields);
    return send(response, 200, { table, records, recordLabels, total, limit, offset, query });
  }
  if (request.method === "GET" && path === "/api/integrations/airtable/schema") {
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can inspect the Airtable connection." });
    try {
      const tables = await fetchAirtableSchema(airtableConfig());
      const names = new Set(tables.map((table) => table.name));
      return send(response, 200, {
        tables,
        missingTables: AIRTABLE_TABLE_NAMES.filter((name) => !names.has(name))
      });
    } catch (error) {
      return send(response, error.status === 401 || error.status === 403 ? 502 : 503, { error: error.message });
    }
  }
  if (request.method === "POST" && path === "/api/integrations/airtable/sync") {
    if (!canManage(user)) return send(response, 403, { error: "Only administrators can synchronize Airtable." });
    try {
      const result = await syncAirtableBase(user);
      return send(response, 200, result);
    } catch (error) {
      console.error(`Airtable sync failed: ${error.message}`);
      return send(response, error.status === 401 || error.status === 403 ? 502 : error.status || 503, { error: error.message });
    }
  }
  if (request.method === "POST" && path === "/api/integrations/airtable/import") {
    if (!["admin", "program_manager"].includes(user.role)) return send(response, 403, { error: "Only management can import Airtable programs." });
    const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_PROJECTS_TABLE, AIRTABLE_FIELD_MAPPING } = process.env;
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return send(response, 503, { error: "Airtable is not configured. Add your Personal Access Token and base ID to .env, restart, and try again." });
    let mapping;
    try { mapping = JSON.parse(AIRTABLE_FIELD_MAPPING || "{}"); } catch { return send(response, 500, { error: "AIRTABLE_FIELD_MAPPING must contain valid JSON." }); }
    if (!AIRTABLE_PROJECTS_TABLE) return send(response, 503, { error: "Set AIRTABLE_PROJECTS_TABLE in .env to the table name or ID." });
    const table = encodeURIComponent(AIRTABLE_PROJECTS_TABLE);
    let endpoint = `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${table}`;
    const records = [];
    try {
      do {
        const result = await fetch(endpoint, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
        if (!result.ok) {
          const issue = await result.json().catch(() => ({}));
          return send(response, result.status === 401 || result.status === 403 ? 502 : 502, {
            error: `Airtable import failed (${result.status}): ${issue.error?.message || issue.error?.type || "check the token, base, table, and field mapping."}`
          });
        }
        const page = await result.json();
        records.push(...page.records);
        endpoint = page.offset ? `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${table}?offset=${encodeURIComponent(page.offset)}` : "";
      } while (endpoint);
    } catch (error) {
      return send(response, 502, { error: `Could not connect to Airtable: ${error.message}` });
    }
    const getField = (fields, name, fallback = "") => {
      const key = mapping[name];
      return key ? fields[key] ?? fallback : fallback;
    };
    let imported = 0;
    let skipped = 0;
    const upsert = database.prepare(`INSERT INTO projects
      (id,name,description,program_type,location,host_organization,start_date,end_date,status,project_manager_id,airtable_record_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(airtable_record_id) DO UPDATE SET name=excluded.name,description=excluded.description,
      program_type=excluded.program_type,location=excluded.location,host_organization=excluded.host_organization,
      start_date=excluded.start_date,end_date=excluded.end_date,status=excluded.status,updated_at=excluded.updated_at`);
    for (const record of records) {
      const fields = record.fields || {};
      const name = getField(fields, "name");
      const location = getField(fields, "location");
      const startDate = getField(fields, "startDate");
      const endDate = getField(fields, "endDate", startDate);
      if (!name || !location || !validateDate(startDate) || !validateDate(endDate)) {
        skipped++;
        continue;
      }
      const existing = database.prepare("SELECT id FROM projects WHERE airtable_record_id=?").get(record.id);
      upsert.run(existing?.id || randomUUID(), String(name), String(getField(fields, "description")),
        String(getField(fields, "programType", "Community")), String(location),
        String(getField(fields, "hostOrganization")), startDate, endDate,
        startDate > offsetDate(30) ? "Planning" : "On Track", user.id, record.id, nowISO(), nowISO());
      if (!existing) imported++;
    }
    return send(response, 200, { imported, updated: records.length - imported - skipped, skipped, total: records.length });
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
    console.error(error);
    if (!response.headersSent) send(response, 500, { error: error.message || "Unexpected server error." });
    else response.end();
  }
});
const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => console.log(`NMU Program Management running at http://localhost:${port}`));
