"use strict";
/* globals global require process logDir htmlDocs logger Buffer __dirname */

// the ws and compression modules are from npm
// I think express is too?

const cluster = require('cluster');
const url = require('url');
const qs = require('querystring');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const fs = require('fs');
const domain = require('domain');
const express = require('express');
const compression = require('compression');
const acceptedHosts = ["nishicode.com", "www.nishicode.com"];
//const crypto = require('crypto');
const badExtension = /\.php(?=\?|$)/;
const maxPost = 1e4;

let isValidHost = (host) => acceptedHosts.some(check => check === host);

/* function salter (text) {
	if (!text) {
		return 0;
	}

	let ret = 0;

	for (let c = 0; c < text.length; c++) {
		ret = ((ret << 1) | (ret >> 23)) & 0xFFFFFF;
		ret ^= text.charCodeAt(c);
	}

	return ret.toString(16);
}

let passhash = (pass) => crypto.scryptSync(pass, salter(pass), 64).toString('base64'); */

Object.defineProperties(global, {
	logDir: {
		value: __dirname + '/logs',
		writable: false,
	},
	htmlDocs: {
		value: __dirname + '/html',
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

				myout = fs.createWriteStream( logDir + '/CONSOLE', {flags: 'a'});
				myerr = myout;
			}

			return new console.Console(myout, myerr);
		})(),
		writable: false,
	},
});

const scripts = new class {
	constructor () {
		this.watch = {};
	}

	load (file) {
		try {
			file = require.resolve(file);

			if (!this.watch[file]) {
				logger.log('Loading script: ' + file);
				this.watch[file] = fs.watch(file, {persistent: false}, () => {
					try {
						if (require.cache[file]) {
							delete require.cache[file];
						}

						this.watch[file].close();
						delete this.watch[file];
					} catch (err) {
						logger.log(err.stack);
					}
				});
			}

			return require(file);
		} catch (err) {
			logger.log(err.stack);
		}

		return null;
	}
};

function scriptHandler (req, res, next) {
	let q = url.parse(req.url, true);
	let filepathbase = htmlDocs + decodeURI(q.pathname);
	let postdata = [], postdatalen = 0;

	if (!/\.sss$/i.test(filepathbase)) {
		filepathbase += ".sss"; // I just use sss for 'server side script'
	}

	fs.access(filepathbase, fs.constants.R_OK, access_err => {
		if (access_err) {
			return next();
		}

		try {
			let script = scripts.load(filepathbase), scriptInterface;

			if (script) {
				if (typeof script.request === 'function') {
					req.on('data', (chunk) => {
						postdatalen += chunk.length;

						if (postdatalen > maxPost) {
							res.status(413).end();
							res.connection.destroy();
						} else {
							postdata.push(chunk);
						}
					});
					req.on('end', () => {
						new Promise((resolve, reject) => {
							scriptInterface = {
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
							};
							script.request(scriptInterface, logger);
						}).then(response => {
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
							for (let k in scriptInterface.setCookie) {
								res.setHeader('Set-Cookie', qs.escape(k) + "=" + qs.escape(scriptInterface.setCookie[k]));
							}

							logger.log(`[${process.pid} @ ${new Date().toUTCString()}] ` + err.stack ? err.stack : err.toString());
							res.writeHead(500, scriptInterface.headers);

							if (err !== undefined && err !== null) {
								res.end(err.stack ? err.stack : err.toString(), 'binary');
							} else {
								res.end();
							}
						});
					});
				} else {
					res.writeHead(500, {'Content-Type': 'text/plain'});
					res.end('API Loaded Successfully!');
				}
			} else {
				res.writeHead(500, {'Content-Type': 'text/plain'});
				res.end('Error loading script!');
			}
		} catch (err) {
			logger.log(err);
		}

		return next();
	});
}

function scriptRouter (req, res, next) {
	let d;

	switch (req.method) {
	case 'GET':
	case 'POST':
	case 'PUT':
	case 'DELETE':
		d = domain.create();
		d.on('error', (err) => {
			res.writeHead(500, {'Content-Type': 'text/plain'});

			if (err) {
				logger.log(`[${process.pid} @ ${new Date().toUTCString()}] ` + err.stack ? err.stack : err.toString());
				res.end(err.stack ? err.stack : err.toString(), 'binary');
			} else {
				res.end('Internal Server Error');
			}
		});
		d.run(() => {
			scriptHandler(req, res, next);
		});

		break;
	default:
		return next();
	}
}

