// Runs only the planning phase (PM + Architect) of a tiny project with the current agent assignments,
// prints which provider/model/effort actually ran, then cancels the project. Spends a little real quota.
const base = process.env.ASF_URL ?? 'http://127.0.0.1:4317';

async function call(method, path, body) {
  if (method !== 'GET' && body === undefined) body = {};
  const response = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

const spec = '# Greeting library\n\nES module `src/greet.js` exporting `greet(name)` that returns "Hello, <name>!" and throws TypeError for non-strings. Tests with node:test. package.json with "type": "module" and "test": "node --test".';
const project = await call('POST', '/api/projects', { name: `Planning check ${new Date().toISOString().slice(11, 19)}`, spec, workspaceMode: 'new', testCommand: 'npm test' });
await call('POST', `/api/projects/${project.id}/plan`);
const started = Date.now();
let snap;
for (;;) {
  await new Promise((r) => setTimeout(r, 4000));
  snap = await call('GET', `/api/projects/${project.id}`);
  if (['awaiting_approval', 'failed', 'cancelled'].includes(snap.project.status) || Date.now() - started > 15 * 60_000) break;
}
const events = await call('GET', `/api/projects/${project.id}/events?limit=2000`);
for (const e of events.filter((x) => ['agent.started', 'agent.model', 'provider.fallback'].includes(x.type))) console.log(`${e.role}: ${e.type} — ${e.message}`);
for (const t of snap.tasks.filter((x) => x.kind === 'plan' || x.kind === 'architecture')) {
  console.log(`${t.key}: ${t.status} provider=${t.providerId} model=${t.model} tokens=${t.usage ? t.usage.inputTokens + t.usage.outputTokens : 0} cost=${t.usage?.costUsd}${t.error ? ` ERROR ${t.error}` : ''}`);
}
console.log(`status ${snap.project.status} after ${Math.round((Date.now() - started) / 1000)}s`);
await call('POST', `/api/projects/${project.id}/cancel`);
