/**
 * HTTP server for the dashboard.
 * Serves static files from public/, routes /api/* to handlers, and binds to 127.0.0.1 only.
 * See PRD-dashboard.md §6.6 for contract and port binding behavior.
 */

import * as http from 'node:http';
import { URL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { handleListRepos, handleRepoSummary, handleFileAnalysis, handleRepoDependencies, handleDeleteRepo } from './api.js';

/**
 * Creates an HTTP server with request handler.
 * Routes /api/* to api.ts handlers, serves static files from public/ for other paths.
 */
export function createDashboardServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      // API routes: /api/repos/:path/summary or /api/repos/:path/files/*filePath
      if (pathname.startsWith('/api/repos/')) {
        const afterRepos = pathname.slice('/api/repos/'.length);
        const parts = afterRepos.split('/');
        const decodedPath = decodeURIComponent(parts[0]);

        if (parts[1] === 'summary' && parts.length === 2) {
          await handleRepoSummary(req, res, decodedPath);
        } else if (parts[1] === 'dependencies' && parts.length === 2) {
          await handleRepoDependencies(req, res, decodedPath);
        } else if (parts[1] === 'files' && parts.length >= 3) {
          const filePath = decodeURIComponent(parts.slice(2).join('/'));
          await handleFileAnalysis(req, res, decodedPath, filePath);
        } else if (req.method === 'DELETE' && parts.length === 1) {
          await handleDeleteRepo(req, res, decodedPath);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        }
      } else if (pathname === '/api/repos') {
        // GET /api/repos
        await handleListRepos(req, res);
      } else if (pathname === '/' || pathname === '/index.html') {
        // Serve index.html
        serveStaticFile(res, 'index.html', 'text/html');
      } else if (pathname === '/app.js') {
        // Serve app.js
        serveStaticFile(res, 'app.js', 'application/javascript');
      } else if (pathname === '/style.css') {
        // Serve style.css
        serveStaticFile(res, 'style.css', 'text/css');
      } else {
        // 404 for anything else
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    } catch (error) {
      console.error('Dashboard request error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal server error' }));
    }
  });

  return server;
}

/**
 * Serve a static file from the public/ directory.
 * Resolves relative to this module's location for compatibility with both dev (tsx src/cli.ts)
 * and prod (node dist/cli.js after tsc + cp).
 */
function serveStaticFile(res: http.ServerResponse, filename: string, contentType: string): void {
  try {
    const publicDir = new URL('./public', import.meta.url).pathname;
    const filePath = join(publicDir, filename);

    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const content = readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (error) {
    console.error(`Failed to serve ${filename}:`, error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal server error' }));
  }
}

/**
 * Start the dashboard server on the given port (127.0.0.1 only).
 * On success, logs "Dashboard running at http://127.0.0.1:<port>".
 * On EADDRINUSE, logs an error message and exits with code 1.
 */
export function startDashboardServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createDashboardServer();

    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${port} already in use. Try --port <different-port>.`);
        process.exit(1);
      } else {
        reject(error);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`Dashboard running at http://127.0.0.1:${port}`);
      resolve();
    });

    // Keep the server running (don't resolve until Ctrl+C)
    // This is blocking by design - the server runs in the foreground
  });
}
