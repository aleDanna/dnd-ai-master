/**
 * Bearer-token reverse proxy that fronts ALL local AI daemons on this Mac
 * (Ollama, ComfyUI, Piper, XTTS) so a single Tailscale Funnel port can
 * expose them to a Vercel deploy.
 *
 * Topology:
 *   Vercel → https://<host>.<tailnet>.ts.net  (Tailscale Funnel)
 *          → http://127.0.0.1:11435            (THIS proxy, auth-gated)
 *          → http://127.0.0.1:11434  (Ollama)        for /ollama/*
 *            http://127.0.0.1:8050   (Piper)         for /piper/*
 *            http://127.0.0.1:7860   (Draw Things)   for /draw/*
 *
 * The first path segment selects the upstream; the rest is forwarded as-is
 * (query string preserved). Examples:
 *   /ollama/api/chat        → 127.0.0.1:11434/api/chat
 *   /piper/v1/audio/speech  → 127.0.0.1:8050/v1/audio/speech
 *   /draw/sdapi/v1/txt2img  → 127.0.0.1:7860/sdapi/v1/txt2img
 *
 * Auth: every request needs `Authorization: Bearer $LOCAL_LLM_TOKEN`, except
 * `GET /healthz` which always returns 204 (probe endpoint for the tunnel).
 *
 * The proxy listens on 127.0.0.1 only; Tailscale Funnel forwards public
 * traffic to localhost, so loopback binding is enough and avoids LAN expose.
 *
 * Env:
 *   LOCAL_LLM_TOKEN          (required) bearer token shared with Vercel
 *   TUNNEL_PROXY_PORT        listen port, default 11435
 *   TUNNEL_OLLAMA_UPSTREAM   default 127.0.0.1:11434
 *   TUNNEL_PIPER_UPSTREAM    default 127.0.0.1:8050
 *   TUNNEL_DRAW_UPSTREAM     default 127.0.0.1:7860
 *
 *   Set any *_UPSTREAM to '' to disable that route (returns 404).
 */
import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const TOKEN = process.env.LOCAL_LLM_TOKEN;
if (!TOKEN) {
  console.error('[tunnel-proxy] LOCAL_LLM_TOKEN is not set — refusing to start');
  process.exit(1);
}
const EXPECTED_AUTH = `Bearer ${TOKEN}`;

const LISTEN_PORT = Number(process.env.TUNNEL_PROXY_PORT ?? '11435');

interface Upstream {
  host: string;
  port: number;
}

function parseUpstream(envVal: string | undefined, fallback: string): Upstream | null {
  const raw = envVal ?? fallback;
  if (!raw) return null;
  const [host, portStr] = raw.split(':');
  const port = Number(portStr);
  if (!host || !Number.isFinite(port)) {
    console.error(`[tunnel-proxy] bad upstream "${raw}", expected host:port`);
    return null;
  }
  return { host, port };
}

const ROUTES: Record<string, Upstream | null> = {
  ollama: parseUpstream(process.env.TUNNEL_OLLAMA_UPSTREAM, '127.0.0.1:11434'),
  piper:  parseUpstream(process.env.TUNNEL_PIPER_UPSTREAM,  '127.0.0.1:8050'),
  draw:   parseUpstream(process.env.TUNNEL_DRAW_UPSTREAM,   '127.0.0.1:7860'),
};

function authOk(headerVal: string | undefined): boolean {
  if (!headerVal) return false;
  if (headerVal.length !== EXPECTED_AUTH.length) return false;
  try {
    return timingSafeEqual(Buffer.from(headerVal), Buffer.from(EXPECTED_AUTH));
  } catch {
    return false;
  }
}

function splitRoute(reqUrl: string): { prefix: string; rest: string } | null {
  // reqUrl includes path + optional ?query. Find the boundary between the
  // first segment (prefix) and the rest, preserving the query string.
  const noLeadSlash = reqUrl.replace(/^\/+/, '');
  const qIdx = noLeadSlash.search(/[?#]/);
  const pathOnly = qIdx >= 0 ? noLeadSlash.slice(0, qIdx) : noLeadSlash;
  const queryTail = qIdx >= 0 ? noLeadSlash.slice(qIdx) : '';
  const slashIdx = pathOnly.indexOf('/');
  const prefix = slashIdx >= 0 ? pathOnly.slice(0, slashIdx) : pathOnly;
  const remainder = slashIdx >= 0 ? pathOnly.slice(slashIdx) : '/';
  if (!prefix) return null;
  return { prefix, rest: remainder + queryTail };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!authOk(req.headers['authorization'])) {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.setHeader('www-authenticate', 'Bearer realm="ai-tunnel"');
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const route = splitRoute(req.url ?? '/');
  if (!route) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'no-route', hint: 'use /ollama|/piper|/draw prefix' }));
    return;
  }
  const upstream = ROUTES[route.prefix];
  if (!upstream) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'unknown-route', prefix: route.prefix, available: Object.keys(ROUTES).filter((k) => ROUTES[k]) }));
    return;
  }

  // Strip bearer + rewrite Host so the upstream gets a sane request.
  const forwardHeaders: http.OutgoingHttpHeaders = { ...req.headers };
  delete forwardHeaders['authorization'];
  forwardHeaders['host'] = `${upstream.host}:${upstream.port}`;

  const proxyReq = http.request(
    {
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: route.rest,
      headers: forwardHeaders,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (e) => {
    console.error(`[tunnel-proxy] upstream ${route.prefix} error`, e.message);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'upstream-error', route: route.prefix, detail: e.message }));
    } else {
      res.destroy();
    }
  });

  req.pipe(proxyReq);
});

// WebSocket upgrades aren't used by any current call site; refuse them
// explicitly rather than 500-ing on a half-open socket.
server.on('upgrade', (_req, socket) => {
  socket.end('HTTP/1.1 501 Not Implemented\r\n\r\n');
});

server.on('clientError', (err, socket) => {
  console.error('[tunnel-proxy] client error', err.message);
  socket.destroy();
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  const routes = Object.entries(ROUTES)
    .map(([k, v]) => `${k}=${v ? `${v.host}:${v.port}` : 'disabled'}`)
    .join(' ');
  console.log(`[tunnel-proxy] listening on 127.0.0.1:${LISTEN_PORT} (bearer-auth) → ${routes}`);
});

function shutdown(signal: string): void {
  console.log(`[tunnel-proxy] ${signal} received, closing`);
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