function checkDomain (req, res, next) {
	let parts = req.headers.host.split('.');

	if (parts.length < 3) {
		logger.log(`[${process.pid} @ ${new Date().toUTCString()}][${req.socket.remoteAddress}] ${req.method} ${JSON.stringify(req.headers.host)}${req.url}\t(forward to www)`);
		res.writeHead(301, {Location: 'https://www.' + req.headers.host + req.url});
		res.end();

		return true;
	}

	return typeof next === 'function' ? next() : false;
}

function killRequest (req, res, next) {
	if (req.headers.host && isValidHost(req.headers.host) && !badExtension.test(req.url)) {
		return typeof next === 'function' ? next() : false;
	}

	logger.log(`[${process.pid} @ ${new Date().toUTCString()}][${req.socket.remoteAddress}] ${req.method} ${JSON.stringify(req.headers.host) || 'NOHOST'}${req.url}\t(killed)`);
	let postdatalen = 0, postdata = [];
	req.on('data', chunk => {
		postdatalen += chunk.length;

		if (postdatalen > maxPost) {
			res.destroy();
		}

		postdata.push(chunk);
	});
	req.on('end', () => {
		logger.log(`\n[${process.pid} @ ${new Date().toUTCString()}][${req.socket.remoteAddress}]\n### Headers ###: ${JSON.stringify(req.rawHeaders)}`);

		if (postdata.length) {
			logger.log('### DATA ###: ' + JSON.stringify(Buffer.concat(postdata).toString()));
		}

		logger.log('### END ###\n');

		try {
			res.writeHead(404, {
				'Content-Type': 'text/html',
			});
			fs.createReadStream('./badreply.html').pipe(res);
		} catch (err) {
			logger.log(err);
		}
	});

	return true;
}

function logRequest (req, res, next) {
	logger.log(`[${process.pid} @ ${new Date().toUTCString()}][${req.ip}] ${req.method} ${JSON.stringify(req.headers.host)}${req.url}\t(OK)`);

	return next();
}

if (cluster.isMaster) { // master code
	console.log('Spawning children...');
	cluster.fork(); // only fork once, this just allows the server to keep itself alive
	cluster.on('exit', (worker /*, code, signal */) => {
		console.log(`[${process.pid} @ ${new Date().toUTCString()}] Child ${worker.process.pid} died!`);
		cluster.fork(); // if server dies fork a new thread
	});
} else { // child code
	logger.log(`[${process.pid} @ ${new Date().toUTCString()}] Starting node HTTP Server`);
	process.on('exit', (code) => {
		logger.log(`[${process.pid} @ ${new Date().toUTCString()}] Exiting with code: ${code}\n`);
	});

	let msg404 = ["404 Not Found", "404 (That resource does not exist)", "404 (Check your URL)"];

	// server setup
	const server = express();
	const staticOpts = { extensions: ['.html', '.htm', '.json'], maxAge: 600000 };

	server.use(killRequest); // kill connection if host name is not specified
	server.use(checkDomain); // redirects to www if no subdomain exists
	server.use(logRequest); // logs incoming requests
	server.use(compression());
	server.use(scriptRouter);
	server.use(express.static('html', staticOpts));
	server.use(function (req, res) {
		let msg = msg404[Math.floor(Math.random() * msg404.length)];
		res.writeHead(404, {'Content-Type': 'text/html'});
		res.end(`<html><head><title>Not Found</title></head><body><h1>${msg}</h1></body></html>`);
	});
	server.use(function (error, req, res) {
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
		try {
			logger.log(`[${process.pid} @ ${new Date().toUTCString()}][${req.socket.remoteAddress}] ${req.method} ${JSON.stringify(req.headers.host)}${req.url}\t(websocket)`);
			let q = url.parse(req.url, true);
			let filepathbase = htmlDocs + decodeURI(q.pathname);

			if (!/\.sss$/i.test(filepathbase)) {
				filepathbase += ".sss";
			}

			let script = scripts.load(filepathbase);

			if (script && typeof script.connect === 'function') {
				ws.scriptPath = filepathbase;

				if (script.connect(ws, wss, req)) {
					return;
				}
			}
		} catch (err) {
			logger.log(err);
		}

		ws.terminate();
	});
	httpserver.listen(443);

	// forward non-secure requests to https
	http.createServer((req, res) => {
		if (!killRequest(req, res) && !checkDomain(req, res)) {
			logger.log(`[${process.pid} @ ${new Date().toUTCString()}][${req.socket.remoteAddress}] ${req.method} ${JSON.stringify(req.headers.host)}${req.url}\t(forward to https)`);
			res.writeHead(301, {Location: 'https://' + req.headers.host + req.url});
			res.end();
		}
	}).on("connection", (sock) => {
		sock.setNoDelay(true);
	}).listen(80);
}

