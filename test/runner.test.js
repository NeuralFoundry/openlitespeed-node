'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const RUNNER = path.join(__dirname, '..', 'lsnode.js');
const CLI = path.join(__dirname, '..', 'bin', 'ols-node.js');
const dirs = [];
const children = [];

after(() => {
    for (const c of children)
        if (c.exitCode === null)
            c.kill();
    for (const d of dirs)
        fs.rmSync(d, { recursive: true, force: true });
});

function app(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsnode-'));
    dirs.push(dir);
    for (const [f, c] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), typeof c === 'string' ? c : JSON.stringify(c));
    }
    return dir;
}

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

function request(port, p, opts = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method: opts.method || 'GET', headers: opts.headers || {}, agent: opts.agent || false }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('timeout')));
        req.end(opts.body);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(dir, env = {}, wait = true) {
    const port = await freePort();
    const e = Object.assign({}, process.env, { LSNODE_ROOT: dir, OLS_APP_ADDRESS: '127.0.0.1:' + port }, env);
    delete e.LSNODE_PARENT;
    if (!env.LS_STDERR_LOG)
        delete e.LS_STDERR_LOG;
    delete e.PORT;
    const child = spawn(process.execPath, [RUNNER], { cwd: dir, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    child.stdout.on('data', (d) => out += d);
    child.stderr.on('data', (d) => out += d);
    const h = { child, port, get out() { return out; } };
    if (wait) {
        const until = Date.now() + 10000;
        for (;;) {
            try {
                await request(port, '/');
                break;
            } catch (err) {
                if (Date.now() > until || child.exitCode !== null)
                    throw new Error('app did not start: ' + out);
                await sleep(100);
            }
        }
    }
    return h;
}

function stop(h) {
    if (h.child.exitCode === null)
        h.child.kill();
}

test('CommonJS app listening on its own port is moved to the OpenLiteSpeed address', async () => {
    const dir = app({ 'app.js': "require('http').createServer((q, s) => s.end('cjs ' + q.url)).listen(3000);" });
    const h = await start(dir);
    assert.strictEqual((await request(h.port, '/a?b=1')).body, 'cjs /a?b=1');
    stop(h);
});

test('ES module selected by package.json type and scripts.start', async () => {
    const dir = app({
        'package.json': { type: 'module', scripts: { start: 'node server.js' } },
        'server.js': "import http from 'node:http'; http.createServer((q, s) => s.end('esm ' + import.meta.url.endsWith('server.js'))).listen(process.env.PORT);"
    });
    const h = await start(dir);
    assert.strictEqual((await request(h.port, '/')).body, 'esm true');
    stop(h);
});

test('.mjs start file and require.main guard', async () => {
    const a = app({ 'index.mjs': "import http from 'http'; http.createServer((q, s) => s.end('mjs')).listen(8080, '0.0.0.0');" });
    const h1 = await start(a);
    assert.strictEqual((await request(h1.port, '/')).body, 'mjs');
    stop(h1);
    const b = app({ 'server.js': "const http = require('http'); const app = (q, s) => s.end('main ' + (require.main === module)); if (require.main === module) http.createServer(app).listen(3000); module.exports = app;" });
    const h2 = await start(b);
    assert.strictEqual((await request(h2.port, '/')).body, 'main true');
    stop(h2);
});

test('exported app objects, handlers and fetch handlers are served', async () => {
    const listenObj = app({ 'app.js': "const http = require('http'); module.exports = { listen(...a) { return http.createServer((q, s) => s.end('listen obj')).listen(...a); } };" });
    const h1 = await start(listenObj);
    assert.strictEqual((await request(h1.port, '/')).body, 'listen obj');
    stop(h1);
    const handler = app({ 'app.js': "module.exports = (req, res) => res.end('handler ' + req.method);" });
    const h2 = await start(handler);
    assert.strictEqual((await request(h2.port, '/', { method: 'DELETE' })).body, 'handler DELETE');
    stop(h2);
    const fetchApp = app({
        'app.mjs': `export default {
  async fetch(req) {
    const u = new URL(req.url);
    const body = req.method === 'POST' ? await req.text() : '';
    const h = new Headers({ 'content-type': 'application/json' });
    h.append('set-cookie', 'a=1');
    h.append('set-cookie', 'b=2');
    if (u.pathname === '/stream') {
      const s = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('one,')); setTimeout(() => { c.enqueue(new TextEncoder().encode('two')); c.close(); }, 50); } });
      return new Response(s, { status: 201 });
    }
    return new Response(JSON.stringify({ m: req.method, p: u.pathname, q: u.searchParams.get('q'), body, x: req.headers.get('x-test'), proto: u.protocol }), { status: 200, headers: h });
  }
};`
    });
    const h3 = await start(fetchApp, { LSNODE_STARTUP_FILE: 'app.mjs' });
    const r = await request(h3.port, '/p?q=7', { method: 'POST', body: 'hello', headers: { 'x-test': 'yes', 'x-forwarded-proto': 'https' } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { m: 'POST', p: '/p', q: '7', body: 'hello', x: 'yes', proto: 'https:' });
    assert.deepStrictEqual(r.headers['set-cookie'], ['a=1', 'b=2']);
    const s = await request(h3.port, '/stream');
    assert.strictEqual(s.status, 201);
    assert.strictEqual(s.body, 'one,two');
    stop(h3);
});

test('a late listen takes over from the automatic one', async () => {
    const dir = app({ 'app.js': "const http = require('http'); const app = (q, s) => s.end('auto'); setTimeout(() => http.createServer((q, s) => s.end('own')).listen(3000), 2500); module.exports = app;" });
    const h = await start(dir);
    assert.strictEqual((await request(h.port, '/')).body, 'auto');
    await sleep(2500);
    assert.strictEqual((await request(h.port, '/')).body, 'own');
    stop(h);
});

test('later servers keep their own ports', async () => {
    const dir = app({
        'app.js': "const http = require('http'); const side = http.createServer((q, s) => s.end('side')); side.listen(0, '127.0.0.1', () => { http.createServer((q, s) => s.end(String(side.address().port))).listen(3000); });"
    });
    const h = await start(dir);
    await sleep(200);
    const sidePort = Number((await request(h.port, '/')).body);
    assert.ok(sidePort > 0 && sidePort !== h.port);
    assert.strictEqual((await request(sidePort, '/')).body, 'side');
    stop(h);
});

test('client address and scheme come from the proxy headers', async () => {
    const dir = app({ 'app.js': "require('http').createServer((q, s) => s.end(q.socket.remoteAddress + ' ' + (q.socket.encrypted === true))).listen(3000);" });
    const h = await start(dir);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const a = await request(h.port, '/', { agent, headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.7', 'x-forwarded-proto': 'https' } });
    assert.strictEqual(a.body, '203.0.113.7 true');
    const b = await request(h.port, '/', { agent });
    assert.strictEqual(b.body, '127.0.0.1 false');
    agent.destroy();
    stop(h);
    const off = await start(dir, { LSNODE_REAL_IP: '0' });
    assert.strictEqual((await request(off.port, '/', { headers: { 'x-forwarded-for': '203.0.113.7' } })).body, '127.0.0.1 false');
    stop(off);
});

test('start script with env, env file, preload and arguments', async () => {
    const dir = app({
        'package.json': { scripts: { start: 'cross-env FOO=bar node --env-file=.env -r ./pre.js server.js one two' } },
        '.env': 'FROM_FILE=yes\n',
        'pre.js': 'global.PRE = 1;',
        'server.js': "require('http').createServer((q, s) => s.end([process.env.FOO, process.env.FROM_FILE, global.PRE, process.argv.slice(2).join('+')].join(' '))).listen(3000);"
    });
    const h = await start(dir);
    assert.strictEqual((await request(h.port, '/')).body, 'bar yes 1 one+two');
    stop(h);
});

test('start script that runs a package binary', async () => {
    const dir = app({
        'package.json': { scripts: { start: 'fake-serve --name=x' } },
        'node_modules/fake-serve/package.json': { name: 'fake-serve', bin: { 'fake-serve': 'cli.js' } },
        'node_modules/fake-serve/cli.js': "require('http').createServer((q, s) => s.end('bin ' + process.argv.slice(2).join(' '))).listen(5000);",
        'node_modules/.bin/fake-serve': '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/../fake-serve/cli.js" "$@"\nelse\n  exec node  "$basedir/../fake-serve/cli.js" "$@"\nfi\n'
    });
    const h = await start(dir);
    assert.strictEqual((await request(h.port, '/')).body, 'bin --name=x');
    stop(h);
});

test('TypeScript start file', { skip: !(process.features && process.features.typescript) }, async () => {
    const dir = app({ 'server.ts': "import http from 'node:http';\nconst msg: string = 'ts';\nhttp.createServer((q, s) => s.end(msg)).listen(3000);\n" });
    const h = await start(dir);
    assert.strictEqual((await request(h.port, '/')).body, 'ts');
    stop(h);
});

test('cluster workers share the OpenLiteSpeed address', async () => {
    const dir = app({ 'app.js': "const cluster = require('cluster'); if (cluster.isPrimary) { cluster.fork(); cluster.fork(); } else { require('http').createServer((q, s) => s.end('worker ' + process.pid)).listen(3000); }" });
    const h = await start(dir);
    const r = await request(h.port, '/');
    assert.match(r.body, /^worker \d+$/);
    assert.notStrictEqual(r.body, 'worker ' + h.child.pid);
    stop(h);
});

test('worker threads still start', async () => {
    const dir = app({ 'app.js': "const { Worker } = require('worker_threads'); const w = new Worker('require(\"worker_threads\").parentPort.postMessage(21 * 2)', { eval: true }); w.on('message', (n) => require('http').createServer((q, s) => s.end('thread ' + n)).listen(3000)); w.on('error', (e) => { console.error(e); process.exit(1); });" });
    const h = await start(dir);
    assert.strictEqual((await request(h.port, '/')).body, 'thread 42');
    stop(h);
});

test('forked children exit when the app process is gone', async () => {
    const dir = app({
        'app.js': "const { fork } = require('child_process'); const c = fork(__dirname + '/child.js'); require('http').createServer((q, s) => s.end(String(c.pid))).listen(3000);",
        'child.js': 'setInterval(() => {}, 1000);'
    });
    const h = await start(dir);
    const pid = Number((await request(h.port, '/')).body);
    assert.ok(pid > 0);
    h.child.kill('SIGKILL');
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
        await sleep(250);
        try {
            process.kill(pid, 0);
        } catch (e) {
            alive = false;
        }
    }
    assert.strictEqual(alive, false);
});

test('console output and crashes go to the log file', async () => {
    const dir = app({ 'app.js': "console.log('hello-out'); console.error('hello-err'); require('http').createServer((q, s) => { s.end('ok'); if (q.url === '/crash') setTimeout(() => { throw new Error('boom'); }, 10); }).listen(3000);" });
    const log = path.join(dir, 'log', 'stderr.log');
    const h = await start(dir, { LS_STDERR_LOG: log });
    await request(h.port, '/crash');
    for (let i = 0; i < 40 && h.child.exitCode === null; i++)
        await sleep(100);
    const text = fs.readFileSync(log, 'utf8');
    assert.match(text, /hello-out/);
    assert.match(text, /hello-err/);
    assert.match(text, /Error: boom/);
    assert.notStrictEqual(h.child.exitCode, 0);
});

test('missing start file is reported', async () => {
    const dir = app({ 'readme.txt': 'x' });
    const h = await start(dir, {}, false);
    await new Promise((r) => h.child.on('exit', r));
    assert.strictEqual(h.child.exitCode, 1);
    assert.match(h.out, /No start file found/);
});

test('ols-node doctor and add', () => {
    const dir = app({ 'package.json': { scripts: { start: 'node server.js' } }, 'server.js': '' });
    const d = spawnSync(process.execPath, [CLI, 'doctor', dir], { encoding: 'utf8' });
    assert.strictEqual(d.status, 0, d.stdout + d.stderr);
    assert.match(d.stdout, /Start\s+server\.js \(scripts\.start: node server\.js\)/);
    const srv = app({
        'conf/httpd_config.conf': 'serverName x\nvirtualhost Example {\n  vhRoot                  $SERVER_ROOT/Example/\n  configFile              $SERVER_ROOT/conf/vhosts/$VH_NAME/vhconf.conf\n}\nvirtualhost Other {\n  vhRoot                  $SERVER_ROOT/Other/\n  configFile              $VH_ROOT/vhconf.conf\n}\n',
        'conf/vhosts/Example/vhconf.conf': 'docRoot $VH_ROOT/html/\ncontext /old/ {\n  type null\n}\n',
        'Other/vhconf.conf': 'docRoot $VH_ROOT/html/\n'
    });
    const run = (...a) => spawnSync(process.execPath, [CLI, 'add', dir, '--server', srv, ...a], { encoding: 'utf8' });
    assert.match(run().stderr, /pass --vhost/);
    const ok = run('--vhost', 'example', '--uri', 'api');
    assert.strictEqual(ok.status, 0, ok.stderr);
    const conf = fs.readFileSync(path.join(srv, 'conf/vhosts/Example/vhconf.conf'), 'utf8');
    assert.match(conf, /context \/api\/ \{\n  type\s+appserver\n  location\s+\S+\/\n  appType\s+node\n  startupFile\s+server\.js\n  appserverEnv\s+1\n/);
    assert.match(run('--vhost', 'Example', '--uri', '/api/').stderr, /already has a context/);
    assert.strictEqual(run('--vhost', 'Example', '--uri', '/api/', '--force', '--env', 'development').status, 0);
    const again = fs.readFileSync(path.join(srv, 'conf/vhosts/Example/vhconf.conf'), 'utf8');
    assert.strictEqual(again.match(/context \/api\//g).length, 1);
    assert.match(again, /appserverEnv\s+0/);
    assert.match(again, /context \/old\//);
    assert.strictEqual(run('--vhost', 'Other').status, 0);
    assert.match(fs.readFileSync(path.join(srv, 'Other/vhconf.conf'), 'utf8'), /context \/ \{/);
});
