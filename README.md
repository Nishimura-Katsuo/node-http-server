# node-http-server
A simple web server built with node/express and support for script urls (*.sss)

Features:
 - URLs served with .sss extension run a script and serve the result
 - Maintains 'require' compatibility so scripts can be as familiar as possible
 - Automatically restarts itself without using 'forever' or similar module
 - Based on 'express' and 'compression' npm packages for competitive performance to apache
