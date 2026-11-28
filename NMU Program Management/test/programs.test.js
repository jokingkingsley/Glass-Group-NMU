// Program creation (team, template dates), and the program trash.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createMockAirtable } from "./helpers/mock-airtable.js";
import { SCHEMA, T } from "../airtable-schema.js";
import { demoRows } from "../seed-data.js";
import { NMU_BASE_2026_11_18 } from "./fixtures/nmu-base.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const today = new Date().toISOString().slice(0, 10);
const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function startApp(base) {
  const apiRoot = await base.start();
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const app = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), NODE_ENV: "test", NMU_AUTH_MODE: "", AIRTABLE_API_KEY: "test-token", AIRTABLE_BASE_ID: "appMock", AIRTABLE_API_ROOT: apiRoot, NMU_AIRTABLE_CACHE_MS: "0", NMU_AIRTABLE_MIN_INTERVAL_MS: "0" }
  });
  let output = "";
  app.stdout.on("data", (chunk) => { output += chunk; });
  app.stderr.on("data", (chunk) => { output += chunk; });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (app.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${url}/api/auth/config`)).ok) break; } catch {}
    await delay(100);
  }
  const call = async (path, user, body, method = body ? "POST" : "GET") => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", "x-demo-user": user }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  return { call, stop: async () => { app.kill("SIGTERM"); await new Promise((resolve) => app.once("exit", resolve)); await base.close(); } };
}

test("create with a team and a short lead time; trash, restore and delete for good", async () => {
  const base = createMockAirtable({ tables: SCHEMA, rows: demoRows() });
  const { call, stop } = await startApp(base);
  try {
    // The Community template plans 120 days of prep; this program starts in 30.
    const created = await call("/api/projects", "u-jordan", {
      name: "Short notice program", programType: "Learn to Swim", siteId: "site-p-seattle", startDate: inDays(30),
      projectManagerId: "u-jordan", templateId: "tpl-community", creationMode: "template", teamIds: ["u-mary", "u-sam", "u-partner"]
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.taskCount, 16);
    assert.equal(created.body.compressed, true);
    const id = created.body.projectId;
    const project = await call(`/api/projects/${id}`, "u-jordan");
    assert.ok(project.body.tasks.every((task) => task.dueDate >= today), "no generated task starts out overdue");
    assert.equal(project.body.tasks.find((task) => task.title === "Launch program").dueDate, inDays(30), "start-day step stays on the start date");
    assert.deepEqual(base.record(T.sessions, id).fields.Team.sort(), ["u-mary", "u-partner", "u-sam"]);
    assert.ok(project.body.activities.some((item) => /fitted between today and the start date/.test(item.details)));

    // Employees can't trash; the program manager can, and it disappears everywhere.
    assert.equal((await call(`/api/projects/${id}/trash`, "u-mary", {})).status, 404);
    assert.equal((await call(`/api/projects/${id}/trash`, "u-jordan", {})).status, 200);
    let boot = await call("/api/bootstrap", "u-jordan");
    assert.ok(!boot.body.projects.some((item) => item.id === id));
    assert.ok(!boot.body.tasks.some((task) => task.projectId === id));
    assert.equal(boot.body.trash.length, 1);
    assert.equal(boot.body.trash[0].taskCount, 16);
    assert.equal(boot.body.trash[0].canDeleteForever, false);
    assert.equal((await call(`/api/projects/${id}`, "u-jordan")).status, 404);
    assert.ok(base.record(T.sessions, id), "a trashed program is still in Airtable");

    // Restore brings it back with its tasks.
    assert.equal((await call(`/api/projects/${id}/restore`, "u-jordan", {})).status, 200);
    boot = await call("/api/bootstrap", "u-jordan");
    assert.equal(boot.body.projects.find((item) => item.id === id).taskCount, 16);
    assert.equal(boot.body.trash.length, 0);
    assert.ok(!("deletedAt" in JSON.parse(base.record(T.sessions, id).fields.Details)));

    // Only admins can delete for good, and only from the trash.
    assert.equal((await call(`/api/projects/${id}/delete-forever`, "u-catalina", {})).status, 404, "must be in the trash first");
    await call(`/api/projects/${id}/trash`, "u-catalina", {});
    assert.equal((await call(`/api/projects/${id}/delete-forever`, "u-jordan", {})).status, 403);
    const gone = await call(`/api/projects/${id}/delete-forever`, "u-catalina", {});
    assert.equal(gone.status, 200);
    assert.equal(gone.body.deletedTasks, 16);
    assert.equal(base.record(T.sessions, id), undefined);
    assert.ok(!base.records(T.work).some((record) => record.fields.Session?.includes(id)));
  } finally {
    await stop();
  }
});

test("a 141-step template on the real NMU base layout generates every task", async () => {
  const tables = NMU_BASE_2026_11_18.map((table) => {
    const app = SCHEMA.find((item) => item.name === table.name);
    const extra = (app?.fields || []).filter((field) => !field.readOnly && !table.fields.some((own) => own.name === field.name));
    return { ...table, fields: [...table.fields, ...extra] };
  }).concat(SCHEMA.filter((table) => table.name === T.resources));
  const steps = Array.from({ length: 141 }, (_, index) => ({ id: `recStep${index + 1}`, fields: {
    "Short Description": `Step ${index + 1}`, Days: -150 + index, Template: ["recTpl"], ID: index + 1,
    ...(index ? { Dependencies: [`recStep${index}`] } : {})
  } }));
  const rows = {
    Users: [{ id: "recAdmin", fields: { "Email Address": "admin@nmu.org", "First Name": "Ana", Rights: ["Admin"] } }],
    "Template List": [{ id: "recTpl", fields: { "List Name (Unique)": "NonYMCA · Learn to Swim", "Program Type": "Learn to Swim", Steps: steps.map((step) => step.id) } }],
    Steps: steps,
    Site: [{ id: "recSite", fields: { "Program Name": "Evanston Public Pool", "Program Location": "Evanston, IL" } }]
  };
  const base = createMockAirtable({ tables, rows });
  const { call, stop } = await startApp(base);
  try {
    const created = await call("/api/projects", "recAdmin", {
      name: "Evanston", programType: "Learn to Swim", siteId: "recSite", startDate: inDays(60),
      projectManagerId: "recAdmin", templateId: "recTpl", creationMode: "template"
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.taskCount, 141);
    const project = await call(`/api/projects/${created.body.projectId}`, "recAdmin");
    assert.equal(project.body.tasks.length, 141);
    assert.ok(project.body.tasks.every((task) => task.dueDate >= today));
    assert.equal(project.body.tasks.find((task) => task.title === "Step 2").dependencies[0].title, "Step 1");
  } finally {
    await stop();
  }
});
