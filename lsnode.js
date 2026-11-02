'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const Module = require('module');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { once } = require('events');

const VERSION = '1.0.0';
const GRACE_MS = 1000;
const RETRIES = 25;

const CANDIDATES = [
    'app.js', 'server.js', 'index.js', 'main.js',
    'app.mjs', 'server.mjs', 'index.mjs', 'main.mjs',
    'app.cjs', 'server.cjs', 'index.cjs',
    'app.ts', 'server.ts', 'index.ts', 'main.ts',
    'src/server.js', 'src/app.js', 'src/index.js', 'src/main.js',
    'src/server.ts', 'src/app.ts', 'src/index.ts', 'src/main.ts',
    'dist/server.js', 'dist/index.js', 'dist/main.js',
    'build/index.js', 'build/server.js', '.output/server/index.mjs'
];

function isFile(f) {
    try {
        return fs.statSync(f).isFile();
    } catch (e) {
        return false;
    }
}

function isDir(f) {
    try {
        return fs.statSync(f).isDirectory();
    } catch (e) {
        return false;
    }
}

function readJson(f) {
    try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
        return null;
    }
}

function resolveFrom(root, id) {
    try {
        return require.resolve(id, { paths: [root] });
    } catch (e) {
        return null;
    }
}

function tryFile(f) {
    if (isFile(f))
        return f;
    for (const ext of ['.js', '.mjs', '.cjs', '.ts'])
        if (isFile(f + ext))
            return f + ext;
    if (isDir(f)) {
        const pkg = readJson(path.join(f, 'package.json'));
        if (pkg && typeof pkg.main === 'string') {
            const m = tryFile(path.resolve(f, pkg.main));
            if (m)
                return m;
        }
        for (const n of ['index.js', 'index.mjs', 'index.cjs', 'index.ts'])
            if (isFile(path.join(f, n)))
                return path.join(f, n);
    }
    return null;
}

function shellSplit(s) {
    const out = [];
    let cur = '';
    let quote = null;
    let has = false;
    for (const c of s) {
        if (quote) {
            if (c === quote)
                quote = null;
            else
                cur += c;
        } else if (c === '"' || c === "'") {
            quote = c;
            has = true;
        } else if (/\s/.test(c)) {
            if (has || cur) {
                out.push(cur);
                cur = '';
                has = false;
            }
        } else {
            cur += c;
        }
    }
    if (has || cur)
        out.push(cur);
    return out;
}

function resolveBin(root, name) {
    const dir = path.join(root, 'node_modules', '.bin');
    const shim = path.join(dir, name);
    try {
        const real = fs.realpathSync(shim);
        if (path.resolve(real) !== path.resolve(shim))
            return real;
    } catch (e) {
    }
    for (const [file, re] of [[shim, /"\$basedir\/([^"]+)"/g], [shim + '.cmd', /"%dp0%\\([^"]+)"/g]]) {
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (e) {
            continue;
        }
        let last = null;
        for (const m of text.matchAll(re))
            if (!/^node(\.exe)?$/i.test(m[1]))
                last = m[1];
        if (last && isFile(path.resolve(dir, last)))
            return path.resolve(dir, last);
    }
    const pkgFile = resolveFrom(root, name + '/package.json');
    const pkg = pkgFile && readJson(pkgFile);
    if (pkg && pkg.bin) {
        const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[name];
        if (rel && isFile(path.resolve(path.dirname(pkgFile), rel)))
            return path.resolve(path.dirname(pkgFile), rel);
    }
    return null;
}

function setFile(r, file, args, source) {
    r.file = file;
    r.args = args || [];
    r.source = source;
    return true;
}

