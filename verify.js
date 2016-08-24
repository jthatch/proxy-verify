#!/usr/bin/env node
/**
 * verify.js takes a list of HTTP proxies and will attempt to establish a connection to a target site using each proxy.
 * The proxies that successfully connect and enable you to hide your own IP/Host will be saved.
 *
 * You can specify the unverified proxies as either the path to a single file, or a directory containing multiple files.
 * The script expects the file(s) to contain proxies in the below format:
 * ip:port
 *
 * Installation:
 * Copy verify.js into it's own directory then run:
 * > npm install
 * > chmod +x verify.js
 *
 * Basic usage:
 *
 * ./verify.js -i proxies.txt -o proxies_verified.txt
 * Will read a the input proxies from the file proxies.txt and save verified proxies to proxies_verified.txt
 *
 * ./verify.js -i proxies/ -o proxies_verified.txt -u "http://digg.com"
 *
 *
 * (c) jthatch http://github.com/jthatch
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

'use strict';

const fs = require('fs');
const util = require('util');
const path = require('path');
const cluster = require('cluster');
const EventEmitter = require('events').EventEmitter;

const request = require('request');
const chalk = require('chalk');
const moment = require('moment');

/**
 * This follows the observer design pattern. We take arguments first from options, then argv then resort to defaults
 * @constructor
 */
