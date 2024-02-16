const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

function parseBool(value, defaultValue) {
  const lowerValue = new String(value || defaultValue).toLowerCase().trim();
  const trueValues = ['1', 'true', 't'];
  const falseValues = ['0', 'false', 'f'];
  if (trueValues.includes(lowerValue)) {
    return true;
  }
  else if (falseValues.includes(lowerValue)) {
    return false;
  }
  else {
    throw new Error(`Invalid bool value: ${value}`);
  }
}

const CACHE_PATH = process.env.CACHE_PATH || '/tmp/prerender-cache';
const CACHE_TTL = process.env.CACHE_TTL || 3600;
const CACHE_REMOVE_EXPIRED_ON_STARTUP = parseBool(process.env.CACHE_REMOVE_EXPIRED_ON_STARTUP, true);

function log(...args) {
  if (process.env.DISABLE_LOGGING) {
    return;
  }
  console.log(new Date().toISOString(), ...args);
}

async function ensureDirExists(dirPath) {
  try {
    await fs.access(dirPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.mkdir(dirPath, { recursive: true });
    } else {
      throw error;
    }
  }
}

async function removeDirectoryIfEmpty(dirPath) {
  try {
    const files = await fs.readdir(dirPath);
    if (files.length === 0) {
      await fs.rmdir(dirPath);
    }
  } catch (error) {
    if (error.code !== 'ENOTEMPTY') {
      log(`ERROR while removing directory ${dirPath}`, error);
    }
  }
}


class URLFileSystemCache {
  /**
   * Cache responses of HTTP requests on filesystem using SHA1 to hash URLs
   */
  constructor({ cachePath, ttl }) {
    this.cachePath = cachePath;
    this.ttl = ttl;
    this.startCleanupRoutine();
  }

  startCleanupRoutine() {
    setInterval(
      () => { this.cleanUpCacheDirectory(this.cachePath); },
      this.ttl * 1000
    );
  }

  async cleanUpCacheDirectory(dirPath) {
    try {
      await fs.access(dirPath);
    } catch (error) {
      if (error.code == "ENOENT") {
        return;  // Does not exist
      }
    }

    try {
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      for (const file of files) {
        const filePath = path.join(dirPath, file.name);
        if (file.isDirectory()) {
          await this.cleanUpCacheDirectory(filePath); // Recursive cleaning
        } else {
          if (await this.expiredTtl(filePath)) {
            try {
              await fs.unlink(filePath);
            } catch (error) {
              log(`ERROR while removing expired cache file ${filePath}`, error);
            }
          }
        }
      }
      if (dirPath !== this.cachePath) {
        await removeDirectoryIfEmpty(dirPath);
      }
    } catch (error) {
      log('ERROR cleaning cache directory', error);
    }
  }

  filenameForUrl(url) {
    const urlHash = this.urlHash(url)
    // Using another directory inside `this.cachePath` to avoid having millions of files in the same directory
    return path.join(this.cachePath, urlHash.substring(0, 2), urlHash);
  }

  async set(url, statusCode, headers, value) {
    const filename = this.filenameForUrl(url);
    const metadata = { statusCode, headers };
    const compressedValue = await gzip(value);

    await ensureDirExists(path.dirname(filename));
    await fs.writeFile(filename + '.data', compressedValue);
    await fs.writeFile(filename + '.meta', JSON.stringify(metadata));

    // Schedule file deletion so we save space
    setTimeout(() => this.removeExpiredCache(url), this.ttl * 1000);
  }

  async expiredTtl(filePath) {
    const { mtime } = await fs.stat(filePath);
    const modificationDate = new Date(mtime);
    const lastModificationSeconds = (new Date() - modificationDate) / 1000;
    return lastModificationSeconds >= this.ttl;
  }

  async get(url) {
    const filename = this.filenameForUrl(url);
    try {
      await fs.access(filename + '.data');
      await fs.access(filename + '.meta');
    } catch (error) {
      return null;
    }
    if (await this.expiredTtl(filename + '.meta')) {
      await fs.unlink(filename + '.meta');
      await fs.unlink(filename + '.data');
      return null;
    }

    try {
      const compressedContent = await fs.readFile(filename + '.data');
      const content = await gunzip(compressedContent);
      const metadata = JSON.parse(await fs.readFile(filename + '.meta', 'utf8'));
      return { ...metadata, content };
    } catch (error) {
      return null;
    }
  }

  urlHash(url) {
    return crypto.createHash('sha1').update(url).digest('hex');
  }

  async removeExpiredCache(url) {
    const filename = this.filenameForUrl(url);
    try {
      await fs.unlink(filename + '.data');
      await fs.unlink(filename + '.meta');
      await removeDirectoryIfEmpty(path.dirname(filename));
    } catch (error) {
      log(`ERROR while removing expired cache for ${url}`, error);
    }
  }

}

module.exports = {
  init: function() {
    ensureDirExists(CACHE_PATH);
    this.cache = new URLFileSystemCache({ cachePath: CACHE_PATH, ttl: CACHE_TTL });
    if (CACHE_REMOVE_EXPIRED_ON_STARTUP) {
      log('Removing expired cache files');
      this.cache.cleanUpCacheDirectory(CACHE_PATH);
    }
  },
  requestReceived: async function(req, res, next) {
    if (req.method !== 'GET') {
      return next();
    }
    const cachedResponse = await this.cache.get(req.prerender.url);
    if (!cachedResponse) {
      return next();
    }
    log('Serving from cache:', req.prerender.url);
    req.fromCache = true;
    Object.entries(cachedResponse.headers).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    return res.send(cachedResponse.statusCode, cachedResponse.content);
  },
  beforeSend: async function(req, res, next) {
    if (req.prerender.statusCode === 200 && !req.fromCache) {
      log('Caching:', req.prerender.url);
      await this.cache.set(req.prerender.url, req.prerender.statusCode, req.prerender.headers, Buffer.from(req.prerender.content));
    }
    return next();
  }
};