function fromScript(r, root, script) {
    const seg = script.split(/&&|\|\||;/).map((s) => s.trim()).filter(Boolean).pop();
    if (!seg)
        return false;
    const t = shellSplit(seg);
    const env = {};
    const takeEnv = () => {
        while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) {
            const a = t.shift();
            const i = a.indexOf('=');
            env[a.slice(0, i)] = a.slice(i + 1);
        }
    };
    takeEnv();
    if (t[0] === 'cross-env' || t[0] === 'env') {
        t.shift();
        takeEnv();
    }
    if (t[0] === 'npx') {
        t.shift();
        while (t.length && t[0].startsWith('-'))
            t.shift();
    }
    const cmd = t.shift();
    if (!cmd)
        return false;
    const source = 'scripts.start: ' + script;
    const base = path.basename(cmd).replace(/\.(exe|cmd)$/i, '');
    if (base === 'node' || base === 'nodemon' || base === 'tsx' || base === 'ts-node' || base === 'ts-node-esm') {
        while (t.length && t[0].startsWith('-')) {
            const f = t.shift();
            const eq = f.indexOf('=');
            const k = eq > 0 ? f.slice(0, eq) : f;
            let v = eq > 0 ? f.slice(eq + 1) : undefined;
            const takesValue = ['-r', '--require', '--import', '--env-file', '--env-file-if-exists'];
            if (takesValue.includes(k) && v === undefined)
                v = t.shift();
            if (k === '-r' || k === '--require')
                r.preload.push(v);
            else if (k === '--import')
                r.imports.push(v);
            else if (k === '--env-file')
                r.envFiles.push({ file: v, optional: false });
            else if (k === '--env-file-if-exists')
                r.envFiles.push({ file: v, optional: true });
            else if (base === 'node')
                r.warnings.push('Node option ' + f + ' from the start script is not applied, put it in NODE_OPTIONS');
        }
        const target = t.shift();
        const file = target && tryFile(path.resolve(root, target));
        if (!file)
            return false;
        Object.assign(r.env, env);
        return setFile(r, file, t, source);
    }
    if (base === 'next' && (t[0] === 'start' || t.length === 0)) {
        Object.assign(r.env, env);
        r.preset = 'next';
        r.source = source;
        return true;
    }
    if ((base === 'nuxt' || base === 'nuxi') && (t[0] === 'start' || t[0] === 'preview')) {
        const file = tryFile(path.join(root, '.output', 'server', 'index.mjs'));
        if (!file)
            return false;
        Object.assign(r.env, env);
        return setFile(r, file, [], source);
    }
    if (base === 'nest' && t[0] === 'start') {
        const file = tryFile(path.join(root, 'dist', 'main'));
        if (!file)
            return false;
        Object.assign(r.env, env);
        return setFile(r, file, [], source);
    }
    const bin = resolveBin(root, cmd);
    if (!bin)
        return false;
    Object.assign(r.env, env);
    return setFile(r, bin, t, source);
}

function detect(root, startup) {
    root = path.resolve(root || '.');
    const r = {
        root, file: null, args: [], preset: null, source: '',
        env: {}, envFiles: [], preload: [], imports: [], warnings: [], typescript: null
    };
    const pkg = readJson(path.join(root, 'package.json')) || {};
    const deps = Object.assign({}, pkg.devDependencies, pkg.dependencies);
    if (startup) {
        const f = tryFile(path.resolve(root, startup));
        if (f)
            setFile(r, f, [], 'startup file ' + startup);
    }
    if (!r.file && pkg.scripts && typeof pkg.scripts.start === 'string')
        fromScript(r, root, pkg.scripts.start);
    if (!r.file && !r.preset && deps.next) {
        const standalone = path.join(root, '.next', 'standalone', 'server.js');
        if (!resolveFrom(root, 'next') && isFile(standalone))
            setFile(r, standalone, [], 'Next.js standalone build');
        else {
            r.preset = 'next';
            r.source = 'Next.js dependency';
        }
    }
    if (!r.file && !r.preset && typeof pkg.main === 'string') {
        const f = tryFile(path.resolve(root, pkg.main));
        if (f)
            setFile(r, f, [], 'package.json main');
    }
    if (!r.file && !r.preset)
        for (const c of CANDIDATES) {
            const f = path.join(root, c);
            if (isFile(f)) {
                setFile(r, f, [], 'found ' + c);
                break;
            }
        }
    if (r.preset === 'next') {
        if (!resolveFrom(root, 'next'))
            r.warnings.push('next is not installed, run npm install');
        if (!isDir(path.join(root, '.next')))
            r.warnings.push('No .next build found, run next build first');
    }
    if (r.file && /\.[cm]?ts$/.test(r.file)) {
        if (resolveFrom(root, 'tsx/esm/api'))
            r.typescript = 'tsx';
        else if (process.features && process.features.typescript)
            r.typescript = 'node';
        else
            r.warnings.push('TypeScript needs tsx in the project (npm i tsx) or Node.js 22.18 or later');
    }
    if (Object.keys(pkg.dependencies || {}).length && !isDir(path.join(root, 'node_modules')))
        r.warnings.push('node_modules is missing, run npm install');
    return r;
}

