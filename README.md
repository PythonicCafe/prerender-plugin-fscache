# prerender-plugin-fscache

File system cache plugin for [prerender](https://github.com/prerender/prerender/). Main features:

- Cache response status code, headers and gzipped content
- Cache filenames are URLs hashed (smaller and more concise than using the URL itself) saved in up to 256 sub
  directories to prevent slowdowns from having too many files in one directory
- Remove headers that should not be cached (like `Date`, `Age` etc. - see `nonCacheableHeaders`)
- Automatically remove stored files after TTL is reached (also executes a cleanup on startup)
- Cache only GET requests and some configurable status codes
- Won't retrieve file from cache if header `Cache-Control` has value `no-cache` (useful to pro-actively refresh the
  cached entry)

## Usage

Install the dependency:

```shell
npm install prerender-plugin-fscache
```

Load the plugin into your server:

```js
// server.js

const prerender = require("prerender");
const server = prerender();
server.use(require("prerender-plugin-fscache"));
server.start();
```

Run it with `node server.js` and then test it:

```shell
time wget http://localhost:3000/https://www.google.com/  # First one will time more time
time wget http://localhost:3000/https://www.google.com/  # Cached, should be quicker
```

## Settings (environment variables)

- `CACHE_PATH`: directory to save cached content (default: `/tmp/prerender-cache`)
- `CACHE_TTL`: time-to-live for each cached response, in seconds (default: `86400`)
- `CACHE_STATUS_CODES`: comma-separated list of response status codes allowed to be cached (only GET requests are
  cached, default: `200, 301, 302, 303, 304, 307, 308, 404`).
