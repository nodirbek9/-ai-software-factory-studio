// Assembles sample-projects/todo-service/.asf-script.json from scripts/sample-sources/todo-service.
// The script is replayed by the "Scripted (offline, not AI)" provider to exercise the full pipeline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'scripts', 'sample-sources', 'todo-service');
const target = path.join(root, 'sample-projects', 'todo-service', '.asf-script.json');

function filesOf(taskKey) {
  const base = path.join(sources, taskKey);
  const result = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else result.push({ path: path.relative(base, full).split(path.sep).join('/'), content: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(base);
  return result;
}

const script = {
  plan: {
    tasks: [
      { key: 'todo-store', title: 'In-memory todo store with validation', role: 'backend', dependsOn: [],
        description: 'Create src/todoStore.js with create/list/update/remove and title validation (1-200 chars, trimmed).' },
      { key: 'web-ui', title: 'Static todo web UI', role: 'frontend', dependsOn: [],
        description: 'Create public/index.html and public/app.js: list, add, toggle and delete todos; escape user text.' },
      { key: 'http-api', title: 'HTTP REST API and static hosting', role: 'backend', dependsOn: ['todo-store'],
        description: 'Create src/server.js exposing /api/todos CRUD with proper status codes and serving public/.' },
      { key: 'api-tests', title: 'Automated tests for store and API', role: 'qa', dependsOn: ['http-api', 'web-ui'],
        description: 'Add node:test tests for the store and the HTTP API, then run npm test.' },
    ],
  },
  architecture: `# Implementation plan — todo-service

## Overview
Zero-dependency Node.js service: an in-memory store behind a \`node:http\` REST API that also serves a static UI.

## Modules
| File | Responsibility |
|---|---|
| \`src/todoStore.js\` | Domain + validation, immutable copies out |
| \`src/server.js\` | Routing, JSON parsing (64 KB limit), error mapping, static files |
| \`public/index.html\`, \`public/app.js\` | UI using \`fetch\`, text rendered with \`textContent\` |
| \`test/todo.test.js\` | \`node:test\` unit + HTTP tests on an ephemeral port |

## API
\`GET/POST /api/todos\`, \`PATCH/DELETE /api/todos/:id\`; errors are \`{ "error": string }\` with 400/404/413.

## Testing
\`npm test\` → \`node --test\`. The HTTP tests start the server on port 0.

## Risks
In-memory data is lost on restart (accepted by the spec).
`,
  tasks: {
    'todo-store': { delayMs: 2500, summary: 'Added src/todoStore.js: in-memory store with title validation and not-found errors.', files: filesOf('todo-store') },
    'web-ui': { delayMs: 3500, summary: 'Added public/index.html and public/app.js (textContent rendering, fetch-based actions).', files: filesOf('web-ui') },
    // First attempt fails on purpose so the retry path is exercised.
    'http-api': { delayMs: 2000, failAttempts: 1, summary: 'Added src/server.js with CRUD routes, body limit, error mapping and static hosting.', files: filesOf('http-api') },
    'api-tests': { delayMs: 1500, summary: 'Added test/todo.test.js covering the store and the HTTP API lifecycle.', files: filesOf('api-tests') },
    'security-review': { delayMs: 1500, text: `## Security review

- Request bodies are capped at 64 KB (\`src/server.js\`) — OK.
- Static file serving normalises the path and rejects \`..\` — OK.
- UI renders titles with \`textContent\`, no HTML injection — OK.
- LOW: no rate limiting; acceptable for a local sample.

VERDICT: PASS` },
    'final-review': { delayMs: 1500, text: `## Final review

- Store returns copies and validates input consistently.
- API maps domain errors to 400/404/413 and has a JSON 404 for unknown API routes.
- Tests cover the store, the full HTTP lifecycle, validation and static hosting.

VERDICT: PASS` },
  },
  chat: 'I am the offline scripted provider (not an AI). Assign Claude Code, Codex, Gemini or an OpenAI-compatible provider to this agent for real answers.',
};

fs.writeFileSync(target, `${JSON.stringify(script, null, 2)}\n`);
console.log(`wrote ${path.relative(root, target)}`);