function parseAddress(s) {
    const m = /^(?:tcp:\/\/)?(\[[^\]]+\]|[^:]+):(\d+)$/.exec(s || '');
    if (!m)
        return null;
    return { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) };
}

function lastValue(v) {
    if (Array.isArray(v))
        v = v[v.length - 1];
    if (typeof v !== 'string')
        return '';
    return v.slice(v.lastIndexOf(',') + 1).trim();
}

function realClient(req) {
    const s = req.socket;
    if (!(s instanceof net.Socket) || typeof s.getPeerCertificate === 'function')
        return;
    try {
        const ip = lastValue(req.headers['x-forwarded-for']);
        if (net.isIP(ip)) {
            Object.defineProperty(s, 'remoteAddress', { value: ip, configurable: true, writable: true });
            Object.defineProperty(s, 'remoteFamily', { value: net.isIPv6(ip) ? 'IPv6' : 'IPv4', configurable: true, writable: true });
        } else {
            delete s.remoteAddress;
            delete s.remoteFamily;
        }
        if (lastValue(req.headers['x-forwarded-proto']) === 'https')
            s.encrypted = true;
        else
            delete s.encrypted;
    } catch (e) {
    }
}

function eligible(args) {
    const a = args[0];
    if (a === undefined || a === null || typeof a === 'function')
        return true;
    if (typeof a === 'number')
        return a !== 0;
    if (typeof a === 'string')
        return /^\d+$/.test(a) && Number(a) !== 0;
    if (typeof a === 'object') {
        if (a.path || a.fd !== undefined || a.handle || a._handle)
            return false;
        return a.port === undefined || a.port === null || Number(a.port) !== 0;
    }
    return false;
}

let owner = null;
let provisional = false;
let autoStart = false;

function patchListen(target) {
    const listen = net.Server.prototype.listen;
    const realIp = process.env.LSNODE_REAL_IP !== '0';
    const bind = (server, cb) => {
        let tries = 0;
        const emit = server.emit;
        server.emit = function (ev, err, ...rest) {
            if (ev === 'error' && err && err.code === 'EADDRINUSE' && tries < RETRIES) {
                tries++;
                setTimeout(() => listen.call(server, { host: target.host, port: target.port }), 200);
                return true;
            }
            if (ev === 'listening' || ev === 'error')
                server.emit = emit;
            return emit.call(this, ev, err, ...rest);
        };
        if (cb)
            server.once('listening', cb);
        if (realIp) {
            server.prependListener('request', realClient);
            server.prependListener('upgrade', realClient);
        }
        return listen.call(server, { host: target.host, port: target.port });
    };
    net.Server.prototype.listen = function (...args) {
        if (!eligible(args) || (owner && (!provisional || this === owner)))
            return listen.apply(this, args);
        const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        if (owner) {
            const old = owner;
            old.close();
            if (typeof old.closeAllConnections === 'function')
                old.closeAllConnections();
        }
        owner = this;
        provisional = autoStart;
        autoStart = false;
        return bind(this, cb);
    };
}

