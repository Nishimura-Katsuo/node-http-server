# node-script-http
A simple web server built with node/express and support for script urls (*.sss)

Features:
 - URLs served with .sss extension run a script and serve the result
 - Maintains 'require' compatibility so scripts can be as familiar as possible
 - Automatically forks for each CPU, and restarts children that die
 - Based on 'express' and 'compression' npm packages for competitive performance to apache
 - Wonderful!!!
 - Has Beta
