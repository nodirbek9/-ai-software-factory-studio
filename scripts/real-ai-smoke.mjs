// Real-provider end-to-end check against a running studio (default http://127.0.0.1:4317).
// Usage: node scripts/real-ai-smoke.mjs [providerId] [model]
// It enables the provider, assigns it to every agent WITHOUT fallback, creates a tiny project,
// approves the plan and waits for the final state. This spends real model quota.
const base = process.env.ASF_URL ?? 'http://127.0.0.1:4317';
const providerId = process.argv[2] ?? 'claude-code';
const model = process.argv[3] ?? 'haiku';
const roles = ['pm', 'architect', 'backend', 'frontend', 'qa', 'security', 'reviewer'];

async function call(method, path, body) {
  if (method !== 'GET' && body === undefined) body = {}; // the API requires JSON on every mutation (CSRF guard)
  const response = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

const spec = `# Slugify utility

Create a dependency-free Node.js (22+) ES module library.

- \`package.json\` with "type": "module" and the script "test": "node --test".
- \`src/slugify.js\` exporting \`slugify(text)\`: lowercase, trim, replace every run of characters that are not a-z or 0-9 with a single "-", and strip leading/trailing "-". Non-string input throws a TypeError.
- \`test/slugify.test.js\` using node:test and node:assert covering normal text, punctuation runs, leading/trailing separators and the TypeError.
There is no frontend in this project.`;

// "current" keeps the agent assignments made in the UI and uses a spec with backend + frontend work.
const fullSpec = `# Unit converter

Dependency-free Node.js (22+) ES module project.

## Backend
- \`package.json\` with "type": "module" and scripts "test": "node --test" and "start": "node src/server.js".
- \`src/convert.js\` exporting \`convert(value, from, to)\` for length units m, km, cm, mi, ft. Unknown units or non-finite values throw a TypeError.
- \`src/server.js\` (node:http): \`GET /api/convert?value=&from=&to=\` returns {"result": number}; invalid input returns 400 {"error": string}; serves \`public/\`. Export a createServer function so tests can listen on port 0.

## Frontend
- \`public/index.html\` + \`public/app.js\`: a small form (value, from, to) that calls the API and shows the result or the error text (render with textContent).

## Quality
- node:test tests in \`test/\` for convert() and the HTTP API.`;

const keep = providerId === 'current';
if (!keep) {
  await call('PATCH', `/api/providers/${providerId}`, { enabled: true });
  for (const role of roles) await call('PUT', `/api/agents/${role}/config`, { providerId, model, allowFallback: false });
}
const project = await call('POST', '/api/projects', { name: `${keep ? 'Mixed AI' : 'Real AI'} smoke ${new Date().toISOString().slice(11, 19)}`,
  spec: keep ? fullSpec : spec, workspaceMode: 'new', testCommand: 'npm test' });
console.log('project', project.id);
await call('POST', `/api/projects/${project.id}/plan`);

const started = Date.now();
let approved = false;
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const snap = await call('GET', `/api/projects/${project.id}`);
  const pending = snap.approvals.find((a) => a.status === 'pending' && a.kind === 'plan');
  if (pending && !approved) {
    console.log('plan tasks:', pending.details.tasks.map((t) => `${t.role}:${t.key}`).join(', '));
    await call('POST', `/api/approvals/${pending.id}/decision`, { decision: 'approved', note: 'real AI smoke test' });
    approved = true;
  }
  const line = snap.tasks.map((t) => `${t.key}=${t.status}`).join(' ');
  console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${snap.project.status} | ${line}`);
  if (['completed', 'failed', 'cancelled'].includes(snap.project.status)) {
    for (const t of snap.tasks.filter((x) => x.error)) console.log(`ERROR ${t.key}: ${t.error.slice(0, 400)}`);
    const qa = snap.tasks.find((t) => t.testResult);
    if (qa) console.log('tests:', qa.testResult.command, qa.testResult.passed ? 'PASSED' : 'FAILED', qa.testResult.summary);
    const cost = snap.agents.reduce((s, a) => s + (a.usage.costUsd ?? 0), 0);
    console.log(`final: ${snap.project.status}, cost $${cost.toFixed(4)}`);
    break;
  }
  if (Date.now() - started > 25 * 60_000) { console.log('timeout'); break; }
}