function Verify(options) {
    options = options || {};
    // the url we'll use to verify the proxies
    this.url = options.url || "http://digg.com/";
    // number of instances of program to run
    this.workers = options.workers || require('os').cpus().length;
    // number of HTTP requests. Setting this too high might give false positives to broken proxies
    this.concurrentRequests = options.concurrentRequests || 12;
    // can be either a file path or a directory path containing files
    this.inputFile = options.inputFile ||
        process.cwd() + '/proxies/fetched/fetched_proxies_{date}.txt'.replace(/\//g, path.sep);
        //process.cwd() + '/proxies/fetched/'.replace(/\//g, path.sep);
    // where we store the verified proxies
    this.outputFile = options.outputFile ||
        process.cwd() + '/proxies/verified/verified_proxies_{date}.txt'.replace(/\//g, path.sep);
        //process.cwd() + "/proxies/verfied/verified_all.txt".replace(/\//g, path.sep);
    // the timeout before we cancel the request
    this.requestTimeout = options.requestTimeout || 5e3;
    // show extra debug info
    this.verbose = options.verbose || false;

    // hard limit, feel free to remove this, but I find anymore than 4 is overkill
    if (this.workers > 4)
        this.workers = 4;

    // No point having workers that do nothing, so set the no. of concurrent requests to match the no. of workers
    if (this.workers > this.concurrentRequests)
        this.concurrentRequests = this.workers;

    // internal variables
    this._proxies = [];
    this._verifiedProxies = [];
    this._workersFinished = 0;
    this._stats = {
        good : 0,
        bad : 0,
        total: 0,
        done : 0
    }
    this._startTime = new Date().getTime();

    EventEmitter.call(this);
}

Verify.prototype.main = function() {
    var _this = this;

    /**
     * Master, responsible for pulling the list of media from the 4chan thread and spinning up and directing workers
     */
    if (cluster.isMaster) {

        _this.log("c:blue", "Verifying proxies using ", "c:blue bold", this.url,
            "c:blue", " with ", "c:blue bold", this.workers, "c:blue", " workers and ",
            "c:blue bold", this.concurrentRequests, "c:blue", " concurrent requests.");

        if (this.verbose)
            this.showOptions();

        // spawn our worker threads immediately as this is non-blocking but takes a little while
        for (var i = 0; i < this.workers; i++) {
            cluster.fork();
        }

        // receive messages from our worker threads, specifically when they've finished downloading a media file
        Object.keys(cluster.workers).forEach(function (id) {
            _this.log("c:blue", "worker ", "c:blue bold", '#' + id, "c:blue", ' is online');

            cluster.workers[id].on('message', function (msg) {
                if (msg.cmd) {
                    switch (msg.cmd) {
                        case 'verifiedProxy':
                            var data = msg.data;
                            _this._stats.done++;
                            var total = (_this._stats.done / _this._stats.total * 100).toFixed(0);

                            // good proxy
                            if (!data.error) {
                                _this._verifiedProxies.push(data.proxy);
                                _this._stats.good++;

                                _this.log("c:gray bold", total + '% ', "c:green", "\u2714 ", "c:green bold", data.proxy,
                                    "c:green", " in " + _this.runTime(data.duration), (_this.verbose ? chalk.gray.bold(' ' +
                                        JSON.stringify(data.response.headers).replace(/":"/g, ",")
                                            .replace(/"/g, '')
                                            .replace(/\{/g, '')
                                            .substr(0, 100))
                                        : '')
                                );
                            }
                            else {
                                _this._stats.bad++;
                                _this.log("c:gray bold", total + '% ', "c:red", "\u2716 ", "c:red bold", data.proxy,
                                    "c:red", " error ", "c:red bold", data.error.code,
                                    "c:red", " in " + _this.runTime(data.duration));
                            }
                            _this.dispatchRequest(id);
                            break;
                    }
                }
            });
        });

        // bind our callbacks
        _this.on('readProxies', function(proxies){_this.startWorkers(proxies)});

        // now initate the first function to read our proxies
        if (!this.readProxies())
            process.exit();

    }
    // worker
    else {
        // receive messages from master
        process.on('message', function(msg) {
            if (msg.cmd) {
                switch(msg.cmd) {
                    case 'verifyProxy':
                        _this.verifyProxy(msg.data);
                        break;
                    case 'shutdown':
                        process.disconnect();
                        break;
                    default:
                        _this.log('Invalid msg: ' + msg.cmd + ': ' + JSON.stringify(msg.data));
                        break;
                }
            }
        });

        this.on('goodProxy', function (data) {
            _this.broadcastToMaster('goodProxy', data);
        });
        this.on('badProxy', function (data) {
            _this.broadcastToMaster('badProxy', data);
        });

    }
};

/**
 * Start handing out proxies to the workers. As they complete their request they'll automatically be given the next
 * until there's no proxies left to verify
 * @param proxies
 */
Verify.prototype.startWorkers = function(proxies) {
    var _this = this;

    this._proxies = proxies;
    this._stats.total = proxies.length;

    var lastWorker = 1;
    var requestsInProgress = 0;
    while ( ( requestsInProgress < this.concurrentRequests ) && this._proxies.length ) {
        var proxy = this._proxies.shift();
        lastWorker = lastWorker > this.workers ? 1 : lastWorker;
        this.broadcastToWorkers(lastWorker++, 'verifyProxy', proxy);

        requestsInProgress++;
    }
};

/**
 * Attempts to establish a connection to the remote host using the proxy.
 * @emit verifyProxy (proxy, error, response, duration)
 * @param proxy
 */
Verify.prototype.verifyProxy = function(proxy) {
    var _this = this;
    var startTime = new Date().getTime();

    request({
        method: 'GET',
        proxy: 'http://' + proxy,
        timeout : _this.requestTimeout,
        headers: {
            "User-Agent":_this.userAgent()
        },
        url: _this.url
    }, function (error, response) {
        _this.broadcastToMaster('verifiedProxy', {proxy: proxy, error: error, response: response, duration: startTime});
    });
};

/**
 * Dispatch a download to a particular worker assuming there's any proxies left
 * @param id
 */
Verify.prototype.dispatchRequest = function(id) {
    var _this = this;

    // If we still have proxies available to verify, send them to the worker id
    if (this._proxies.length) {
        var proxy = this._proxies.shift();
        this.broadcastToWorkers(id, 'verifyProxy', proxy);
    }
    else {
        if (++this._workersFinished >= Math.min(this.concurrentRequests, this._stats.total)) {
            this.broadcastToWorkers(false, 'shutdown');
            this._workersFinished = 0;
            _this.log();
            _this.log("c:blue", "Process Complete. Processed ", "c:blue bold", _this._stats.total, "c:blue", " proxies " +
                "in ", "c:blue bold", _this.runTime());
            _this.log("c:green bold", _this._stats.good, "c:green", " proxies verified (",
                "c:green bold", (_this._stats.good / _this._stats.total * 100).toFixed(2) + '%', "c:green", ')');

            this.saveProxies();
        }
    }
};

/**
 * Read proxies from a file or directory, remove duplicates and validate
 * @emit readProxies (proxies)
 * @returns {boolean}
 */
Verify.prototype.readProxies = function() {
    var _this = this;

    // if we find the variable {date} we'll replace it with todays date in the format dd-mm-yyyy
    this.inputFile = String(this.inputFile).replace("{date}", moment().format('DD-MM-YYYY'));

    if (!fs.existsSync(this.inputFile)) {
        this.log("c:bgRed", "error: unable to read: " + this.inputFile);
        return false;
    }

    var stats = fs.statSync(this.inputFile);

    var files = [];
    var proxies = [];
    var readFile = function(fileName) {
        proxies.push.apply(proxies, fs.readFileSync(fileName).toString('utf8').split('\n'));
    };

    // Single file mode
    if (stats.isFile()) {
        readFile(this.inputFile);
    }
    // Read a directory using sync. This will lock the program until the files have been read.
    // Not such an issue for command line scripts
    else {
        var files = fs.readdirSync(this.inputFile);
        files = files.filter(function (file) {
            if (file[0] != '.') {
                return file;
            }
        });
        files.map(function (file) {
            var fileName = _this.inputFile + file;
            readFile(fileName);
        });
    }

    // validate proxies using ip:port
    proxies = proxies.filter(function(proxy) {
        proxy = proxy.trim();
        if (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\:[0-9]{1,5}$/.test(proxy))
            return proxy;
    });

    if (stats.isFile())
        _this.log("c:blue", "Found ", "c:blue bold", proxies.length, "c:blue", " proxies in ", "c:blue bold", this.inputFile);
    else
        _this.log("Found ", "c:green bold", proxies.length, " proxies in ", "c:green bold",  files.length, " files: ", files.join(', '));

    var oldTotal = proxies.length;
    // now filter duplicates
    proxies = proxies.filter(function(proxy, index, self) {
        return index == self.indexOf(proxy);
    });
    if (oldTotal - proxies.length > 0) {
        _this.log("Removing duplicates, found ", "c:blue bold", (oldTotal - proxies.length), " duplicates");
    }

    this.emit('readProxies', proxies);
    return true;
};

/**
 * Saves the verified proxies to the outputFile
 */
Verify.prototype.saveProxies = function() {
    var _this = this;
    this.outputFile = String(this.outputFile).replace("{date}", moment().format('DD-MM-YYYY'));
    fs.writeFileSync(this.outputFile, this._verifiedProxies.join("\n"), "utf8");
    this.log("c:blue", "Saved verified proxies to ", "c:blue bold", this.outputFile);
};


Verify.prototype.showOptions = function() {
    var _this = this;
    console.log('url: ' + this.url);
    console.log('workers: ' + this.workers);
    console.log('concurrentRequests: ' + this.concurrentRequests);
    console.log('inputFile: ' + this.inputFile);
    console.log('outputFile: ' + this.outputFile);
};


/**
 * broadcastToWorkers - if an id is defined we send the payload to only that worker, otherwise it gets broadcasted to all.
 * Returns the number of messages broadcast
 * @param bool|int id
 * @param string
 * @param array|object data
 * @return int
 */
Verify.prototype.broadcastToWorkers = function(id, cmd, data){
    var count = 0;
    // send to a selected worker
    if (id && typeof cluster.workers[id] !== 'undefined') {
        cluster.workers[id].send({ cmd: cmd, data: data });
        count++;
    }
    else {
        // send to all workers
        Object.keys(cluster.workers).forEach(function(id){
            cluster.workers[id].send({cmd : cmd, data : data});
            count++;
        });
    }
    return count;
};

/**
 * broadcastToMaster sends a payload back to our master thread
 * @param array|object payload
 */
Verify.prototype.broadcastToMaster = function(cmd, data) {
    process.send({ cmd: cmd, data: data });
};


/**
 * I like nice looking log output
 * Little log function to take advantage of ansi colours on the CL.
 * Takes as many arguments as you want, they'll be joined together to form the log string.
 * If you want to style start an argument with c: and then your colour(s) e.g.
 * this.log('c:bgGreen bold', 'This is bold text with a green background');
 */
Verify.prototype.log = function() {
    var args = Array.prototype.slice.call(arguments);
    var msg = '';
    var skipNext = false;
    for (var i = 0; i < args.length; i++) {
        var arg = typeof args[i] == 'object' ? JSON.stringify(args[i]) : String(args[i]),
            next = typeof args[i] == 'object' ? JSON.stringify(args[i + 1]) : String(args[i + 1]);

        if (skipNext) {
            skipNext = false;
            continue;
        }

        if (arg && arg.substr(0,2) == 'c:') {
            var color = arg.substr(2, arg.length);
            color = color.split(' ');
            if (color.length == 1)
                msg += chalk[color[0]](next);
            else if (color.length == 2)
                msg += chalk[color[0]][color[1]](next);
            else if (color.length == 3)
                msg += chalk[color[0]][color[1]][color[2]](next);
            skipNext = true;
        }
        else {
            msg += arg;
            skipNext = false;
        }
    }

    var str = this.runTime() + chalk.grey('> ');
    var noAnsi = str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    var padding = Array(12).join(' ');
    var maxLength = 12;

    console.log(str + padding.substring(0, maxLength - noAnsi.length) + msg);
};

/**
 * Returns the duration
 * @param (optional) startTime
 * @returns {string}
 */
Verify.prototype.runTime = function(startTime) {
    var millisecondDiff = new Date().getTime() - (typeof startTime !== 'undefined' ? startTime : this._startTime);

    var elapsed = {
        'days' : 0,
        'hours' : 0,
        'mins' : 0,
        'secs' : 0,
        'ms' : millisecondDiff
    };
    if (millisecondDiff > 0) {
        elapsed.ms = millisecondDiff % 1e3;
        millisecondDiff = Math.floor( millisecondDiff / 1e3 );
        elapsed.days = Math.floor( millisecondDiff / 86400 );
        millisecondDiff %= 86400;
        elapsed.hours = Math.floor ( millisecondDiff / 3600 );
        millisecondDiff %= 3600;
        elapsed.mins = Math.floor ( millisecondDiff / 60 );
        millisecondDiff %= 60;
        elapsed.secs = Math.floor( millisecondDiff  );
    }
    var showMs = true;
    var str = '';
    if (elapsed.days > 0) {
        str += chalk.bold(elapsed.days) +'d ';
        showMs = false;
    }
    if (elapsed.hours > 0) {
        str += chalk.bold(elapsed.hours) + 'h ';
        showMs = false;
    }
    if (elapsed.mins > 0) {
        str += chalk.bold(elapsed.mins) + 'm ' ;
    }
    if (( elapsed.secs > 0 && showMs ) || ( elapsed.secs == 0 && elapsed.ms > 0 ) ) {
        str += chalk.bold(elapsed.secs) + '.' + chalk.bold(elapsed.ms) + 's';
    }
    else {
        str += chalk.bold(elapsed.secs) + 's';
    }
    return str;

};


Verify.prototype.userAgent = function() {
    var agents = [
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/46.0.2490.80 Safari/537.36',
        'Mozilla/5.0 (Linux; Android 4.4.2; SM-G900I Build/KOT49H) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/30.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/52.0.0.12.18;]',
        'Mozilla/5.0 (Linux; Android 4.2.2; en-za; SAMSUNG GT-I9190 Build/JDQ39) AppleWebKit/535.19 (KHTML, like Gecko) Version/1.0 Chrome/18.0.1025.308 Mobile Safari/535.19',
        'Mozilla/5.0 (Linux; Android 5.1.1; SM-N910G Build/LMY47X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/46.0.2490.76 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; Android 4.4.2; en-za; SAMSUNG SM-G800H Build/KOT49H) AppleWebKit/537.36 (KHTML, like Gecko) Version/1.6 Chrome/28.0.1500.94 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; Android 4.4.2; HS-U961 Build/KOT49H) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/30.0.0.0 Mobile Safari/537.36',
        'Mozilla/5.0 (iPad; CPU OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1',
        'Mozilla/5.0 (Linux; U; Android 4.4.4; ko-kr; SHV-E210K/KTUKOB1 Build/KTU84P) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
        'Mozilla/5.0 (Linux; Android 5.0; E2303 Build/26.1.A.2.167) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/39.0.2171.93 Mobile Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 8_4_1 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) GSA/9.0.60246 Mobile/12H321 Safari/600.1.4',
        'Opera/9.80 (Android; Opera Mini/7.5.34817/37.7011; U; en) Presto/2.12.423 Version/12.16',
        'Mozilla/5.0 (Linux; Android 5.0; SAMSUNG SM-G900I Build/LRX21T) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/34.0.1847.76 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; Android 4.4.2; Retro Build/KOT49H) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/30.0.0.0 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; U; Android 4.1.1; en-us; SGH-T889 Build/JRO03C) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30'
    ];

    return agents[ Math.floor( Math.random() * agents.length ) ];
};


util.inherits(Verify, EventEmitter);

// if we are being run as a command line app, execute our program
if (process.argv[1] == __filename) {
    var program = require("commander");
    program
        .version("0.0.1")
        .usage("[options] <keywords>")
        .option("-i, --input [input]", "Input file with proxies each on a new line, can be either a file or a directory containing files")
        .option("-o, --output [output]", "Output file for verified proxies.")
        .option("-a, --all", "Shortcut to set input to be a directory, defaults to ./proxies/fetched/")
        .option("-u, --url [url]", "The url to make the requests to")
        .option("-w, --workers [workers]", "The number of workers to use")
        .option("-c, --requests [requests]", "The number of concurrent requests to make. Try to make it multiple of workers")
        .option("-t, --timeout [timeout]", "Timeout in ms before to kill the socket")
        .option("-v, --verbose", "Show verbose output")
        .parse(process.argv);

    var opts = {};
    if (program.all) {
        opts.inputFile = process.cwd() + '/proxies/fetched/'.replace(/\//g, path.sep);
        opts.outputFile = process.cwd() + '/proxies/verified/verified_all.txt'.replace(/\//g, path.sep);
    }
    if (program.input)
        opts.inputFile = program.input;
    if (program.output)
        opts.outputFile = program.output;
    if (program.url)
        opts.url = program.url;
    if (program.workers)
        opts.workers = program.workers;
    if (program.requests)
        opts.concurrentRequests = program.requests;
    if (program.timeout)
        opts.requestTimeout = program.timeout;
    if (program.verbose)
        opts.verbose = program.verbose;

    var verify = new Verify(opts);
    verify.main();
}
else {
    module.exports = new Verify();
}
