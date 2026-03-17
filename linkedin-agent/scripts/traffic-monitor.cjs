// ═══════════════════════════════════════════════════════════════
// Network Traffic Monitor — zero-change application interceptor
// ═══════════════════════════════════════════════════════════════
//
// Usage:
//   node --require ./scripts/traffic-monitor.cjs src/index.js
//
// Or combine with suppress-warnings:
//   node --require ./scripts/suppress-warnings.cjs --require ./scripts/traffic-monitor.cjs src/index.js
//
// Output: logs all outbound HTTP/HTTPS requests and inbound
// Express requests with timing, status, and headers.
//
// Log file: data/traffic.log (also prints to console)
// ═══════════════════════════════════════════════════════════════

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Log file setup ───────────────────────────────────────────

const LOG_DIR = path.join(process.cwd(), 'data');
const LOG_FILE = path.join(LOG_DIR, 'traffic.log');

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(direction, entry) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${direction} ${JSON.stringify(entry)}`;
  console.log(`\x1b[${direction === 'EGRESS' ? '33' : '36'}m${line}\x1b[0m`);
  logStream.write(line + '\n');
}

// ── Mask sensitive headers ───────────────────────────────────

const SENSITIVE = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);

function safeHeaders(headers) {
  if (!headers) return {};
  const safe = {};
  for (const [key, val] of Object.entries(headers)) {
    if (SENSITIVE.has(key.toLowerCase())) {
      const str = String(val);
      safe[key] = str.substring(0, 12) + '...[REDACTED]';
    } else {
      safe[key] = val;
    }
  }
  return safe;
}

// ── Patch outbound requests (EGRESS) ─────────────────────────

function patchModule(mod, protocol) {
  const originalRequest = mod.request;

  mod.request = function patchedRequest(options, callback) {
    const startTime = Date.now();

    // Normalize options
    let method, hostname, portNum, reqPath;
    if (typeof options === 'string') {
      const u = new URL(options);
      method = 'GET';
      hostname = u.hostname;
      portNum = u.port || (protocol === 'https' ? 443 : 80);
      reqPath = u.pathname + u.search;
    } else if (options instanceof URL) {
      method = 'GET';
      hostname = options.hostname;
      portNum = options.port || (protocol === 'https' ? 443 : 80);
      reqPath = options.pathname + options.search;
    } else {
      method = options.method || 'GET';
      hostname = options.hostname || options.host || 'unknown';
      portNum = options.port || (protocol === 'https' ? 443 : 80);
      reqPath = options.path || '/';
    }

    const entry = {
      method,
      host: hostname,
      port: portNum,
      path: reqPath,
      protocol
    };

    // If request headers are available
    if (options.headers) {
      entry.requestHeaders = safeHeaders(options.headers);
    }

    const req = originalRequest.call(mod, options, function (res) {
      const elapsed = Date.now() - startTime;
      entry.status = res.statusCode;
      entry.responseHeaders = safeHeaders(res.headers);
      entry.elapsed_ms = elapsed;

      // Capture response body for error responses
      if (res.statusCode >= 400) {
        const chunks = [];
        const origEmit = res.emit.bind(res);
        res.emit = function (event, ...args) {
          if (event === 'data') chunks.push(args[0]);
          if (event === 'end') {
            const body = Buffer.concat(chunks).toString('utf8').substring(0, 500);
            entry.responseBody = body;
            log('EGRESS', entry);
          }
          return origEmit(event, ...args);
        };
      } else {
        log('EGRESS', entry);
      }

      if (callback) callback(res);
    });

    req.on('error', (err) => {
      entry.error = err.message;
      entry.elapsed_ms = Date.now() - startTime;
      log('EGRESS', entry);
    });

    return req;
  };

  // Also patch .get() since it delegates to .request()
  mod.get = function patchedGet(options, callback) {
    const req = mod.request(options, callback);
    req.end();
    return req;
  };
}

patchModule(http, 'http');
patchModule(https, 'https');

// ── Patch inbound requests (INGRESS) ─────────────────────────
// Hooks into Express by patching http.createServer to wrap
// the request handler with timing + logging.

const originalCreateServer = http.createServer;

http.createServer = function patchedCreateServer(requestListener) {
  const wrappedListener = function (req, res) {
    const startTime = Date.now();

    // Log when response finishes
    res.on('finish', () => {
      const elapsed = Date.now() - startTime;
      log('INGRESS', {
        method: req.method,
        url: req.url,
        status: res.statusCode,
        elapsed_ms: elapsed,
        userAgent: (req.headers['user-agent'] || '').substring(0, 80),
        origin: req.headers['origin'] || req.headers['referer'] || 'direct'
      });
    });

    if (requestListener) requestListener(req, res);
  };

  return originalCreateServer.call(http, wrappedListener);
};

// ── Startup notice ───────────────────────────────────────────

console.log('\x1b[32m[TRAFFIC MONITOR] Active — logging to console + data/traffic.log\x1b[0m');
console.log('\x1b[32m[TRAFFIC MONITOR] EGRESS = outbound (yellow) | INGRESS = inbound (cyan)\x1b[0m');
