import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
let serverProcess;
let baseUrl;
let temporaryDirectory;

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function request(path, userId = "u-catalina", options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", "x-demo-user": userId, ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "nmu-pm-test-"));
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), NMU_DATABASE_PATH: join(temporaryDirectory, "test.sqlite") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  serverProcess.stdout.on("data", (chunk) => { output += chunk.toString(); });
  serverProcess.stderr.on("data", (chunk) => { output += chunk.toString(); });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (serverProcess.exitCode !== null) throw new Error(`Test server exited early:\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`, { headers: { "x-demo-user": "u-catalina" } });
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Test server did not start:\n${output}`);
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test("NMU project, dependency, access, and timeline workflows", async (t) => {
  const plusDays = (days) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  let createdProjectId;
  let createdTasks;

  await t.test("seeds realistic demo data and template workflows", async () => {
    const result = await request("/api/bootstrap");
    assert.equal(result.status, 200);
    assert.equal(result.body.users.length, 7);
    assert.equal(result.body.templates.length, 3);
    assert.equal(result.body.projects.length, 6);
    assert.ok(result.body.tasks.length >= 40 && result.body.tasks.length <= 60);
    assert.ok(result.body.tasks.some((task) => task.isBlocked));
  });

  await t.test("creates a program and generates relative tasks", async () => {
    const startDate = plusDays(250);
    const result = await request("/api/projects", "u-jordan", {
      method: "POST",
      body: JSON.stringify({
        name: "Test community swim program", programType: "Community", location: "Bellingham, WA",
        hostOrganization: "Demo Host", startDate, endDate: plusDays(264),
        templateId: "tpl-community", projectManagerId: "u-jordan",
        primaryContact: "Morgan Lee", participants: 32, notes: "Created by automated test"
      })
    });
    assert.equal(result.status, 201);
    createdProjectId = result.body.projectId;
    assert.equal(result.body.taskCount, 16);
    const project = await request(`/api/projects/${createdProjectId}`, "u-jordan");
    createdTasks = project.body.tasks;
    assert.equal(project.status, 200);
    assert.equal(createdTasks[0].dueDate, plusDays(130));
    assert.ok(createdTasks.some((task) => task.dependencies.length > 0));
    assert.equal(project.body.project.details.primaryContact, "Morgan Lee");
    assert.equal(result.body.taskCount, project.body.tasks.length);
  });

  await t.test("creates a program from scratch without template tasks", async () => {
    const programDate = plusDays(310);
    const result = await request("/api/projects", "u-jordan", {
      method: "POST",
      body: JSON.stringify({
        name: "Swim Safely Series – Bellevue Bellevue YMCA",
        programType: "Swim Safely Series",
        deliveryType: "Community",
        city: "Bellevue",
        state: "WA",
        location: "Bellevue, WA",
        hostOrganization: "Bellevue YMCA",
        startDate: programDate,
        projectManagerId: "u-jordan",
        creationMode: "scratch",
        programHours: 24,
        leadInstructors: "Alex Rivera, Sam Okafor"
      })
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.taskCount, 0);
    const project = await request(`/api/projects/${result.body.projectId}`, "u-jordan");
    assert.equal(project.status, 200);
    assert.equal(project.body.project.endDate, programDate);
    assert.equal(project.body.project.city, "Bellevue");
    assert.equal(project.body.project.state, "WA");
    assert.equal(project.body.project.deliveryType, "Community");
    assert.equal(project.body.project.details.programHours, 24);
    assert.equal(project.body.project.details.leadInstructors, "Alex Rivera, Sam Okafor");
    assert.equal(project.body.tasks.length, 0);
    const firstTask = await request(`/api/projects/${result.body.projectId}/tasks`, "u-jordan", {
      method: "POST",
      body: JSON.stringify({
        title: "Confirm instructor availability", description: "Contact the selected instructors.",
        dueDate: programDate, milestone: "Staffing", priority: "High", assignedUserId: "u-casey"
      })
    });
    assert.equal(firstTask.status, 201);
    const followupTask = await request(`/api/projects/${result.body.projectId}/tasks`, "u-jordan", {
      method: "POST",
      body: JSON.stringify({
        title: "Prepare instructor schedule", dueDate: programDate, milestone: "Staffing",
        priority: "Medium", dependencyIds: [firstTask.body.taskId]
      })
    });
    assert.equal(followupTask.status, 201);
    const populatedProject = await request(`/api/projects/${result.body.projectId}`, "u-jordan");
    assert.equal(populatedProject.body.tasks.length, 2);
    assert.equal(populatedProject.body.tasks.find((task) => task.id === firstTask.body.taskId).assigneeName, "Casey Nguyen");
    assert.equal(populatedProject.body.tasks.find((task) => task.id === followupTask.body.taskId).isBlocked, true);
    assert.ok(populatedProject.body.members.some((member) => member.id === "u-casey"));
    const foreignDependency = await request(`/api/projects/${result.body.projectId}/tasks`, "u-jordan", {
      method: "POST",
      body: JSON.stringify({ title: "Invalid dependency", dueDate: programDate, dependencyIds: [createdTasks[0].id] })
    });
    assert.equal(foreignDependency.status, 400);
    const unauthorizedCreate = await request(`/api/projects/${result.body.projectId}/tasks`, "u-mary", {
      method: "POST",
      body: JSON.stringify({ title: "Unauthorized task", dueDate: programDate })
    });
    assert.equal(unauthorizedCreate.status, 404);
  });

  await t.test("reassigns tasks, notifies the new owner, and records notes", async () => {
    const task = createdTasks.find((item) => item.title === "Research funding opportunities");
    const reassigned = await request(`/api/tasks/${task.id}/assignee`, "u-jordan", {
      method: "PATCH", body: JSON.stringify({ assignedUserId: "u-mary" })
    });
    assert.equal(reassigned.status, 200);
    const previousOwner = await request("/api/bootstrap", "u-casey");
    const newOwner = await request("/api/bootstrap", "u-mary");
    assert.ok(!previousOwner.body.tasks.some((item) => item.id === task.id && item.assignedUserId === "u-casey"));
    assert.ok(newOwner.body.tasks.some((item) => item.id === task.id && item.assignedUserId === "u-mary"));
    assert.ok(newOwner.body.notifications.some((item) => item.message.includes(task.title)));
    const comment = await request(`/api/tasks/${task.id}/comments`, "u-mary", {
      method: "POST", body: JSON.stringify({ content: "Contacted the regional grant office." })
    });
    assert.equal(comment.status, 201);
    const project = await request(`/api/projects/${createdProjectId}`, "u-jordan");
    assert.ok(project.body.activities.some((item) => item.action === "Task reassigned"));
    assert.ok(project.body.comments.some((item) => item.content === "Contacted the regional grant office."));
  });

  await t.test("supports several owners per task with valid relationships", async () => {
    const task = createdTasks.find((item) => item.title === "Research funding opportunities");
    const patchOwners = (ids, user = "u-jordan") => request(`/api/tasks/${task.id}/assignees`, user, {
      method: "PATCH", body: JSON.stringify({ assignedUserIds: ids })
    });
    assert.equal((await patchOwners(["u-casey"], "u-casey")).status, 403, "employees cannot change owners");
    assert.equal((await patchOwners([])).status, 400);
    assert.equal((await patchOwners(["u-missing"])).status, 400);
    assert.equal((await patchOwners(["u-partner"])).status, 400, "external partners cannot own internal tasks");
    const updated = await patchOwners(["u-mary", "u-casey"]);
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const project = await request(`/api/projects/${createdProjectId}`, "u-jordan");
    const stored = project.body.tasks.find((item) => item.id === task.id);
    assert.deepEqual(stored.assigneeIds, ["u-mary", "u-casey"]);
    assert.equal(stored.assignedUserId, "u-mary", "first owner stays the lead");
    assert.equal(stored.assigneeName, "Mary, Casey Nguyen");
    const casey = await request("/api/bootstrap", "u-casey");
    const caseyTask = casey.body.tasks.find((item) => item.id === task.id);
    assert.ok(caseyTask, "second owner sees the task");
    assert.equal(caseyTask.canEdit, true, "second owner can update it");
    assert.ok(casey.body.notifications.some((item) => item.message === `New task assigned: ${task.title}`));
    const caseyStatus = await request(`/api/tasks/${task.id}/status`, "u-casey", { method: "PATCH", body: JSON.stringify({ status: "In Progress" }) });
    assert.equal(caseyStatus.status, 200);
    assert.ok(project.body.activities.some((item) => item.action === "Task owners updated"));
    const unchanged = await patchOwners(["u-mary", "u-casey"]);
    assert.equal(unchanged.body.unchanged, true);
    // The single-owner endpoint and the owners list stay consistent.
    assert.equal((await request(`/api/tasks/${task.id}/assignee`, "u-jordan", { method: "PATCH", body: JSON.stringify({ assignedUserId: "u-sam" }) })).status, 200);
    const afterReassign = (await request(`/api/projects/${createdProjectId}`, "u-jordan")).body.tasks.find((item) => item.id === task.id);
    assert.equal(afterReassign.assignedUserId, "u-sam");
    assert.deepEqual([...afterReassign.assigneeIds].sort(), ["u-casey", "u-sam"]);
    assert.equal((await patchOwners(["u-mary"])).status, 200);
    const caseyAfter = await request("/api/bootstrap", "u-casey");
    assert.equal(caseyAfter.body.tasks.find((item) => item.id === task.id)?.canEdit ?? false, false, "removed owner loses edit rights");
  });

  await t.test("edits task name, description and priority", async () => {
    const task = createdTasks.find((item) => item.title === "Research funding opportunities");
    const edit = (body, user = "u-jordan") => request(`/api/tasks/${task.id}`, user, { method: "PATCH", body: JSON.stringify(body) });
    assert.equal((await edit({ priority: "Urgent" })).status, 400);
    assert.equal((await edit({ title: " " })).status, 400);
    assert.equal((await edit({ title: "x".repeat(201) })).status, 400);
    assert.equal((await edit({ priority: "Low" }, "u-casey")).status, 404, "a non-owner employee cannot edit");
    const saved = await edit({ title: "Research grant funding", description: "Shortlist 3 regional grants.", priority: "High" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const ownerEdit = await edit({ priority: "Medium" }, "u-mary");
    assert.equal(ownerEdit.status, 200, "an owner can edit their task");
    const project = await request(`/api/projects/${createdProjectId}`, "u-jordan");
    const stored = project.body.tasks.find((item) => item.id === task.id);
    assert.equal(stored.title, "Research grant funding");
    assert.equal(stored.description, "Shortlist 3 regional grants.");
    assert.equal(stored.priority, "Medium");
    assert.ok(project.body.activities.some((item) => item.action === "Task edited" && item.details.includes("priority Medium → High")));
    assert.equal((await edit({ priority: "Medium" })).body.unchanged, true);
    createdTasks.find((item) => item.id === task.id).title = stored.title;
  });

  await t.test("blocks task completion until prerequisites are complete", async () => {
    const backgroundCheck = createdTasks.find((task) => task.title === "Complete background checks");
    const recruitInstructors = createdTasks.find((task) => task.title === "Recruit instructors");
    const blocked = await request(`/api/tasks/${backgroundCheck.id}/status`, "u-jordan", {
      method: "PATCH", body: JSON.stringify({ status: "Completed" })
    });
    assert.equal(blocked.status, 409);
    const prerequisite = await request(`/api/tasks/${recruitInstructors.id}/status`, "u-jordan", {
      method: "PATCH", body: JSON.stringify({ status: "Completed" })
    });
    assert.equal(prerequisite.status, 200);
    const nowReady = await request(`/api/projects/${createdProjectId}`, "u-jordan");
    assert.equal(nowReady.body.tasks.find((task) => task.id === backgroundCheck.id).isBlocked, false);
    const completed = await request(`/api/tasks/${backgroundCheck.id}/status`, "u-jordan", {
      method: "PATCH", body: JSON.stringify({ status: "Completed" })
    });
    assert.equal(completed.status, 200);
  });

  await t.test("previews and applies date shifts without moving completed tasks", async () => {
    const before = await request(`/api/projects/${createdProjectId}`, "u-jordan");
    const completedTask = before.body.tasks.find((task) => task.title === "Complete background checks");
    const openTask = before.body.tasks.find((task) => task.status !== "Completed");
    const manualDeadline = plusDays(300);
    const override = await request(`/api/tasks/${openTask.id}/due-date`, "u-jordan", {
      method: "PATCH", body: JSON.stringify({ dueDate: manualDeadline })
    });
    assert.equal(override.status, 200);
    const updatedBefore = await request(`/api/projects/${createdProjectId}`, "u-jordan");
    const overriddenTask = updatedBefore.body.tasks.find((task) => task.id === openTask.id);
    const newStartDate = plusDays(260);
    const preview = await request("/api/projects/date-preview", "u-jordan", {
      method: "POST", body: JSON.stringify({ projectId: createdProjectId, startDate: newStartDate })
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.shiftDays, 10);
    assert.ok(!preview.body.changes.some((change) => change.id === openTask.id));
    assert.ok(!preview.body.changes.some((change) => change.id === completedTask.id));
    const update = await request(`/api/projects/${createdProjectId}/start-date`, "u-jordan", {
      method: "PATCH", body: JSON.stringify({ startDate: newStartDate })
    });
    assert.equal(update.status, 200);
    const afterUpdate = await request(`/api/projects/${createdProjectId}`, "u-jordan");
    assert.equal(afterUpdate.body.tasks.find((task) => task.id === completedTask.id).dueDate, completedTask.dueDate);
    assert.equal(overriddenTask.dueDate, manualDeadline);
    assert.equal(afterUpdate.body.tasks.find((task) => task.id === openTask.id).dueDate, manualDeadline);
    assert.equal(afterUpdate.body.tasks.find((task) => task.id === openTask.id).dueDateOverride, true);
    assert.ok(afterUpdate.body.activities.some((activity) => activity.action === "Timeline updated"));
    assert.ok(afterUpdate.body.activities.some((activity) => activity.action === "Deadline overridden"));
    const employeeOverride = await request(`/api/tasks/${openTask.id}/due-date`, "u-mary", {
      method: "PATCH", body: JSON.stringify({ dueDate: plusDays(301) })
    });
    assert.equal(employeeOverride.status, 403);
  });

  await t.test("enforces role permissions and partner project/task visibility", async () => {
    const cannotCreate = await request("/api/projects", "u-mary", {
      method: "POST", body: JSON.stringify({})
    });
    assert.equal(cannotCreate.status, 403);
    const partnerBootstrap = await request("/api/bootstrap", "u-partner");
    assert.equal(partnerBootstrap.body.users.length, 7);
    assert.ok(partnerBootstrap.body.users.every((user) => !("email" in user)));
    assert.deepEqual(partnerBootstrap.body.projects.map((project) => project.id), ["p-seattle"]);
    assert.deepEqual(partnerBootstrap.body.tasks.map((task) => task.assignedUserId), ["u-partner"]);
    const unrelated = await request("/api/projects/p-tacoma", "u-partner");
    assert.equal(unrelated.status, 404);
    const partnerTask = partnerBootstrap.body.tasks[0];
    const partnerUpdate = await request(`/api/tasks/${partnerTask.id}/status`, "u-partner", {
      method: "PATCH", body: JSON.stringify({ status: "In Progress" })
    });
    assert.equal(partnerUpdate.status, 200);
    const unrelatedTaskComment = await request("/api/tasks/p-seattle-task-2/comments", "u-partner", {
      method: "POST", body: JSON.stringify({ content: "Comment on an unassigned internal task" })
    });
    assert.equal(unrelatedTaskComment.status, 404);
    const partnerProject = await request("/api/projects/p-seattle", "u-partner");
    assert.equal(partnerProject.body.members.length, 1);
    assert.equal(partnerProject.body.tasks.length, 1);
    assert.deepEqual(partnerProject.body.project.details, {});
    const programManagerBootstrap = await request("/api/bootstrap", "u-jordan");
    assert.equal(programManagerBootstrap.body.projects.length, 8);
    assert.ok(programManagerBootstrap.body.projects.some((project) => project.id === "p-portland"));
    const organizationProject = await request("/api/projects/p-portland", "u-jordan");
    assert.equal(organizationProject.status, 200);
    assert.ok(organizationProject.body.tasks.every((task) => task.canEdit === false));
    const forbiddenUpdate = await request(`/api/tasks/${organizationProject.body.tasks[0].id}/status`, "u-jordan", {
      method: "PATCH", body: JSON.stringify({ status: "In Progress" })
    });
    assert.equal(forbiddenUpdate.status, 404);
  });

  await t.test("allows administrators to change reusable template tasks", async () => {
    const before = await request("/api/templates/tpl-clinic", "u-catalina");
    assert.equal(before.status, 200);
    const changed = structuredClone(before.body);
    changed.name = "Updated Swim Safety Clinic";
    changed.tasks[0].title = "Confirm local clinic host";
    changed.tasks[0].relativeDueDays = -61;
    const saved = await request("/api/templates/tpl-clinic", "u-catalina", {
      method: "PATCH", body: JSON.stringify({ name: changed.name, description: changed.description, tasks: changed.tasks })
    });
    assert.equal(saved.status, 200);
    const afterSave = await request("/api/templates/tpl-clinic", "u-catalina");
    assert.equal(afterSave.body.name, changed.name);
    assert.equal(afterSave.body.tasks[0].title, changed.tasks[0].title);
    const programManagerCanRead = await request("/api/templates/tpl-clinic", "u-jordan");
    assert.equal(programManagerCanRead.status, 200);
    const programManagerCanEdit = await request("/api/templates/tpl-clinic", "u-jordan", {
      method: "PATCH", body: JSON.stringify({ name: changed.name, description: changed.description, tasks: changed.tasks })
    });
    assert.equal(programManagerCanEdit.status, 200);
    const unauthorized = await request("/api/templates/tpl-clinic", "u-mary", {
      method: "PATCH", body: JSON.stringify({ name: changed.name, description: changed.description, tasks: changed.tasks })
    });
    assert.equal(unauthorized.status, 403);
  });

  await t.test("requires production sign-in and protects administrator actions", async () => {
    const authDirectory = await mkdtemp(join(tmpdir(), "nmu-auth-test-"));
    const authPort = await availablePort();
    const authUrl = `http://127.0.0.1:${authPort}`;
    const adminEmail = "initial-admin@nmu.test";
    const adminPassword = "test-admin-password-123";
    const authServer = spawn(process.execPath, ["server.js"], {
      cwd: projectRoot,
      env: {
        ...process.env, NODE_ENV: "production", NMU_AUTH_MODE: "required",
        NMU_ADMIN_EMAIL: adminEmail, NMU_ADMIN_PASSWORD: adminPassword, NMU_ADMIN_NAME: "Initial Admin",
        NMU_DATABASE_PATH: join(authDirectory, "production.sqlite"), PORT: String(authPort)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverOutput = "";
    authServer.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
    authServer.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
    const authRequest = async (path, { method = "GET", cookie = "", body, origin = `${authUrl}` } = {}) => {
      const response = await fetch(`${authUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
          ...(origin ? { origin } : {}),
          "x-demo-user": "u-catalina"
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: response.status, body: await response.json().catch(() => ({})), setCookie: response.headers.get("set-cookie") || "" };
    };
    try {
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (authServer.exitCode !== null) throw new Error(`Auth test server exited early:\n${serverOutput}`);
        try {
          const response = await fetch(`${authUrl}/api/auth/config`);
          if (response.ok) { ready = true; break; }
        } catch {}
        await delay(100);
      }
      assert.equal(ready, true, `Auth test server did not start:\n${serverOutput}`);

      const config = await authRequest("/api/auth/config");
      assert.equal(config.body.required, true);
      assert.equal(config.body.administratorConfigured, true);
      const spoofed = await authRequest("/api/bootstrap");
      assert.equal(spoofed.status, 401);
      const wrongOrigin = await authRequest("/api/auth/login", {
        method: "POST", body: { email: adminEmail, password: adminPassword }, origin: "https://attacker.example"
      });
      assert.equal(wrongOrigin.status, 403);
      const badLogin = await authRequest("/api/auth/login", {
        method: "POST", body: { email: adminEmail, password: "incorrect-password" }
      });
      assert.equal(badLogin.status, 401);
      const login = await authRequest("/api/auth/login", {
        method: "POST", body: { email: adminEmail, password: adminPassword }
      });
      assert.equal(login.status, 200);
      assert.match(login.setCookie, /HttpOnly/);
      assert.match(login.setCookie, /SameSite=Strict/);
      assert.match(login.setCookie, /Secure/);
      const adminCookie = login.setCookie.split(";")[0];
      const bootstrap = await authRequest("/api/bootstrap", { cookie: adminCookie });
      assert.equal(bootstrap.status, 200);
      assert.equal(bootstrap.body.currentUser.email, adminEmail);
      assert.equal(bootstrap.body.projects.length, 0);
      const browserBootstrap = await authRequest("/api/bootstrap", { cookie: adminCookie, origin: "" });
      assert.equal(browserBootstrap.status, 200);

      const created = await authRequest("/api/users", {
        method: "POST", cookie: adminCookie,
        body: { name: "Team Member", email: "member@nmu.test", role: "employee", password: "member-test-password-456" }
      });
      assert.equal(created.status, 201);
      assert.ok(!JSON.stringify(created.body).includes("password_hash"));
      const productionProgram = await authRequest("/api/projects", {
        method: "POST", cookie: adminCookie,
        body: {
          name: "Authenticated template program", programType: "Learn to Swim",
          city: "Bellevue", state: "WA", location: "Bellevue, WA",
          hostOrganization: "Bellevue YMCA", deliveryType: "Community",
          startDate: "2030-06-01", endDate: "2030-06-01", templateId: "tpl-community",
          projectManagerId: bootstrap.body.currentUser.id, creationMode: "template",
          programHours: 18, leadInstructors: "Alex Rivera"
        }
      });
      assert.equal(productionProgram.status, 201, JSON.stringify(productionProgram.body));
      assert.equal(productionProgram.body.taskCount, 16);
      const productionDetail = await authRequest(`/api/projects/${productionProgram.body.projectId}`, { cookie: adminCookie });
      assert.equal(productionDetail.status, 200);
      assert.ok(productionDetail.body.tasks.every((task) => task.assigneeName));
      const accountList = await authRequest("/api/users", { cookie: adminCookie });
      assert.equal(accountList.status, 200);
      assert.equal(accountList.body.users.find((item) => item.email === "member@nmu.test").active, true);
      const duplicate = await authRequest("/api/users", {
        method: "POST", cookie: adminCookie,
        body: { name: "Team Member", email: "member@nmu.test", role: "employee", password: "member-test-password-456" }
      });
      assert.equal(duplicate.status, 409);

      const memberLogin = await authRequest("/api/auth/login", {
        method: "POST", body: { email: "member@nmu.test", password: "member-test-password-456" }
      });
      assert.equal(memberLogin.status, 200);
      assert.equal(memberLogin.body.user.role, "employee");
      const memberCookie = memberLogin.setCookie.split(";")[0];
      const changedPassword = await authRequest("/api/auth/password", {
        method: "PATCH", cookie: memberCookie,
        body: { currentPassword: "member-test-password-456", newPassword: "member-updated-password-789" }
      });
      assert.equal(changedPassword.status, 200);
      const oldPasswordLogin = await authRequest("/api/auth/login", {
        method: "POST", body: { email: "member@nmu.test", password: "member-test-password-456" }
      });
      assert.equal(oldPasswordLogin.status, 401);
      const updatedPasswordLogin = await authRequest("/api/auth/login", {
        method: "POST", body: { email: "member@nmu.test", password: "member-updated-password-789" }
      });
      assert.equal(updatedPasswordLogin.status, 200);
      const updatedMemberCookie = updatedPasswordLogin.setCookie.split(";")[0];
      const forbidden = await authRequest("/api/users", {
        method: "POST", cookie: updatedMemberCookie,
        body: { name: "Admin Two", email: "admin-two@nmu.test", role: "admin", password: "another-test-password-789" }
      });
      assert.equal(forbidden.status, 403);
      const disableSelf = await authRequest(`/api/users/${encodeURIComponent(created.body.user.id)}/active`, {
        method: "PATCH", cookie: updatedMemberCookie, body: { active: false }
      });
      assert.equal(disableSelf.status, 403);
      const disableMember = await authRequest(`/api/users/${encodeURIComponent(created.body.user.id)}/active`, {
        method: "PATCH", cookie: adminCookie, body: { active: false }
      });
      assert.equal(disableMember.status, 200);
      const revokedSession = await authRequest("/api/bootstrap", { cookie: updatedMemberCookie });
      assert.equal(revokedSession.status, 401);
      const enableMember = await authRequest(`/api/users/${encodeURIComponent(created.body.user.id)}/active`, {
        method: "PATCH", cookie: adminCookie, body: { active: true }
      });
      assert.equal(enableMember.status, 200);
      const logout = await authRequest("/api/auth/logout", { method: "POST", cookie: adminCookie });
      assert.equal(logout.status, 200);
      const afterLogout = await authRequest("/api/bootstrap", { cookie: adminCookie });
      assert.equal(afterLogout.status, 401);
    } finally {
      if (authServer.exitCode === null) {
        authServer.kill("SIGTERM");
        await new Promise((resolve) => authServer.once("exit", resolve));
      }
      await rm(authDirectory, { recursive: true, force: true });
    }
  });

  await t.test("syncs linked Airtable tables and writes only approved Work fields", async () => {
    const adminEmail = "airtable-admin@nmu.test";
    const adminPassword = "airtable-admin-password-2026";
    const tableNames = ["Users", "Templates", "Template List", "Roles", "Steps", "Programs", "Region", "Site", "Session", "Instructors", "Work", "WIP", "Activity Log", "Comments", "Notifications"];
    const tableIds = new Map(tableNames.map((name, index) => [name, `tbl${index + 1}`]));
    const link = (name, target) => ({ id: `fld${name.replaceAll(" ", "")}`, name, type: "multipleRecordLinks", options: { linkedTableId: tableIds.get(target) } });
    const text = (name) => ({ id: `fld${name.replaceAll(" ", "")}`, name, type: "singleLineText", options: {} });
    const dateField = (name) => ({ id: `fld${name.replaceAll(" ", "")}`, name, type: "date", options: {} });
    const numberField = (name) => ({ id: `fld${name.replaceAll(" ", "")}`, name, type: "number", options: {} });
    const statusField = { id: "fldStatus", name: "Status", type: "singleSelect", options: { choices: ["Not Started", "In Progress", "Done"].map((name) => ({ name })) } };
    const schemaFields = new Map([
      ["Users", [text("Email Address"), text("First Name"), text("Last Name"), link("Roles", "Roles")]],
      ["Templates", [text("Name")]],
      ["Template List", [text("List Name (Unique)"), dateField("Created"), statusField, link("Steps", "Steps")]],
      ["Roles", [text("Role Name"), statusField, link("Users", "Users"), link("Steps", "Steps"), link("Templates", "Templates")]],
      ["Steps", [text("Unique"), text("Short Description"), text("Long Description"), link("Dependancies", "Steps"), numberField("Days"), link("Template", "Templates"), link("Roles", "Roles")]],
      ["Programs", [text("Name")]],
      ["Region", [text("Name"), link("Site", "Site")]],
      ["Site", [text("Program Name"), link("Region", "Region"), link("Session", "Session"), text("Region Site"), text("Program Location"), link("Instructors", "Instructors"), link("Work", "Work")]],
      ["Session", [text("Session Name"), dateField("Start Date"), numberField("Duration (Days)"), dateField("End Date"), link("Site", "Site"), text("Region Site Session"), statusField, numberField("Program Hours"), link("Instructors", "Instructors"), link("Work", "Work")]],
      ["Instructors", [text("Instructor Name"), link("Site", "Site"), text("Email"), link("Session", "Session")]],
      ["Work", [text("Unique"), text("Notes"), link("Steps", "Steps"), link("Session", "Session"), numberField("Days (from Steps)"), dateField("Start Date (from Session)"), dateField("Due Date"), dateField("Completed Date"), statusField, link("Assignee", "Users")]],
      ["WIP", [text("Name")]],
      ["Activity Log", [text("Name"), text("Action")]],
      ["Comments", [text("Name"), text("Comment")]],
      ["Notifications", [text("Name"), text("Message")]]
    ]);
    const airtableRows = new Map(tableNames.map((name) => [name, []]));
    airtableRows.set("Activity Log", [{ id: "recActivity", fields: { Name: "Program update", Action: "Schedule confirmed" } }]);
    airtableRows.set("Comments", [{ id: "recComment", fields: { Name: "Host notes", Comment: "Pool schedule confirmed" } }]);
    airtableRows.set("Notifications", [{ id: "recNotification", fields: { Name: "Deadline reminder", Message: "Supplies due soon" } }]);
    airtableRows.set("Users", [{ id: "recAdmin", fields: { "Email Address": adminEmail, "First Name": "Initial", "Last Name": "Admin" } }]);
    airtableRows.set("Site", [{ id: "recSite", fields: { "Program Name": "Regional Swim", "Program Location": "Everett, WA" } }]);
    airtableRows.set("Session", [{ id: "recSession", fields: {
      "Session Name": "Winter Session", "Start Date": "2027-01-01", "Duration (Days)": 7,
      Site: [{ id: "recSite" }], Status: "Planning"
    } }]);
    airtableRows.set("Steps", [{ id: "recStep", fields: {
      Unique: "Confirm the host", "Short Description": "Confirm the host.", "Long Description": "Agree on the pool schedule.",
      Days: -5, Dependancies: []
    } }]);
    airtableRows.set("Work", [{ id: "recWork", fields: {
      Unique: "winter-host", Steps: [{ id: "recStep" }], Session: [{ id: "recSession" }],
      "Days (from Steps)": -5, "Due Date": "2026-12-27", "Completed Date": null,
      Status: "Not Started", Assignee: [{ id: "recAdmin" }]
    } }]);
    const patchCalls = [];
    const mockAirtable = createHttpServer(async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      const json = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === "/v0/meta/bases/appMock/tables") {
        return json(200, { tables: tableNames.map((name) => ({
          id: tableIds.get(name), name,
          fields: schemaFields.get(name).map((field) => ({ ...field, options: {
            ...field.options, linkedTableId: field.options?.linkedTableId
          } }))
        })) });
      }
      const [, version, baseId, tableId] = url.pathname.split("/");
      const tableName = [...tableIds].find(([, id]) => id === decodeURIComponent(tableId))?.[0];
      if (version !== "v0" || baseId !== "appMock" || !tableName) return json(404, { error: "Not found" });
      if (request.method === "GET") return json(200, { records: airtableRows.get(tableName) });
      if (request.method === "PATCH" && tableName === "Work") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const updates = JSON.parse(body).records;
        patchCalls.push(...updates);
        for (const update of updates) {
          const record = airtableRows.get("Work").find((item) => item.id === update.id);
          Object.assign(record.fields, update.fields);
        }
        return json(200, { records: updates.map((update) => ({
          id: update.id, fields: airtableRows.get("Work").find((item) => item.id === update.id).fields
        })) });
      }
      return json(405, { error: "Method not allowed" });
    });
    await new Promise((resolve) => mockAirtable.listen(0, "127.0.0.1", resolve));
    const mockPort = mockAirtable.address().port;
    const authDirectory = await mkdtemp(join(tmpdir(), "nmu-airtable-test-"));
    const authPort = await availablePort();
    const authUrl = `http://127.0.0.1:${authPort}`;
    const authServer = spawn(process.execPath, ["server.js"], {
      cwd: projectRoot,
      env: {
        ...process.env, NODE_ENV: "production", NMU_AUTH_MODE: "required",
        NMU_ADMIN_EMAIL: adminEmail, NMU_ADMIN_PASSWORD: adminPassword, NMU_ADMIN_NAME: "Initial Admin",
        AIRTABLE_API_KEY: "test-token", AIRTABLE_BASE_ID: "appMock",
        AIRTABLE_API_ROOT: `http://127.0.0.1:${mockPort}/v0`,
        NMU_DATABASE_PATH: join(authDirectory, "airtable.sqlite"), PORT: String(authPort)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverOutput = "";
    authServer.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
    authServer.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
    const authRequest = async (path, { method = "GET", cookie = "", body } = {}) => {
      const response = await fetch(`${authUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
          origin: authUrl
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return {
        status: response.status,
        body: await response.json().catch(() => ({})),
        setCookie: response.headers.get("set-cookie") || ""
      };
    };
    try {
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (authServer.exitCode !== null) throw new Error(`Airtable test server exited early:\n${serverOutput}`);
        try {
          if ((await fetch(`${authUrl}/api/auth/config`)).ok) { ready = true; break; }
        } catch {}
        await delay(100);
      }
      assert.equal(ready, true, `Airtable test server did not start:\n${serverOutput}`);
      const login = await authRequest("/api/auth/login", {
        method: "POST", body: { email: adminEmail, password: adminPassword }
      });
      assert.equal(login.status, 200);
      const cookie = login.setCookie.split(";")[0];
      const schema = await authRequest("/api/integrations/airtable/schema", { cookie });
      assert.equal(schema.status, 200);
      assert.equal(schema.body.tables.length, 15);
      const firstSync = await authRequest("/api/integrations/airtable/sync", { method: "POST", cookie, body: {} });
      assert.equal(firstSync.status, 200, JSON.stringify(firstSync.body));
      assert.equal(firstSync.body.projects, 1);
      assert.equal(firstSync.body.tasks, 1);
      assert.equal(Object.keys(firstSync.body.tables).length, 15);
      assert.equal(firstSync.body.tables["Activity Log"], 1);
      assert.equal(firstSync.body.tables.Comments, 1);
      assert.equal(firstSync.body.tables.Notifications, 1);
      assert.equal(firstSync.body.updatedWorkRecords, 0);
      const syncedTables = await authRequest("/api/integrations/airtable/tables", { cookie });
      assert.equal(syncedTables.status, 200);
      assert.equal(syncedTables.body.tables.length, 15);
      const stepsTable = syncedTables.body.tables.find((table) => table.name === "Steps");
      const stepRecords = await authRequest(`/api/integrations/airtable/tables/${stepsTable.id}/records?limit=10`, { cookie });
      assert.equal(stepRecords.status, 200);
      assert.equal(stepRecords.body.total, 1);
      assert.equal(stepRecords.body.records[0].fields.Dependancies.length, 0);
      assert.equal(stepRecords.body.recordLabels.recStep, "Confirm the host");
      const activityTable = syncedTables.body.tables.find((table) => table.name === "Activity Log");
      const activityRecords = await authRequest(`/api/integrations/airtable/tables/${activityTable.id}/records`, { cookie });
      assert.equal(activityRecords.body.records[0].fields.Action, "Schedule confirmed");
      const addEmployee = await authRequest("/api/users", {
        method: "POST", cookie, body: {
          name: "Table Viewer", email: "table-viewer@nmu.test",
          role: "employee", password: "table-viewer-password-2026"
        }
      });
      assert.equal(addEmployee.status, 201);
      const employeeLogin = await authRequest("/api/auth/login", {
        method: "POST", body: { email: "table-viewer@nmu.test", password: "table-viewer-password-2026" }
      });
      const employeeCookie = employeeLogin.setCookie.split(";")[0];
      const deniedTableRead = await authRequest("/api/integrations/airtable/tables", { cookie: employeeCookie });
      assert.equal(deniedTableRead.status, 403);
      const bootstrap = await authRequest("/api/bootstrap", { cookie });
      assert.equal(bootstrap.body.projects[0].name, "Regional Swim · Winter Session");
      assert.equal(bootstrap.body.projects[0].location, "Everett, WA");
      assert.equal(bootstrap.body.tasks[0].title, "Confirm the host.");
      assert.equal(bootstrap.body.tasks[0].assigneeName, "Initial Admin");

      const taskId = bootstrap.body.tasks[0].id;
      const localUpdate = await authRequest(`/api/tasks/${taskId}/status`, {
        method: "PATCH", cookie, body: { status: "Completed" }
      });
      assert.equal(localUpdate.status, 200);
      const outboundSync = await authRequest("/api/integrations/airtable/sync", { method: "POST", cookie, body: {} });
      assert.equal(outboundSync.status, 200);
      assert.equal(outboundSync.body.updatedWorkRecords, 1);
      assert.deepEqual(Object.keys(patchCalls[0].fields).sort(), ["Completed Date", "Status"]);
      assert.equal(patchCalls[0].fields.Status, "Done");
      assert.ok(patchCalls[0].fields["Completed Date"]);
      assert.equal(airtableRows.get("Work")[0].fields.Status, "Done");

      const localConflict = await authRequest(`/api/tasks/${taskId}/status`, {
        method: "PATCH", cookie, body: { status: "Not Started" }
      });
      assert.equal(localConflict.status, 200);
      airtableRows.get("Work")[0].fields.Status = "In Progress";
      airtableRows.get("Work")[0].fields["Completed Date"] = null;
      const conflictSync = await authRequest("/api/integrations/airtable/sync", { method: "POST", cookie, body: {} });
      assert.equal(conflictSync.status, 200);
      assert.equal(conflictSync.body.conflicts.length, 1);
      assert.equal(conflictSync.body.conflicts[0].field, "status");
      assert.equal(conflictSync.body.updatedWorkRecords, 0);
    } finally {
      if (authServer.exitCode === null) {
        authServer.kill("SIGTERM");
        await new Promise((resolve) => authServer.once("exit", resolve));
      }
      await new Promise((resolve, reject) => mockAirtable.close((error) => error ? reject(error) : resolve()));
      await rm(authDirectory, { recursive: true, force: true });
    }
  });
});
