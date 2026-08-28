# Nova Brain

Nova Brain is the foundation for Brian: an extensible personal and business AI system for Sharp Cuts and future ventures.

## Current MVP

The repository now provides a small, serverless-compatible agent foundation:

- `GET /` returns a safe health response.
- `POST /api/agent` accepts a validated agent request and returns a deterministic mock response.
- `POST /api/missed-call` preserves the original scaffold endpoint as a validated intake placeholder.
- The agent, model provider, tools, memory, configuration, and HTTP adapter are separate modules.

No real AI provider, telephony, SMS, business integration, authentication, or durable database is connected yet.

## Run locally

Requires Node.js 20 or later.

```bash
npm install
npm run dev
npm test
```

Copy `.env.example` to `.env.local` for local values. Never commit a real `.env` file.

## API

### Health

```http
GET /
```

### Agent request

```http
POST /api/agent
Content-Type: application/json

{
  "message": "Help me plan this week's Sharp Cuts marketing."
}
```

The default `mock` provider makes this endpoint usable without credentials. Its response is deliberately deterministic, not AI-generated.

### Missed-call intake placeholder

```http
POST /api/missed-call
Content-Type: application/json

{
  "name": "A customer",
  "phone": "+441234567890"
}
```

This endpoint does not send messages, create leads, or contact external services.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the canonical MVP boundaries and extension points.

## Deployment

Vercel automatically treats `api/index.js` as a Node.js serverless function. `vercel.json` rewrites requests to that function. Configure environment variables in Vercel Project Settings; do not add secrets to the repository.
