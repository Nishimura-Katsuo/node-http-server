const cluster = require('cluster');
const optional = requireOptional('./master-optional');
const numCPUs = require('os').cpus().length;
console.log('Spawning children...');
for(let c=0;c<numCPUs;c++) {
	cluster.fork();
}
cluster.on('exit', (worker, code, signal) => {
	console.log(`worker ${worker.process.pid} died`);
	cluster.fork();
});

if(process.stdout.isTTY){
	// console interface (useful for debugging)
	const readline = require('readline');
	const vm = require('vm');
	const domain = require('domain');
	function base_command(cmd,argline) {
		switch(cmd) {
			case "exit":
			case "quit":
				process.exit(0);
				return true;
			case "kill":
				let killpid=argline|0;
				for(const id in cluster.workers)
					if(cluster.workers[id].process.pid == killpid)
						cluster.workers[id].kill();
				return true;
			case "fork":
				cluster.fork();
				return true;
			case "sql":
				try {
					const cred = requireOptional('./cred');
					if(!cred || cred.sqlLogin === undefined)
						return false;
					const mysql = requireOptional('mysql');
					if(mysql){
						let sql = mysql.createConnection(cred.sqlLogin);
						sql.connect((err)=>{
							if(err)
								console.log(err);
							else {
								sql.query(argline,(err,result)=>{
									if(err) {
										if(err.fatal)
											console.log("Fatal error: "+err.sqlMessage);
										else
											console.log("Error: "+err.sqlMessage);
									} else
										console.log("Result: "+result);
									sql.end();
								});
							}
						});
					} else
						return false;
				} catch (err) {
					console.log(err.stack);
				}
				return true;
			case "eval":
				const d = domain.create();
				d.on('error',(err)=>{
					console.log(err.stack);
				});
				d.run(()=>{
					ret = vm.runInThisContext(argline,{timeout: 10,filename:"<EVAL>", displayErrors: true});
					console.log("Exit value: "+ret);
				});
				return true;
			default:
				return false;
		}
		return false;
	}

	let rl = readline.createInterface(process.stdin, process.stdout);
	let command = [base_command];

	rl.on('line', (answer) => {
		answer = answer.trim();
		if(answer.length>0) {
			let splits = ([]);
			let sind = answer.indexOf(" ");
			if(sind<0) {
				splits[0] = answer;
				splits[1] = "";
			} else {
				splits[0] = answer.substring(0,sind);
				splits[1] = answer.substring(sind+1);
			}
			for(let c=command.length-1;c>=0;c--) {
				try {
					if(command[c](splits[0],splits[1]))
						return;
				} catch (err) {
					console.log("\n"+err.stack+"\n");
					return;
				}
			}
			console.log("Unknown command: "+splits[0]);
		}
	});
	// end console interface section
}
