proxy-verify
================

verify.js takes a list of HTTP proxies and will attempt to establish a connection to a target site using each proxy. The proxies that successfully connect and eable you to hide your own IP will be saved.

You can specify the unverified proxies as either the path to a single file, or a directory containing multiple files. The script expects the file(s) to contain proxies in the below format:  
`127.0.0.1:8080` -- ip:port, each on a new line.

verify-proxy is written and maintained by [jthatch](https://github.com/jthatch).

![verify.js screenshot](http://wireside.co.uk/verify-screenshot.png)

## Installation
verify.js requires NodeJS and NPM, both of which are available via your default package manager, e.g. apt-get or yum. To install with a few commands, open a terminal and enter the following:
```
git clone https://github.com/jthatch/verify-proxy.git  
cd verify-proxy
npm install
```

## Notes
verify.js is built to work alongside a proxy fetcher I am also writing. The fetch script stores unverified proxies in the following folder format: ./proxies/fetched/fetched_DD_MM_YYYY.txt  
By default it will attempt to look for a file in that directory with todays date, however you can easilly override the input file using the -i flag as shown below.

## Usage
verify.js should automatically be marked as executable, if not enter chmod +x verify.js

`./verify.js -i proxies.txt`
-- To verify the proxies listed in a file called proxies.txt.


## Real World Examples
Takes a bunch of proxies in proxies.txt verifies them against yahoo.com and saves the good ones to  proxies_good.txt
`./verify.js -i proxies.txt -o proxies_good.txt -u "http://yahoo.com"`


