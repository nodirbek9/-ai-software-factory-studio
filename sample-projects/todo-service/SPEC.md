# Todo Service — technical specification

Build a tiny todo application with zero runtime dependencies (Node.js 22+ only).

## Backend
- In-memory todo store (`src/todoStore.js`): create, list, update (title / done), delete.
- Validation: title is required, trimmed, 1–200 characters; unknown ids return a not-found error.
- HTTP API (`src/server.js`, `node:http`):
  - `GET /api/todos` → 200 list
  - `POST /api/todos` `{ title }` → 201 created todo, 400 on invalid input
  - `PATCH /api/todos/:id` `{ title?, done? }` → 200, 404 when missing
  - `DELETE /api/todos/:id` → 204, 404 when missing
  - Serves the static UI from `public/`.

## Frontend
- `public/index.html` + `public/app.js`: list todos, add, toggle done, delete. Escape user text.

## Quality
- Automated tests with `node:test` (`npm test`) covering the store and the HTTP API.
