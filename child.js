// child process

logger.log('Starting node HTTP Server ['+process.pid+']');
const vm = require('vm');
const domain = require('domain');
const http = require('http');
const https = require('https');
const fs = require('fs');
const express = require('express');
const compression = require('compression');
const url = require('url');
const qs = require('querystring');
const optional = requireOptional('./optional');

process.on('exit', (code) => {
  logger.log(`Exiting with code: ${code}\n`);
});

let scriptcache = {};
scriptSandbox = undefined;

if(!fs.existsSync(htmlDocs))
	fs.mkdirSync(htmlDocs);

function scriptHandler(req, res, next) {
	if(req.method!="HEAD" && req.method!="GET" && req.method!="POST")
		return next();
	let q=url.parse(req.url,true);
	let filepathbase = htmlDocs+decodeURI(q.pathname);
	let postdata=[];
	let localSandbox;
	const d=domain.create();
	d.on('error',(err)=>{
		logger.log(err.stack);
		res.writeHead(500, {'Content-Type': 'text/plain'});
		if(localSandbox && localSandbox.response)
			res.end(localSandbox.response+"\n\n"+err.stack,'binary');
		else
			res.end(err.stack,'binary');
		return;
	});
	d.run(()=>{
		function got_stats(filename,err,stats,firstTime){
			if(err || !(stats.isFile()))
					return next();
			if(req.method=="HEAD"){
				res.writeHead(200, {'Last-Modified': stats.mtime.toUTCString()});
				res.end();
			} else {
				fs.readFile(filename,(err,data)=>{
					try {
						if(err) { res.writeHead(500, {}); res.end(); return; }
						if(scriptcache[filename] && scriptcache[filename].mtime == stats.mtime.toUTCString()) {
							scriptObj = scriptcache[filename].script;
							localSandbox = scriptcache[filename].context;
						} else {
							logger.log("Compiling: "+filename);
							scriptObj = new vm.Script("(function(script,console,require){"+data+"\n})(scriptSandbox,logger,require);",{filename:filename, displayErrors: true});
							localSandbox = {};
							scriptcache[filename] = {};
							scriptcache[filename].script = scriptObj;
							scriptcache[filename].context = localSandbox;
							scriptcache[filename].mtime = stats.mtime.toUTCString();
						}
						let finished=false;
						Object.assign(localSandbox,{
							request: req,
							responseCode: 0,
							headers: {'Content-Type': 'text/plain'},
							response: '',
							setCookie: {},
							getPostData: ()=>Buffer.concat(postdata).toString(),
							query: q.query,
							method: req.method,
							path: q.pathname,
							finish: Promise.resolve(),
						});
						if(req.headers['cookie']){
							localSandbox.cookie = qs.parse(req.headers['cookie'],';');
						} else {
							localSandbox.cookie = {};
						}
						scriptSandbox = localSandbox;
						scriptObj.runInThisContext({});
						if(!localSandbox.finish || localSandbox.finish.constructor !== Promise)
							localSandbox.finish = Promise.resolve();
						const finishRequest=defaultCode=>{
							if(finished)return;
							finished=true;
							if(!localSandbox.responseCode)
								localSandbox.responseCode=defaultCode;
							for(let k in localSandbox.setCookie){
								res.setHeader('Set-Cookie',qs.escape(k)+"="+qs.escape(localSandbox.setCookie[k]));
							}
							res.writeHead(localSandbox.responseCode,localSandbox.headers);
							if(localSandbox.response != undefined && localSandbox.response != null)
								res.end(localSandbox.response,'binary');
							else
								res.end();
						};
						localSandbox.finish.then(finishRequest(200),finishRequest(400));
					} catch (err) {
						res.status(500).end(err.stack);
					}
				});
				return;
			}
		}
		req.on('data',(chunk) => {
			if(postdata.length > 1e6) {
				res.status(413).end();
				res.connection.destroy();
			} else {
				postdata.push(chunk);
			}
		});
		req.on('end',()=>{
			if(!/\.sss$/i.test(filepathbase))
				filepathbase += ".sss";
			fs.stat(filepathbase,(err,stats)=>got_stats(filepathbase,err,stats));
		});
	});
}

var msg404 = ["Not found!!!","Recheck your URL, bruh","I cahna do et, Captain!"];

// server setup
const server = express();
const staticOpts = { extensions: ['.html','.htm','.json','.lib'] };
server.use(compression());
server.use(scriptHandler);
server.use(express.static('html',staticOpts));
server.use(function(req,res){
	let msg=msg404[Math.floor(Math.random()*msg404.length)];
	res.writeHead(404, {'Content-Type': 'text/html'});
	res.end(`<html><head><title>Not Found</title></head><body><h1>${msg}</h1></body></html>`);
});
server.use(function(error,req,res,next){
	res.writeHead(500, {'Content-Type': 'text/html'});
	res.end(`<html><head><title>Internal Server Error</title></head><body><h1>ERROR</h1></body></html>`);
});
https.createServer({
	ca: fs.readFileSync('./server.ca-bundle'),
	key: fs.readFileSync('./server.key'),
	cert: fs.readFileSync('./server.crt')
},server).listen(443);

// forward non-secure requests to https
http.createServer((req,res) => {
	res.writeHead(307,{'Location':'https://'+req.headers.host+req.url});
	res.end();
}).on("connection",(socket)=>{socket.setNoDelay(true);}).listen(80);
