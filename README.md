# Nova Brain

Nova Brain is the foundation for Brian: an extensible personal and business AI system for Sharp Cuts and future ventures.

## Current MVP

The repository now provides a small, serverless-compatible agent foundation:

- `GET /` serves the static Nova Brain landing page.
- `GET /api/health` returns a machine-readable health response.
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

### Landing page

```http
GET /
```

Vercel serves `index.html` for this route. The local Node adapter serves the same file.

### Health

```http
GET /api/health
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

Vercel serves the root `index.html` as a static asset and automatically treats `api/index.js` as a Node.js serverless function for API requests. `vercel.json` rewrites requests without a matching static asset to that function. Configure environment variables in Vercel Project Settings; do not add secrets to the repository.
