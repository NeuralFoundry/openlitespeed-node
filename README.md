# openlitespeed-node

Run Node.js apps behind [OpenLiteSpeed for Windows](https://github.com/NeuralFoundry/openlitespeed-windows) without changing their code. This package is the runner the server starts for every Node.js app context, plus the `ols-node` command to check, run and register apps.

## Features

- Finds the start file on its own: the `startupFile` of the context, `scripts.start` in `package.json`, `main`, or common names such as `server.js`, `index.js` and `dist/main.js`.
- Runs CommonJS, ES modules and TypeScript (through tsx when the app has it, otherwise Node.js type stripping).
- Moves the first server the app starts to the address the server reserved for it, whatever port the app asks for. Servers started later keep their own ports.
- Serves apps that only export something: an Express or Koa app, a `(req, res)` handler, or a fetch handler such as Hono.
- Starts Next.js with its production server and runs package binaries from start scripts, such as `remix-serve`.
- Applies `--env-file`, `-r`, `--import` and variables such as `cross-env NODE_ENV=production` from the start script.
- Gives the app the real client address and scheme, so `req.ip`, `req.secure` and secure cookies work without proxy settings.
- Supports WebSockets, cluster mode and worker threads, and stops forked child processes together with the app.
- Writes console output and crashes to the log file of the app.

Tested with Express 4 and 5, Koa, Fastify 5, Hono, ws, Next.js 15 and tsx.

## Requirements

- OpenLiteSpeed for Windows 1.9.4-win.7 or later
- Node.js 18.17 or later

## Install

```sh
npm install -g openlitespeed-node
```

OpenLiteSpeed for Windows ships the runner, so apps work without installing anything. To pin a runner version for one app, add the package to it:

```sh
npm install openlitespeed-node
```

The server then starts that app with `node_modules/openlitespeed-node/lsnode.js`.

## Commands

```sh
ols-node doctor [folder]
ols-node run [folder] [--port 3000]
ols-node add [folder] [--uri /] [--vhost NAME] [--server DIR] [--dry-run]
ols-node restart [folder]
```

| Command | What it does |
|---|---|
| `doctor` | Shows how the app will start and reports problems such as a missing build or `node_modules`. |
| `run` | Runs the app locally the same way the server runs it. |
| `add` | Adds an app server context for the app to a virtual host, keeps the previous file as `vhconf.conf.bak` and reloads the server. |
| `restart` | Writes `tmp/restart.txt`. The server restarts the app within 10 seconds. |

`add` finds the server through `--server`, `OLS_ROOT`, the installer registry entry, `C:\OpenLiteSpeed`, Laragon and XAMPP. Other options: `--startup <file>`, `--node <node.exe>`, `--env production|development|staging`, `--force` to replace a context with the same URI, `--no-reload`.

## Settings

Environment variables, set in the `env` lines of the context or for the whole system:

| Variable | Effect |
|---|---|
| `LS_STDERR_LOG` | Log file for console output and errors. The server sets it to `log/stderr.log` in the app folder. |
| `LSNODE_CONSOLE_LOG` | Separate file for standard output. |
| `LSNODE_REAL_IP=0` | Keep the proxy as the client address. |
| `LSNODE_KEEP_CHILDREN=1` | Let forked child processes outlive the app. |

Node.js options in the start script that cannot be applied at runtime, such as `--max-old-space-size`, belong in `NODE_OPTIONS`.

Files in the `public` folder of the app are served by OpenLiteSpeed directly. A context such as `/api/` passes the full path to the app, so set the base path in the app, for Next.js `basePath: '/api'` with `trailingSlash: true`.

## Linux

OpenLiteSpeed on Linux ships its own Node.js runner and does not need this package.

## License

MIT
