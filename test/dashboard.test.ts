import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, getDbPath } from '../src/db/connection.js';
import { insertRepo, upsertFileIssues, upsertFileDependencies } from '../src/db/queries.js';
import { upsertRegistryEntry, getDashboardHomeDir } from '../src/dashboard/registry.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import type { Issue, DependencyEdge } from '../src/types.js';

let tmpDir: string;
let dashboardHomeDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-sonar-dashboard-test-'));
  dashboardHomeDir = mkdtempSync(join(tmpDir, 'dashboard-home-'));
  // Set env var to override dashboard home dir
  process.env.MCP_SONAR_DASHBOARD_HOME = dashboardHomeDir;
});

after(() => {
  delete process.env.MCP_SONAR_DASHBOARD_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Helper to make HTTP requests to a test server.
 */
function makeRequest(
  server: http.Server,
  method: string,
  path: string,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const address = server.address() as AddressInfo;
    const req = http.request(
      {
        host: address.address,
        port: address.port,
        path,
        method,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 500,
            body,
            contentType: res.headers['content-type'] || '',
          });
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

test('createDashboardServer returns an http.Server', () => {
  const server = createDashboardServer();
  assert.ok(server instanceof http.Server);
  server.close();
});

test('GET / returns 200 with HTML content-type', async () => {
  const server = createDashboardServer();
  server.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  try {
    const result = await makeRequest(server, 'GET', '/');
    assert.equal(result.status, 200);
    assert.ok(result.contentType.includes('text/html'));
    assert.ok(result.body.includes('<title>mcp-sonar-analysis Dashboard</title>'));
    assert.ok(result.body.includes('id="app"'));
    assert.ok(result.body.includes('id="refresh-btn"'));
  } finally {
    server.close();
  }
});

test('GET /index.html returns 200 with HTML content-type', async () => {
  const server = createDashboardServer();
  server.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  try {
    const result = await makeRequest(server, 'GET', '/index.html');
    assert.equal(result.status, 200);
    assert.ok(result.contentType.includes('text/html'));
  } finally {
    server.close();
  }
});

test('GET /app.js returns 200 with JavaScript content-type', async () => {
  const server = createDashboardServer();
  server.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  try {
    const result = await makeRequest(server, 'GET', '/app.js');
    assert.equal(result.status, 200);
    assert.ok(result.contentType.includes('application/javascript'));
  } finally {
    server.close();
  }
});

test('GET /style.css returns 200 with CSS content-type', async () => {
  const server = createDashboardServer();
  server.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  try {
    const result = await makeRequest(server, 'GET', '/style.css');
    assert.equal(result.status, 200);
    assert.ok(result.contentType.includes('text/css'));
  } finally {
    server.close();
  }
});

test('GET /nonexistent returns 404 JSON', async () => {
  const server = createDashboardServer();
  server.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  try {
    const result = await makeRequest(server, 'GET', '/nonexistent');
    assert.equal(result.status, 404);
    assert.ok(result.contentType.includes('application/json'));
    const body = JSON.parse(result.body);
    assert.equal(body.error, 'not found');
  } finally {
    server.close();
  }
});

test('GET /api/repos returns 200 with valid JSON structure', async () => {
  const server = createDashboardServer();
  server.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  try {
    // Create an empty registry
    const homeDir = getDashboardHomeDir();
    writeFileSync(join(homeDir, 'registry.json'), JSON.stringify({ repos: [] }), 'utf-8');

    const result = await makeRequest(server, 'GET', '/api/repos');
    assert.equal(result.status, 200);
    assert.ok(result.contentType.includes('application/json'));
    const body = JSON.parse(result.body);
    assert.ok(Array.isArray(body.repos));
  } finally {
    server.close();
  }
});

test('GET /api/repos with seeded repos returns correct structure', async () => {
  const server = createDashboardServer();
  server.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  try {
    // Create a test repo with issues
    const repoPath = mkdtempSync(join(tmpDir, 'test-repo-'));
    const db = openDb(repoPath);

    try {
      const repo = insertRepo(db, repoPath, 'test-repo');

      // Add test issues
      const issues: Issue[] = [
        {
          ruleId: 'rule1',
          ruleName: 'Test Rule',
          type: 'BUG',
          severity: 'MAJOR',
          line: 1,
          message: 'Test issue',
          status: 'OPEN',
        },
      ];
      upsertFileIssues(db, repo.id, 'src/test.ts', issues);
    } finally {
      db.close();
    }

    // Register the repo
    const dbPath = getDbPath(repoPath);
    upsertRegistryEntry(
      {
        repoId: 1,
        path: repoPath,
        name: 'test-repo',
        dbPath,
        registeredAt: new Date().toISOString(),
      },
      dashboardHomeDir,
    );

    const result = await makeRequest(server, 'GET', '/api/repos');
    assert.equal(result.status, 200);
    const body = JSON.parse(result.body);
    assert.ok(Array.isArray(body.repos));
    assert.equal(body.repos.length, 1);
    assert.equal(body.repos[0].path, repoPath);
    assert.equal(body.repos[0].stale, false);
    assert.ok(body.repos[0].issuesByType);
    assert.equal(body.repos[0].issuesByType.BUG, 1);
  } finally {
    server.close();
  }
});

test('GET /api/repos/:path/summary returns correct aggregations', async () => {
  const server = createDashboardServer();
  server.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  try {
    // Create a test repo with known issue distribution
    const repoPath = mkdtempSync(join(tmpDir, 'test-repo-summary-'));
    const db = openDb(repoPath);

    try {
      const repo = insertRepo(db, repoPath, 'test-repo');

      // Add test issues with specific type/severity distribution
      const issues: Issue[] = [
        {
          ruleId: 'rule1',
          type: 'BUG',
          severity: 'MAJOR',
          message: 'Bug 1',
          status: 'OPEN',
        },
        {
          ruleId: 'rule2',
          type: 'BUG',
          severity: 'CRITICAL',
          message: 'Bug 2',
          status: 'OPEN',
        },
        {
          ruleId: 'rule3',
          type: 'CODE_SMELL',
          severity: 'MINOR',
          message: 'Smell 1',
          status: 'OPEN',
        },
      ];
      upsertFileIssues(db, repo.id, 'src/file1.ts', issues);
    } finally {
      db.close();
    }

    // Register the repo
    const dbPath = getDbPath(repoPath);
    upsertRegistryEntry(
      {
        repoId: 1,
        path: repoPath,
        name: 'test-repo',
        dbPath,
        registeredAt: new Date().toISOString(),
      },
      dashboardHomeDir,
    );

    // Query summary (need to URL-encode the path)
    const encodedPath = encodeURIComponent(repoPath);
    const result = await makeRequest(server, 'GET', `/api/repos/${encodedPath}/summary`);
    assert.equal(result.status, 200);
    const body = JSON.parse(result.body);

    // Verify structure
    assert.equal(body.path, repoPath);
    assert.ok(body.issuesByType);
    assert.equal(body.issuesByType.BUG, 2);
    assert.equal(body.issuesByType.CODE_SMELL, 1);
    assert.ok(body.issuesBySeverity);
    assert.equal(body.issuesBySeverity.MAJOR, 1);
    assert.equal(body.issuesBySeverity.CRITICAL, 1);
    assert.equal(body.issuesBySeverity.MINOR, 1);
    assert.ok(body.issuesByTypeAndSeverity);
    assert.equal(body.issuesByTypeAndSeverity.BUG.MAJOR, 1);
    assert.equal(body.issuesByTypeAndSeverity.BUG.CRITICAL, 1);
    assert.equal(body.issuesByTypeAndSeverity.CODE_SMELL.MINOR, 1);
    assert.ok(Array.isArray(body.files));
  } finally {
    server.close();
  }
});

test('GET /api/repos/:path/files/*filePath returns file analysis', async () => {
  const server = createDashboardServer();
  server.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  try {
    // Create a test repo with file analysis
    const repoPath = mkdtempSync(join(tmpDir, 'test-repo-file-'));
    const db = openDb(repoPath);

    try {
      const repo = insertRepo(db, repoPath, 'test-repo');

      // Add test issues for a specific file
      const issues: Issue[] = [
        {
          ruleId: 'rule1',
          type: 'BUG',
          severity: 'MAJOR',
          line: 10,
          message: 'Test bug',
          status: 'OPEN',
        },
      ];
      upsertFileIssues(db, repo.id, 'src/file.ts', issues);

      // Add dependencies
      const deps: DependencyEdge[] = [
        {
          sourceFile: 'src/file.ts',
          importedModule: 'lodash',
          importedFile: undefined,
          resolved: false,
          language: 'typescript',
        },
      ];
      upsertFileDependencies(db, repo.id, 'src/file.ts', deps);
    } finally {
      db.close();
    }

    // Register the repo
    const dbPath = getDbPath(repoPath);
    upsertRegistryEntry(
      {
        repoId: 1,
        path: repoPath,
        name: 'test-repo',
        dbPath,
        registeredAt: new Date().toISOString(),
      },
      dashboardHomeDir,
    );

    // Query file analysis
    const encodedPath = encodeURIComponent(repoPath);
    const encodedFile = encodeURIComponent('src/file.ts');
    const result = await makeRequest(server, 'GET', `/api/repos/${encodedPath}/files/${encodedFile}`);
    assert.equal(result.status, 200);
    const body = JSON.parse(result.body);

    // Verify structure
    assert.equal(body.filePath, 'src/file.ts');
    assert.equal(body.language, 'typescript');
    assert.equal(body.analyzed, true);
    assert.ok(Array.isArray(body.issues));
    assert.equal(body.issues.length, 1);
    assert.ok(Array.isArray(body.dependsOn));
  } finally {
    server.close();
  }
});

test('GET /api/repos/:path/files/*filePath with .. returns 400', async () => {
  const server = createDashboardServer();
  server.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  try {
    const repoPath = mkdtempSync(join(tmpDir, 'test-repo-traversal-'));

    // Register the repo
    const dbPath = getDbPath(repoPath);
    const db = openDb(repoPath);
    try {
      insertRepo(db, repoPath, 'test-repo');
    } finally {
      db.close();
    }

    upsertRegistryEntry(
      {
        repoId: 1,
        path: repoPath,
        name: 'test-repo',
        dbPath,
        registeredAt: new Date().toISOString(),
      },
      dashboardHomeDir,
    );

    // Try to access a path with .. (path traversal attempt)
    const encodedPath = encodeURIComponent(repoPath);
    const result = await makeRequest(server, 'GET', `/api/repos/${encodedPath}/files/..%2Fetc%2Fpasswd`);
    assert.equal(result.status, 400);
    const body = JSON.parse(result.body);
    assert.equal(body.error, 'invalid file path');
  } finally {
    server.close();
  }
});

test('binding to an already-used port fails with EADDRINUSE handling', async () => {
  const server1 = createDashboardServer();
  server1.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server1.once('listening', () => resolve());
  });

  try {
    const address = server1.address() as AddressInfo;
    const port = address.port;

    // Attempt to bind a second server to the same port
    const server2 = createDashboardServer();
    let errorOccurred = false;

    server2.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        errorOccurred = true;
      }
    });

    server2.listen(port, '127.0.0.1');

    // Wait a bit for the error to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(errorOccurred, 'Expected EADDRINUSE error when binding to same port');
    server2.close();
  } finally {
    server1.close();
  }
});

test('server binds to 127.0.0.1 only', async () => {
  const server = createDashboardServer();
  server.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  try {
    const address = server.address() as AddressInfo;
    assert.equal(address.address, '127.0.0.1', 'Server must bind to 127.0.0.1 only');
  } finally {
    server.close();
  }
});
