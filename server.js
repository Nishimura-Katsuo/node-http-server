/* globals global require process logDir htmlDocs logger Buffer */

// the ws and compression modules are from npm
// I think express is too?

const cluster = require('cluster');
const url = require('url');
const qs = require('querystring');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const fs = require('fs');
const vm = require('vm');
const domain = require('domain');
const express = require('express');
const compression = require('compression');

Object.defineProperties(global, {
	logDir: {
		value: './logs',
		writable: false,
	},
	htmlDocs: {
		value: './html',
		writable: false,
	},
});

Object.defineProperties(global, {
	require: {
		value: require,
		writable: false,
	},
	logger: {
		value: (() => {
			if (cluster.isMaster) {
				return console;
			}

			let myout;
			let myerr;

			if (process.stdout.isTTY) {
				myout = process.stdout;
				myerr = process.stderr;
			} else {
				if (!fs.existsSync(logDir)) {
					fs.mkdirSync(logDir);
				}

				myout = fs.createWriteStream( logDir + '/' + process.pid + '.txt' );
				myerr = myout;
			}

			return new console.Console(myout, myerr);
		})(),
		writable: false,
	},
});

const scriptcache = {};

function loadScript (file) {
	return new Promise((resolve, reject) => {
		fs.stat(file, (err, stats) => {
			if (err) {
				reject("NOT A FILE");
			} else if (!(stats.isFile())) {
				reject("NOT A FILE");
			} else if (scriptcache[file] && scriptcache[file].mtime === stats.mtime.toUTCString()) {
				resolve(scriptcache[file]);
			} else {
				fs.readFile(file, (errb, data) => {
					if (errb) {
						reject(errb);
					} else {
						logger.log("Compiling: " + file);
						scriptcache[file] = {mtime: stats.mtime.toUTCString(), exports: undefined};
						scriptcache[file].exports = vm.runInThisContext(data, {filename: file, displayErrors: true});

						if (typeof scriptcache[file].exports === 'function') {
							scriptcache[file].exports = new scriptcache[file].exports();
						}

						resolve(scriptcache[file]);
					}
				});
			}
		});
	});
}

function scriptHandler (req, res, next) {
	if (req.method !== "HEAD" && req.method !== "GET" && req.method !== "POST") {
		return next();
	}

	let q = url.parse(req.url, true);
	let filepathbase = htmlDocs + decodeURI(q.pathname);
	let postdata = [];
	const d = domain.create();
	d.on('error', (err) => {
		logger.log(err.stack);
		res.writeHead(500, {'Content-Type': 'text/plain'});
		res.end(err.stack, 'binary');

		return;
	});
	d.run(() => {
		req.on('data', (chunk) => {
			if (postdata.length > 1e6) {
				res.status(413).end();
				res.connection.destroy();
			} else {
				postdata.push(chunk);
			}
		});
		req.on('end', () => {
			if (!/\.sss$/i.test(filepathbase)) {
				filepathbase += ".sss"; // I just use sss for 'server side script'
			}

			let scriptInterface = {headers: {'Content-Type': 'text/plain'}};

			loadScript(filepathbase).then(cache => new Promise((resolve, reject) => {
				if (req.method === "HEAD") {
					scriptInterface.responseCode = 200;
					scriptInterface.headers['Last-Modified'] = cache.mtime;
					resolve();
				} else {
					if (typeof cache.exports.request === 'function') {
						Object.assign(scriptInterface, {
							responseCode: 200,
							headers: {'Content-Type': 'text/plain'},
							setCookie: {},
							getPostData: () => Buffer.concat(postdata).toString(),
							query: q.query,
							method: req.method,
							path: q.pathname,
							resolve: resolve,
							reject: reject,
							cookie: (req.headers.cookie ? qs.parse(req.headers.cookie, ';') : {}),
						});
						cache.exports.request(scriptInterface, logger);
					} else {
						reject("UNSUPPORTED SCRIPT");
					}
				}
			})).then(response => {
				for (let k in scriptInterface.setCookie) {
					res.setHeader('Set-Cookie', qs.escape(k) + "=" + qs.escape(scriptInterface.setCookie[k]));
				}

				res.writeHead(scriptInterface.responseCode, scriptInterface.headers);

				if (response !== undefined && response !== null) {
					res.end(response.toString(), 'binary');
				} else {
					res.end();
				}
			}).catch(err => {
				if (err === "NOT A FILE") {
					next();
				} else {
					for (let k in scriptInterface.setCookie) {
						res.setHeader('Set-Cookie', qs.escape(k) + "=" + qs.escape(scriptInterface.setCookie[k]));
					}

					logger.log(err.stack ? err.stack : err.toString());
					res.writeHead(500, scriptInterface.headers);

					if (err !== undefined && err !== null) {
						res.end(err.stack ? err.stack : err.toString(), 'binary');
					} else {
						res.end();
					}
				}
			});
		});
	});
}

if (cluster.isMaster) { // master code
	console.log('Spawning children...');
	cluster.fork(); // only fork once, this just allows the server to keep itself alive
	cluster.on('exit', (worker, code, signal) => {
		console.log(`worker ${worker.process.pid} died`);
		cluster.fork(); // if server dies fork a new thread
	});
} else { // child code
	logger.log('Starting node HTTP Server [' + process.pid + ']');
	process.on('exit', (code) => {
		logger.log(`Exiting with code: ${code}\n`);
	});

	let msg404 = ["Not found!!!", "Recheck your URL, bruh", "I cahna do et, Captain!"];

	// server setup
	const server = express();
	const staticOpts = { extensions: ['.html', '.htm', '.json', '.lib'] };
	server.use(compression());
	server.use(scriptHandler);
	server.use(express.static('html', staticOpts));
	server.use(function (req, res) {
		let msg = msg404[Math.floor(Math.random() * msg404.length)];
		res.writeHead(404, {'Content-Type': 'text/html'});
		res.end(`<html><head><title>Not Found</title></head><body><h1>${msg}</h1></body></html>`);
	});
	server.use(function (error, req, res, next) {
		res.writeHead(500, {'Content-Type': 'text/html'});
		res.end(`<html><head><title>Internal Server Error</title></head><body><h1>ERROR</h1></body></html>`);
	});

	let httpserver = https.createServer({
		ca: fs.readFileSync('./server.ca-bundle'),
		key: fs.readFileSync('./server.key'),
		cert: fs.readFileSync('./server.crt')
	}, server);
	let wss = new WebSocket.Server({ server: httpserver });
	wss.on('connection', (ws, req) => {
		let q = url.parse(req.url, true);
		let filepathbase = htmlDocs + decodeURI(q.pathname);

		if (!/\.sss$/i.test(filepathbase)) {
			filepathbase += ".sss";
		}

		loadScript(filepathbase).then(cache => {
			if (cache && cache.exports && typeof cache.exports.connect === 'function') {
				ws.scriptPath = filepathbase;

				if (!cache.exports.connect(ws, wss, req)) {
					ws.terminate();
				}
			} else {
				ws.terminate();
			}
		}).catch(() => {
			ws.terminate();
		});
	});
	httpserver.listen(443);

	// forward non-secure requests to https
	http.createServer(/* server */ (req, res) => {
		res.writeHead(307, {'Location': 'https://' + req.headers.host + req.url});
		res.end();
	}).on("connection", (sock) => {
		sock.setNoDelay(true);
	}).listen(80);

}

