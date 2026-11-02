#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const lsnode = require('../lsnode.js');

const RUNNER = path.resolve(__dirname, '..', 'lsnode.js');

const HELP = `ols-node ${lsnode.version}

Usage: ols-node <command> [app folder] [options]

Commands
  doctor   Show how OpenLiteSpeed will start the app
  run      Run the app the same way OpenLiteSpeed runs it
  add      Add the app to an OpenLiteSpeed virtual host and reload the server
  restart  Restart the app on its next request

Options
  --port <n>        Port for run (default 3000)
  --startup <file>  Start file, when detection should not be used
  --uri <path>      URI for add (default /)
  --vhost <name>    Virtual host for add
  --server <dir>    OpenLiteSpeed folder for add
  --node <file>     node.exe for add, when it is not on PATH
  --env <mode>      production, development or staging for add (default production)
  --force           Replace an existing context with the same URI
  --no-reload       Do not reload the server after add
  --dry-run         Print the change without writing it
`;

function parseArgs(argv) {
    const opts = { _: [] };
    const valued = ['port', 'startup', 'uri', 'vhost', 'server', 'node', 'env'];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const k = (eq > 0 ? a.slice(2, eq) : a.slice(2));
            if (valued.includes(k))
                opts[k] = eq > 0 ? a.slice(eq + 1) : argv[++i];
            else
                opts[k] = true;
        } else if (a === '-h') {
            opts.help = true;
        } else if (a === '-v') {
            opts.version = true;
        } else {
            opts._.push(a);
        }
    }
    return opts;
}

function fail(msg) {
    console.error('ols-node: ' + msg);
    process.exit(1);
}

function moduleType(file) {
    if (/\.(mjs|mts)$/.test(file))
        return 'ES module';
    if (/\.(cjs|cts)$/.test(file))
        return 'CommonJS';
    let dir = path.dirname(file);
    for (;;) {
        const pj = path.join(dir, 'package.json');
        if (fs.existsSync(pj)) {
            try {
                return JSON.parse(fs.readFileSync(pj, 'utf8')).type === 'module' ? 'ES module' : 'CommonJS';
            } catch (e) {
                return 'CommonJS';
            }
        }
        const up = path.dirname(dir);
        if (up === dir)
            return 'CommonJS';
        dir = up;
    }
}

function rel(root, f) {
    const r = path.relative(root, f);
    return r && !r.startsWith('..') ? r.split(path.sep).join('/') : f;
}

function readReg() {
    if (process.platform !== 'win32')
        return null;
    const r = spawnSync('reg', ['query', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenLiteSpeed', '/v', 'InstallLocation'], { encoding: 'utf8' });
    const m = /InstallLocation\s+REG_\w+\s+(.+)/.exec(r.stdout || '');
    return m ? m[1].trim() : null;
}

function findServer(given) {
    const list = given ? [given] : [process.env.OLS_ROOT, readReg(), 'C:\\OpenLiteSpeed', 'C:\\laragon\\bin\\openlitespeed', 'C:\\xampp\\openlitespeed'];
    for (const d of list)
        if (d && fs.existsSync(path.join(d, 'conf', 'httpd_config.conf')))
            return path.resolve(d);
    return null;
}

function blockEnd(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '{')
            depth++;
        else if (text[i] === '}' && --depth === 0)
            return i + 1;
    }
    return -1;
}