function fetchListener(handler) {
    return (req, res) => {
        const ac = new AbortController();
        res.on('close', () => {
            if (!res.writableFinished)
                ac.abort();
        });
        Promise.resolve().then(() => {
            const proto = lastValue(req.headers['x-forwarded-proto']) === 'https' ? 'https' : 'http';
            const headers = new Headers();
            for (let i = 0; i < req.rawHeaders.length; i += 2)
                if (req.rawHeaders[i][0] !== ':')
                    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
            const init = { method: req.method, headers, signal: ac.signal };
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                init.body = Readable.toWeb(req);
                init.duplex = 'half';
            }
            return handler(new Request(proto + '://' + (req.headers.host || 'localhost') + req.url, init));
        }).then(async (response) => {
            if (!response || typeof response.status !== 'number' || !response.headers)
                throw new Error('The fetch handler did not return a Response');
            const out = {};
            response.headers.forEach((v, k) => {
                if (k !== 'set-cookie')
                    out[k] = v;
            });
            const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
            if (cookies.length)
                out['set-cookie'] = cookies;
            res.writeHead(response.status, response.statusText || undefined, out);
            if (!response.body || req.method === 'HEAD')
                return res.end();
            for await (const chunk of response.body)
                if (!res.write(chunk))
                    await once(res, 'drain');
            res.end();
        }).catch((err) => {
            if (!ac.signal.aborted)
                console.error(err);
            if (!res.headersSent)
                res.writeHead(500, { 'content-type': 'text/plain' });
            res.end();
        });
    };
}

function servable(ns) {
    const seen = new Set();
    for (const c of [ns && ns.default, ns && ns.default && ns.default.default, ns]) {
        if (!c || seen.has(c))
            continue;
        seen.add(c);
        if (typeof c.listen === 'function' && !(c instanceof net.Server && c.listening))
            return (port) => c.listen({ port });
        if (typeof c.fetch === 'function')
            return (port) => http.createServer(fetchListener(c.fetch.bind(c))).listen(port);
        if (typeof c === 'function' && c.length >= 2)
            return (port) => http.createServer(c).listen(port);
    }
    return null;
}

function openLog(file) {
    try {
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        return fs.openSync(file, 'a');
    } catch (e) {
        return null;
    }
}

function hookStream(stream, fd) {
    stream.write = function (chunk, encoding, cb) {
        if (typeof encoding === 'function') {
            cb = encoding;
            encoding = undefined;
        }
        try {
            fs.writeSync(fd, typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : chunk);
        } catch (e) {
        }
        if (cb)
            process.nextTick(cb);
        return true;
    };
}

function setupLog() {
    const err = process.env.LS_STDERR_LOG ? openLog(process.env.LS_STDERR_LOG) : null;
    const out = process.env.LSNODE_CONSOLE_LOG ? openLog(process.env.LSNODE_CONSOLE_LOG) : err;
    if (typeof err === 'number') {
        hookStream(process.stderr, err);
        process.on('uncaughtExceptionMonitor', (e) => {
            try {
                fs.writeSync(err, (e && e.stack ? e.stack : String(e)) + '\n');
            } catch (x) {
            }
        });
    }
    if (typeof out === 'number')
        hookStream(process.stdout, out);
}

function loadEnvFile(file, optional) {
    if (typeof process.loadEnvFile !== 'function') {
        console.error('lsnode: --env-file needs Node.js 20.12 or later, ' + file + ' was not loaded');
        return;
    }
    try {
        process.loadEnvFile(file);
    } catch (e) {
        if (!optional || e.code !== 'ENOENT')
            throw e;
    }
}

async function startNext(root, port) {
    const mod = require(resolveFrom(root, 'next') || 'next');
    const next = mod.default || mod;
    const app = next({ dev: false, dir: root, hostname: '127.0.0.1', port });
    await app.prepare();
    const handle = app.getRequestHandler();
    const server = http.createServer((req, res) => handle(req, res));
    if (typeof app.getUpgradeHandler === 'function') {
        const upgrade = app.getUpgradeHandler();
        server.on('upgrade', (req, socket, head) => upgrade(req, socket, head));
    }
    server.listen(port);
}

