# Glass Group · NMU Program Operations

A web app for No More Under (NMU) to plan and run swim programs. Staff create a program from a template, and the app turns each template step into a task with an owner and a due date. The team then tracks those tasks through the program: status, deadlines, files and links, comments and activity.

**Airtable is the system of record.** The app has no database of its own. It reads the NMU Airtable base live and writes every change straight back to it, so people can work in Airtable and in the app at the same time.

- **Live site:** https://glass-group-nmu-production.up.railway.app (deployed by Railway from `main`)
- **App code and technical details:** [`NMU Program Management/`](./NMU%20Program%20Management/) — see its [README](./NMU%20Program%20Management/README.md)

## What the app does

| Page | What it's for |
|---|---|
| **Overview** | Active programs, tasks due this week, overdue tasks and overall completion (click a number to see the list), and the programs table with search, filters and CSV export. |
| **My tasks** | The signed-in person's tasks, with filters (due soon, overdue, blocked…), search and sorting. |
| **Programs** | Every program. Each program page has the tabs **Overview, Tasks, Timeline, Team, Activity and Resources**. |
| **Resources tab** | Program links (Google Drive folders, docs, websites) and uploaded files, plus everything attached to the program's tasks. |
| **Task details** | Status, owners (one or more), due date, priority, name and description, prerequisites, files and links, and notes. |
| **Timeline / Calendar** | Task deadlines by program, and a month/week calendar. |
| **Templates** | Edit template steps: name, days from program start, priority and planning phase. |
| **Airtable data** | Admins can browse every table in the base (read-only). |
| **Settings** | Change password; admins manage accounts and check the Airtable connection (**Check tables and fields**). |

Other behaviour:
- Moving a program's start date shifts the open tasks' dates with it.
- A task can't be completed until its prerequisites are done; an admin can override this and give a reason.
- People get in-app notifications when they're assigned work or a task becomes ready.

The **Airtable** status in the sidebar shows whether data is live, saving, or failed to save.

## Run locally

Requires Git and Node.js 22.13 or newer. There are no npm dependencies to install.

```sh
git clone https://github.com/jokingkingsley/Glass-Group-NMU.git
cd "Glass-Group-NMU/NMU Program Management"
npm run dev:mock
```

`dev:mock` runs the app against an in-memory copy of the base filled with fictional demo data, so you need no token, and nothing is saved when it stops. Open http://localhost:3000. In this mode you aren't asked to sign in, and the top bar lets you switch between demo people to see each role.

To run the app against the real base:
1. Copy `.env.example` to `.env`.
2. Fill in `AIRTABLE_API_KEY` and `AIRTABLE_BASE_ID`.
3. Run `npm start`.

`.env` is ignored by Git. Never commit it, and never paste a token into code or chat.

From the repository root, `npm start` and `npm test` also work. The root `package.json` is only there so Railway can detect Node.js and start the app from its subfolder.

## Deploying (Railway)

Railway deploys `main` automatically. In the Railway service settings, leave **Root Directory** empty. Set these variables:

| Variable | Value |
|---|---|
| `AIRTABLE_API_KEY` | Airtable personal access token. Needs scopes `data.records:read` and `data.records:write`, plus `schema.bases:read`, on the NMU base. |
| `AIRTABLE_BASE_ID` | The base ID (starts with `app`; it's in the base's URL). |
| `NMU_AUTH_MODE` | `required` |
| `NMU_ADMIN_EMAIL`, `NMU_ADMIN_PASSWORD` | The first administrator. Password must be 12+ characters. |
| `NMU_SESSION_SECRET` | A long random string that signs sign-in cookies. Make one with `openssl rand -hex 32`. |

On start-up the server creates the administrator in the Airtable `Users` table if needed. The Railway log shows which Airtable base it uses (`Using Airtable base app…`).

### Preparing the Airtable base

The app uses the base's existing tables and adds a few fields of its own. To see what's missing, run this with the base's token in `.env`:

```sh
cd "NMU Program Management"
npm run airtable:setup              # lists missing tables and fields; changes nothing
npm run airtable:setup -- --apply   # creates them (never deletes or renames anything)
```

`--apply` needs two things:
- `schema.bases:write` added to the token's scopes.
- **Creator** (or owner) permission on the base for the token's owner.

If you don't have that, a Creator can add the listed fields by hand in Airtable. Names must match exactly. The server notices new fields without a restart. In the app, **Settings → Check tables and fields** confirms everything is in place.

As of 2026-11-19 the NMU base has every table and field the app needs.

## Working on the code

Each teammate works in their own clone, on their own branch. Never work directly on `main`.

```sh
git switch main
git pull --ff-only origin main
git switch -c feature/short-description
# …make changes…
cd "NMU Program Management" && npm test
git add path/to/changed-file
git commit -m "Describe the change"
git push -u origin feature/short-description
```

Open a pull request into `main` and have a teammate review it. Railway deploys `main`, so **merging changes the live site**. Don't force-push shared branches.

The tests (`npm test`) run the whole app against a fake Airtable API that behaves like the real one, so they need no token. They cover:
- programs, tasks and permissions
- sign-in
- files and links
- that the app never writes Airtable's formula fields

## Current status

**Working (Nov 2026)**
- Airtable-only data with live sync
- Email and password sign-in with four roles (Admin, Program Manager, Employee, External Partner)
- Programs created from templates, with tasks, multiple owners, prerequisites and timeline shifts
- Calendar
- Files (up to 5 MB, stored as Airtable attachments) and links, per program and per task
- CSV export of programs and tasks

**Not built yet**
- Email reminders
- Creating, duplicating or deleting templates in the app (edit them in Airtable)
- Saving a finished program as a new template
- "Open in Google Sheets" (CSV files open in Sheets via File → Import)
- Google sign-in
- A manual "Blocked" status (Blocked is shown automatically when prerequisites are open)

**Safeguards**
- The app never writes Airtable's formula or lookup fields: `Session Name`, `End Date`, `Due Date`, `Status`, `Assignee` and `Effective Due Date`.
- Deleting a program moves it to the **trash** (Programs → Trash): it's hidden from everyone but stays in Airtable and can be restored. Only an admin can delete a trashed program for good, which removes its Session, Work and Resources records. Removing a file or link deletes only that `Resources` record.
- Demo data from `dev:mock` or `npm run airtable:seed -- --demo` is fictional.
