const crypto = require('crypto');
const syncFs = require('fs');
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const CACHE_PATH = process.env.CACHE_PATH || '/tmp/prerender-cache';
const CACHE_TTL = process.env.CACHE_TTL || 3600;

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
    this.startCleanup();
  }

  startCleanup() {
    try {
      syncFs.access(this.cachePath);
      setTimeout(async () => { await this.cleanUpCacheDirectory(this.cachePath); }, 0);
    } catch { // Directory does not exist
      log(`Creating cache directory ${this.cachePath}`);
      syncFs.mkdirSync(this.cachePath, { recursive: true });
    }
  }

  async cleanUpCacheDirectory(dirPath) {
    let totalRemovedFiles = 0;
    let totalRemovedSize = 0;
    let totalTimersCreated = 0;
    log('Removing expired cache files');

    const processDirectory = async (dir) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await processDirectory(fullPath);
          } else if (entry.name.endsWith(".data") || entry.name.endsWith(".meta")) {
            const stats = await fs.stat(fullPath);
            const expired = await this.isExpiredBasedOnMtime(stats.mtime);
            if (expired) {
              await this.removeExpiredCacheFile(fullPath);
              totalRemovedFiles += 1;
              totalRemovedSize += stats.size;
            } else {
              const ttlRemaining = this.ttl - ((new Date() - stats.mtime) / 1000);
              setTimeout(() => this.removeExpiredCacheFile(fullPath), ttlRemaining * 1000);
              totalTimersCreated += 1;
            }
          }
        }
        await removeDirectoryIfEmpty(dir);
      } catch (error) {
        log(`ERROR cleaning up directory: ${dir}`, error);
      }
    };
    await processDirectory(dirPath);
    log(`Removed ${totalRemovedFiles} files (${totalRemovedSize} bytes), scheduled ${totalTimersCreated} cache expire events`)
    return { totalRemovedFiles, totalRemovedSize, totalTimersCreated };
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

    // Schedule file deletion when TTL is reached
    setTimeout(() => this.removeExpiredCacheUrl(url), this.ttl * 1000);
  }

  async isExpiredBasedOnMtime(mtime) {
    const modificationDate = new Date(mtime);
    const lastModificationSeconds = (new Date() - modificationDate) / 1000;
    return lastModificationSeconds >= this.ttl;
  }

  async isFileExpired(filePath) {
    const { mtime } = await fs.stat(filePath);
    return this.isExpiredBasedOnMtime(mtime);
  }

  async get(url) {
    const filename = this.filenameForUrl(url);
    // First, check if both files exist
    try {
      await fs.access(filename + '.data');
      await fs.access(filename + '.meta');
    } catch (error) {
      return null;
    }
    // Then, check if this cache entry is expired
    if (await this.isFileExpired(filename + '.meta')) {
      await fs.unlink(filename + '.meta');
      await fs.unlink(filename + '.data');
      return null;
    }

    // Finally, read files and return the contents
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

  async removeExpiredCacheUrl(url) {
    const filename = this.filenameForUrl(url);
    try {
      await fs.unlink(filename + '.data');
      await fs.unlink(filename + '.meta');
      await removeDirectoryIfEmpty(path.dirname(filename));
    } catch (error) {
      log(`ERROR while removing expired cache for ${url}`, error);
    }
  }

  async removeExpiredCacheFile(filename) {
    try {
      await fs.unlink(filename);
      await removeDirectoryIfEmpty(path.dirname(filename));
    } catch (error) {
      log(`ERROR while removing expired cache for ${filename}`, error);
    }
  }

}

module.exports = {
  init: function() {
    ensureDirExists(CACHE_PATH);
    this.cache = new URLFileSystemCache({ cachePath: CACHE_PATH, ttl: CACHE_TTL });
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