async function runApp() {
    const root = path.resolve(process.env.LSNODE_ROOT || process.cwd());
    setupLog();
    const target = parseAddress(process.env.OLS_APP_ADDRESS);
    if (!target) {
        console.error(process.platform === 'win32'
            ? 'OLS_APP_ADDRESS is not set. This runner is started by OpenLiteSpeed for Windows, or by: ols-node run'
            : 'OLS_APP_ADDRESS is not set. On Linux, OpenLiteSpeed starts Node.js apps with its own lsnode.js');
        process.exit(1);
    }
    process.chdir(root);
    const app = detect(root, process.env.LSNODE_STARTUP_FILE);
    if (!app.file && !app.preset) {
        console.error('No start file found in ' + root + '. Set the startup file or add a start script to package.json');
        process.exit(1);
    }
    console.error('lsnode ' + VERSION + ': ' + (app.preset === 'next' ? 'Next.js' : path.relative(root, app.file))
        + ' (' + app.source + ') on ' + target.host + ':' + target.port);
    for (const w of app.warnings)
        console.error('lsnode: ' + w);
    for (const [k, v] of Object.entries(app.env))
        if (process.env[k] === undefined)
            process.env[k] = v;
    if (process.env.PORT === undefined)
        process.env.PORT = String(target.port);
    process.env.LSNODE_PARENT = String(process.pid);
    process.execArgv.push('--require', __filename);
    patchListen(target);
    for (const e of app.envFiles)
        loadEnvFile(path.resolve(root, e.file), e.optional);
    if (app.preset === 'next')
        return startNext(root, target.port);
    for (const p of app.preload)
        require(resolveFrom(root, p.startsWith('.') ? path.resolve(root, p) : p) || path.resolve(root, p));
    for (const i of app.imports) {
        const f = resolveFrom(root, i.startsWith('.') ? path.resolve(root, i) : i);
        await import(f ? pathToFileURL(f).href : i);
    }
    if (app.typescript === 'tsx') {
        require(resolveFrom(root, 'tsx/cjs/api')).register();
        require(resolveFrom(root, 'tsx/esm/api')).register();
    }
    process.title = 'lsnode:' + root;
    process.argv = [process.argv[0], app.file, ...app.args];
    Module.runMain(app.file);
    let ns = null;
    try {
        ns = await import(pathToFileURL(app.file).href);
    } catch (e) {
        const cached = require.cache[app.file];
        ns = cached ? { default: cached.exports } : null;
    }
    setTimeout(() => {
        const cluster = require('cluster');
        if (owner || (cluster.isPrimary !== false && Object.keys(cluster.workers || {}).length))
            return;
        const start = servable(ns);
        if (start) {
            autoStart = true;
            start(target.port);
        } else
            console.error('lsnode: ' + path.relative(root, app.file) + ' did not start a server and exports nothing that can be served');
    }, GRACE_MS);
}

function preload() {
    const cluster = require('cluster');
    const target = parseAddress(process.env.OLS_APP_ADDRESS);
    if (target && cluster.isWorker)
        patchListen(target);
    const parent = Number(process.env.LSNODE_PARENT);
    process.env.LSNODE_PARENT = String(process.pid);
    const keep = process.env.LSNODE_KEEP_CHILDREN;
    if (cluster.isWorker || !parent || parent === process.pid || (keep && keep !== '0'))
        return;
    if (!require('worker_threads').isMainThread)
        return;
    const t = setInterval(() => {
        try {
            process.kill(parent, 0);
        } catch (e) {
            if (e.code === 'ESRCH')
                process.exit(0);
        }
    }, 2000);
    t.unref();
}

if (require.main === module) {
    runApp().catch((e) => {
        console.error(e && e.stack ? e.stack : e);
        process.exit(1);
    });
} else if (process.execArgv.includes(__filename) && process.env.LSNODE_PARENT) {
    preload();
}

module.exports = { version: VERSION, detect, fetchListener, resolveBin, shellSplit };
