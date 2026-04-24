// ============================================================
// Launchmen Task API — Trial 2 (fixed)
// ============================================================
// Instructions:
//   Run with: npm install && node Test_2_server.js
//   Server starts on: http://localhost:3000
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Minimal CORS so the static UI (opened via file:// or a different
// origin) can call this API during local testing.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const DB_FILE = path.join(__dirname, 'Test_2_tasks.json');

function loadTasks() {
  if (!fs.existsSync(DB_FILE)) return [];
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  if (!raw.trim()) return [];
  return JSON.parse(raw);
}

function saveTasks(tasks) {
  fs.writeFileSync(DB_FILE, JSON.stringify(tasks, null, 2));
}

// GET /tasks
// Returns all tasks. Supports optional ?status= filter.
//
// Edge case decision: if the client sends ?status= with an empty value
// (e.g. `/tasks?status=`) we treat it as "no filter provided" and
// return every task, rather than filtering for tasks whose status is
// an empty string. An empty filter is almost always an accidental
// omission by the caller, not an intentional query for status === "".
app.get('/tasks', (req, res) => {
  const tasks = loadTasks();
  const { status } = req.query;
  if (status && status.trim() !== '') {
    const filtered = tasks.filter(t => t.status === status);
    return res.json({ success: true, tasks: filtered });
  }
  res.json({ success: true, tasks });
});

// POST /tasks
app.post('/tasks', (req, res) => {
  const { title, status } = req.body || {};

  // BUG FIX: Missing title validation. Spec requires 400 when title is
  // absent or empty; original code blindly accepted any payload and
  // created tasks with `title: undefined`.
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ success: false, message: 'title is required' });
  }

  const tasks = loadTasks();
  const newTask = {
    id: Date.now(),
    title: title.trim(),
    // BUG FIX: status was stored as-is (undefined when omitted). Spec
    // says it must default to "pending" when not provided.
    status: status || 'pending',
  };
  tasks.push(newTask);
  saveTasks(tasks);

  // BUG FIX: Created resources should respond with HTTP 201, not the
  // default 200 that res.json() produces.
  res.status(201).json({ success: true, task: newTask });
});

// PATCH /tasks/:id
app.patch('/tasks/:id', (req, res) => {
  const tasks = loadTasks();
  const { status } = req.body || {};

  // BUG FIX: req.params.id is always a string, but task IDs are stored
  // as numbers (Date.now()). The original strict `===` comparison
  // never matched, so every update returned 404. Coerce to Number for
  // the lookup.
  const id = Number(req.params.id);
  const task = tasks.find(t => t.id === id);
  if (!task) {
    return res.status(404).json({ success: false, message: 'Task not found' });
  }

  if (typeof status === 'string' && status.trim()) {
    task.status = status;
  }
  saveTasks(tasks);
  res.json({ success: true, task });
});

// DELETE /tasks/:id
app.delete('/tasks/:id', (req, res) => {
  const tasks = loadTasks();

  // BUG FIX: Same string/number ID mismatch as PATCH.
  const id = Number(req.params.id);
  const index = tasks.findIndex(t => t.id === id);

  // BUG FIX: Original code skipped the 404 check entirely and would
  // happily "delete" a non-existent task.
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Task not found' });
  }

  // BUG FIX: Original did `tasks = tasks.splice(index, 1)`, which
  // reassigned `tasks` to the *removed* element array and then wrote
  // that single-element list back to disk — wiping every other task.
  // splice mutates in place; don't reassign.
  tasks.splice(index, 1);
  saveTasks(tasks);

  res.json({ success: true, message: 'Task deleted' });
});

app.listen(3000, () => {
  console.log('Launchmen Task API running on http://localhost:3000');
});

// ============================================================
// Trial 2 — Task 3: SQL Performance Review
// ============================================================
//
// 1. Identify the issue
//    This is the classic N+1 query problem. The code runs one query
//    to fetch 50 posts, then inside the loop fires a separate
//    `SELECT ... FROM authors WHERE id = ...` for every post. That is
//    1 + 50 = 51 round trips to the database for a single page load.
//    Each round trip adds network latency and connection overhead, so
//    the page gets slower linearly with the page size.
//
//    Two additional problems in the same snippet:
//      - The author id is interpolated directly into the SQL string
//        (`WHERE id = ${post.author_id}`). That is a SQL injection
//        vector; parameterised queries should be used instead.
//      - If many posts share the same author, the code re-fetches the
//        same author row repeatedly.
//
// 2. How to fix it
//    Replace the loop with a single JOIN so the database returns
//    posts and their authors in one round trip:
//
//    const postsWithAuthors = await db.query(
//      `SELECT p.id, p.title, p.created_at,
//              a.id   AS author_id,
//              a.name AS author_name,
//              a.email AS author_email
//         FROM posts p
//         JOIN authors a ON a.id = p.author_id
//        ORDER BY p.created_at DESC
//        LIMIT 50`
//    );
//
//    return postsWithAuthors.map(r => ({
//      id: r.id,
//      title: r.title,
//      created_at: r.created_at,
//      author: { id: r.author_id, name: r.author_name, email: r.author_email },
//    }));
//
//    If a JOIN isn't desirable (e.g. the ORM can't express it), batch
//    the author lookup instead of looping:
//
//    const authorIds = [...new Set(posts.map(p => p.author_id))];
//    const authors = await db.query(
//      `SELECT id, name, email FROM authors WHERE id = ANY($1)`,
//      [authorIds]
//    );
//    const byId = new Map(authors.map(a => [a.id, a]));
//    return posts.map(p => ({ ...p, author: byId.get(p.author_id) }));
//
//    That turns 51 queries into 2 and also uses a parameterised query,
//    closing the SQL injection hole. For further speed, ensure there
//    is an index on posts.created_at (for the ORDER BY ... LIMIT) and
//    the existing PK on authors.id already covers the lookup side.
// ============================================================