function virtualHosts(server) {
    const text = fs.readFileSync(path.join(server, 'conf', 'httpd_config.conf'), 'utf8');
    const out = [];
    const re = /^[ \t]*virtualhost[ \t]+(\S+)[ \t]*\{/gm;
    let m;
    while ((m = re.exec(text))) {
        const end = blockEnd(text, m.index + m[0].length - 1);
        const body = text.slice(m.index, end < 0 ? text.length : end);
        const get = (k) => {
            const v = new RegExp('^[ \\t]*' + k + '[ \\t]+(.+)$', 'm').exec(body);
            return v ? v[1].trim() : '';
        };
        const name = m[1];
        const sub = (s) => s.replace(/\$SERVER_ROOT/g, server).replace(/\$VH_NAME/g, name);
        const vhRoot = sub(get('vhRoot'));
        const conf = sub(get('configFile')).replace(/\$VH_ROOT/g, vhRoot);
        out.push({ name, conf: conf ? path.resolve(server, conf) : '' });
    }
    return out;
}

function contextBlock(app, opts) {
    const loc = app.root.split(path.sep).join('/').replace(/\/?$/, '/');
    const mode = { development: 0, production: 1, staging: 2 }[opts.env || 'production'];
    if (mode === undefined)
        fail('--env must be production, development or staging');
    const lines = [
        ['type', 'appserver'],
        ['location', loc],
        ['appType', 'node']
    ];
    if (opts.node)
        lines.push(['binPath', path.resolve(opts.node).split(path.sep).join('/')]);
    if (app.file && rel(app.root, app.file) !== 'app.js')
        lines.push(['startupFile', rel(app.root, app.file)]);
    lines.push(['appserverEnv', String(mode)], ['maxConns', '100']);
    return 'context ' + opts.uri + ' {\n' + lines.map(([k, v]) => '  ' + k.padEnd(24) + v).join('\n') + '\n}\n';
}

function cmdDoctor(dir, opts) {
    const app = lsnode.detect(dir, opts.startup);
    const rows = [['App folder', app.root], ['Node.js', process.version]];
    if (app.preset === 'next')
        rows.push(['Start', 'Next.js production server (' + app.source + ')']);
    else if (app.file) {
        rows.push(['Start', rel(app.root, app.file) + ' (' + app.source + ')']);
        if (app.args.length)
            rows.push(['Arguments', app.args.join(' ')]);
        rows.push(['Module type', /\.[cm]?ts$/.test(app.file)
            ? 'TypeScript' + (app.typescript ? ' through ' + (app.typescript === 'tsx' ? 'tsx' : 'Node.js type stripping') : '')
            : moduleType(app.file)]);
    } else
        rows.push(['Start', 'not found']);
    if (app.envFiles.length)
        rows.push(['Env files', app.envFiles.map((e) => e.file).join(', ')]);
    if (app.preload.length || app.imports.length)
        rows.push(['Preload', app.preload.concat(app.imports).join(', ')]);
    const env = Object.keys(app.env);
    if (env.length)
        rows.push(['Environment', env.map((k) => k + '=' + app.env[k]).join(' ')]);
    const server = findServer(opts.server);
    rows.push(['OpenLiteSpeed', server || 'not found']);
    for (const [k, v] of rows)
        console.log(k.padEnd(15) + v);
    if (!app.file && !app.preset)
        app.warnings.unshift('No start file found. Add a start script to package.json or pass --startup');
    for (const w of app.warnings)
        console.log('Warning        ' + w);
    return app.file || app.preset ? 0 : 1;
}

function cmdRun(dir, opts) {
    const port = Number(opts.port || 3000);
    if (!(port > 0 && port < 65536))
        fail('--port must be a port number');
    const env = Object.assign({}, process.env, {
        LSNODE_ROOT: path.resolve(dir),
        OLS_APP_ADDRESS: '127.0.0.1:' + port
    });
    delete env.LS_STDERR_LOG;
    delete env.LSNODE_PARENT;
    if (opts.startup)
        env.LSNODE_STARTUP_FILE = opts.startup;
    const child = spawn(process.execPath, [RUNNER], { stdio: 'inherit', env, cwd: path.resolve(dir) });
    console.log('ols-node: http://127.0.0.1:' + port + '/');
    for (const sig of ['SIGINT', 'SIGTERM'])
        process.on(sig, () => child.kill(sig));
    child.on('exit', (code, sig) => process.exit(code === null ? (sig ? 1 : 0) : code));
}

function cmdRestart(dir) {
    const tmp = path.join(path.resolve(dir), 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'restart.txt'), new Date().toISOString() + '\n');
    console.log('ols-node: the app restarts on its next request');
    return 0;
}

