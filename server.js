// my node.js server!
const cluster = require('cluster');
const url = require('url');
const qs = require('querystring');
const http = require('http');
const https = require('https');
const fs = require('fs');

// define some global constants first
Object.defineProperties(global,{
	logDir: {
		value: './logs',
		writable: false,
	},
	htmlDocs: {
		value: './html',
		writable: false,
	},
});

// define some awesome global functions for use everywhere!
Object.defineProperties(global,{
	requireOptional:{
		value: function (){
			try {
				return require.apply(this,arguments);
			} catch (err) {
				console.log(err.stack);
				return {};
			}
		},
		writable: false,
	},
	require: {
		value: require,
		writable: false,
	},
	logger: {
		value: (()=>{
			if(cluster.isMaster)
				return console;
			let myout;
			let myerr;
			if(process.stdout.isTTY) {
				myout = process.stdout;
				myerr = process.stderr;
			} else {
				if(!fs.existsSync(logDir))
					fs.mkdirSync(logDir);
				myout = fs.createWriteStream(logDir+'/'+process.pid+'.txt');
				myerr = myout;
			}
			return new console.Console(myout,myerr);
		})(),
		writable: false,
	},
	getURL: { // easy promise url getter (for dem clean promise chains!)
		value: (options)=>{
			let ret = new Promise((resolve,reject)=>{
				let up = url.parse(options.url);
				let post = options.post;
				let headers = options.headers;
				if(typeof post === 'object'){
					post = qs.stringify(post);
				}
				if(typeof headers !== 'object'){
					headers = {};
				}
				up.headers = headers;
				if(typeof post === 'string'){
					up.method = "POST";
					headers["Content-Type"] = "application/x-www-form-urlencoded";
					headers["Content-Length"] = post.length;
				} else
					post = undefined;
				let ro;
				switch(up.protocol){
					case "http:":
						ro = http;
						break;
					case "https:":
						ro = https;
						break;
					default:
						throw("Unsupported protocol: "+JSON.stringify(up,null,' '));
				}
				let req=ro.request(up,(res)=>{
						let data=[];
						res.on('data', (chunk) => {
							data.push(chunk);
						});
						res.on('end', () => {
								if(data.length>0) {
									resolve({res: res, data: Buffer.concat(data).toString()});
								} else
									resolve({res: res});
						});
					});
					if(post)
						req.write(post);
					req.end();
			});
			return ret;
		},
		writable: false,
	},
});

// debugging extensions
Object.defineProperties(Object.prototype,{
	hookProperty:{
		value:function (property,setter,getter) {
			if(setter === undefined && getter === undefined)
				return;
			let desc = Object.getOwnPropertyDescriptor(this, property);
			if(desc){
				if(desc.get !== undefined || desc.set !== undefined)
					return;
				let propobj = {};
				let propval = desc.value;
				if(typeof setter === "function")
					propobj.set = (newval)=>(propval=setter(newval,propval));
				else
					propobj.set = (newval)=>(propval=newval);
				if(typeof getter === "function")
					propobj.get = ()=>getter(propval);
				else
					propobj.get = ()=>propval;
				Object.defineProperty(this,property,propobj);
			}
		},
		writable: false,
	},
	unhookProperty:{
		value:function (property) {
			let desc = Object.getOwnPropertyDescriptor(this, property);
			if(desc){
				if(desc.get === undefined && desc.set === undefined)
					return;
				let propval = this[property];
				delete this[property];
				this[property] = propval;
			}
		},
		writable: false,
	},
	breakdown:{
		value:function(baseName){
			let ret = '';
			let shown = [];
			if(baseName === undefined)
				baseName = '';
			function _getValues(obj,objName) {
				switch(typeof obj){
					case 'object':
						if(obj === null)
							return ret+=objName+' = null\n';
						if(shown.indexOf(obj)>-1)
							return;
						shown.push(obj);
						let keys = Object.keys(obj);
						for(let c=0;c<keys.length;c++)
							_getValues(obj[keys[c]],objName+'.'+keys[c]);
						return;
					case 'function':
						return ret+=objName+' = [Function]\n';
					case 'string':
						if(obj.length>0)
							return ret+=objName+' = '+JSON.stringify(obj)+'\n';
						return '';
					case 'boolean':
					case 'number':
						return ret+=objName+' = '+JSON.stringify(obj)+'\n';
					case "undefined":
						return ret+=objName+' = undefined\n';
					default:
						return ret+=objName+' = unknown type: '+typeof obj+'\n';
				}
			}
			_getValues(this,baseName);
			return ret;
		},
		writable: false,
	},
	display:{
		value:function (indent){
			var shown=[];
			var nope={};
			if(indent===undefined)
				indent='	';
			function _showObject(obj,depth) {
				switch(typeof obj){
					case 'object':
						if(obj===null)
							return "null";
						if(shown.indexOf(obj)>-1)
							return nope;
						shown.push(obj);
						let ret='{\n';
						let keys = Object.keys(obj);
						let oc=0;
						for(let c=0;c<keys.length;c++){
							let val = _showObject(obj[keys[c]],depth+indent);
							if(val !== nope){
								if(oc>0)
									ret+=',\n'+depth+indent+JSON.stringify(keys[c])+': '+val;
								else
									ret+=depth+indent+JSON.stringify(keys[c])+': '+val;
								oc++;
							}
						}
						if(oc>0) {
							ret+='\n';
							ret+=depth+'}';
							return ret;
						} else return "{}";
					case 'function':
						return obj.toString();
					case 'undefined':
						return 'undefined';
					default:
						return JSON.stringify(obj);
				}
				return '';
			}
			return _showObject(this,'');
		},
		writable: false,
	},
});

// spawn whatever just because
if(cluster.isMaster)
	return require('./master');
else
	return require('./child');