function cmdAdd(dir, opts) {
    const app = lsnode.detect(dir, opts.startup);
    if (!app.file && !app.preset)
        fail('no start file found in ' + app.root + ', run ols-node doctor');
    opts.uri = opts.uri || '/';
    if (!opts.uri.startsWith('/'))
        opts.uri = '/' + opts.uri;
    if (!opts.uri.endsWith('/'))
        opts.uri += '/';
    const server = findServer(opts.server);
    if (!server)
        fail('OpenLiteSpeed was not found, pass --server <folder>');
    const hosts = virtualHosts(server);
    if (!hosts.length)
        fail('no virtual host in ' + path.join(server, 'conf', 'httpd_config.conf'));
    let vh;
    if (opts.vhost)
        vh = hosts.find((h) => h.name.toLowerCase() === String(opts.vhost).toLowerCase());
    else if (hosts.length === 1)
        vh = hosts[0];
    if (!vh)
        fail((opts.vhost ? 'virtual host ' + opts.vhost + ' was not found. ' : 'pass --vhost. ')
            + 'Virtual hosts: ' + hosts.map((h) => h.name).join(', '));
    if (!vh.conf || !fs.existsSync(vh.conf))
        fail('the config file of ' + vh.name + ' was not found: ' + vh.conf);
    let text = fs.readFileSync(vh.conf, 'utf8');
    const esc = opts.uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('^[ \\t]*context[ \\t]+' + esc + '[ \\t]*\\{', 'm').exec(text);
    if (m) {
        if (!opts.force)
            fail(vh.name + ' already has a context for ' + opts.uri + ', pass --force to replace it');
        let end = blockEnd(text, m.index + m[0].length - 1);
        if (end < 0)
            fail('cannot parse ' + vh.conf);
        while (text[end] === '\r' || text[end] === '\n')
            end++;
        text = text.slice(0, m.index) + text.slice(end);
    }
    const block = contextBlock(app, opts);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const next = text.replace(/\s*$/, '') + eol + eol + block.replace(/\n/g, eol);
    if (opts['dry-run']) {
        console.log(vh.conf + ':\n\n' + block);
        return 0;
    }
    try {
        fs.copyFileSync(vh.conf, vh.conf + '.bak');
        fs.writeFileSync(vh.conf, next);
    } catch (e) {
        fail('cannot write ' + vh.conf + ' (' + e.code + '). Run the command as Administrator');
    }
    console.log('ols-node: added ' + opts.uri + ' to ' + vh.name + ' (' + vh.conf + '), the previous file is ' + path.basename(vh.conf) + '.bak');
    const exe = path.join(server, 'bin', process.platform === 'win32' ? 'openlitespeed.exe' : 'openlitespeed');
    if (!fs.existsSync(exe) || opts['no-reload'])
        return 0;
    const env = Object.assign({}, process.env, { OLS_ROOT: server });
    const st = spawnSync(exe, ['-s', 'status'], { encoding: 'utf8', env });
    if (st.status !== 0) {
        console.log('ols-node: OpenLiteSpeed is not running, the app is served after it starts');
        return 0;
    }
    const r = spawnSync(exe, ['-s', 'graceful'], { encoding: 'utf8', env });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    return r.status === 0 ? 0 : 1;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const cmd = opts._.shift();
    if (opts.version || cmd === 'version') {
        console.log(lsnode.version);
        return 0;
    }
    if (!cmd || opts.help || cmd === 'help') {
        process.stdout.write(HELP);
        return cmd || opts.help ? 0 : 1;
    }
    const dir = opts._[0] || '.';
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
        fail(dir + ' is not a folder');
    switch (cmd) {
    case 'doctor':
        return cmdDoctor(dir, opts);
    case 'run':
        return cmdRun(dir, opts);
    case 'add':
        return cmdAdd(dir, opts);
    case 'restart':
        return cmdRestart(dir);
    default:
        fail('unknown command ' + cmd + ', run ols-node --help');
    }
}

const code = main();
if (typeof code === 'number')
    process.exitCode = code;
