import 'colors'
import {createHash} from 'crypto'
import * as stream from 'stream';
import * as https from 'https'
import * as http from 'http'
import * as net from 'net'
import * as zlib from 'zlib'
import * as fs from 'fs'
import * as WebSocket from 'ws'
import {Command} from 'commander'


const VER = require('../package.json').version
const BOT_UA = 'freecdn-update-svc/' + VER

const MANIFEST_DEFAULT_PATH = '/freecdn-manifest.txt'
const MANIFEST_MAX_SIZE = 1024 * 1024 * 5

const MAX_SITE_NUM = 10000
const MAX_FAIL_NUM = 5
const MAX_CHECK_PRE_PERIOD = 1

const log = console.log
let mVerbose: boolean


class Site {
  public readonly origin: string

  private readonly clients = new Set<WebSocket>()
  private manifestHash: Buffer | null = null
  private etag = ''
  private lastModified = ''

  private readonly reqOpt: http.RequestOptions = {
    path: MANIFEST_DEFAULT_PATH,
    timeout: 1000 * 5,
  }
  private readonly reqFn = https.request
  private req: http.ClientRequest | null = null

  public idleTimes = 0
  public checkNum = 0
  public failed = false
  public failNum = 0


  public constructor(manifestUrl: URL) {
    this.origin = manifestUrl.origin

    if (manifestUrl.protocol === 'https:') {
      this.reqOpt.port = +manifestUrl.port || 443
    } else {
      this.reqOpt.port = +manifestUrl.port || 80
      this.reqFn = http.request
    }
    if (manifestUrl.pathname !== '/') {
      this.reqOpt.path = manifestUrl.pathname
    }
    this.reqOpt.hostname = manifestUrl.hostname
  }

  public add(ws: WebSocket) {
    this.clients.add(ws)
  }

  public del(ws: WebSocket) {
    this.clients.delete(ws)
  }

  public empty() {
    return this.clients.size === 0
  }

  public close() {
    for (const ws of this.clients) {
      ws.close()
    }
    if (this.req !== null) {
      this.req.destroy(Error('exit'))
    }
  }

  public update() {
    if (this.req !== null) {
      return
    }
    const req = this.reqFn(this.reqOpt, res => {
      this.parseResponse(res)
    })
    req.on('error', err => {
      mVerbose && log(this.origin, 'req err:', err.message)
      this.req = null
      this.failed = true
      req.destroy()
    })
    req.on('timeout', () => {
      req.destroy(Error('timeout'))
    })

    if (this.etag) {
      req.setHeader('if-none-match', this.etag)
    } else if (this.lastModified) {
      req.setHeader('if-modified-since', this.lastModified)
    }
    req.setHeader('user-agent', BOT_UA)
    req.setHeader('accept-encoding', 'gzip, br')
    req.end()

    this.req = req
  }

  private parseResponse(res: http.IncomingMessage) {
    let ostream: stream.Readable = res

    switch (res.statusCode) {
    case 200:
      var sha256 = createHash('sha256')
      this.etag = res.headers['etag'] || ''
      this.lastModified = res.headers['last-modified'] || ''

      mVerbose && log(this.origin,
        'etag:', this.etag.green, 'last-modified:', this.lastModified.green)

      switch (res.headers['content-encoding']) {
      case 'gzip':
        ostream = res.pipe(zlib.createGunzip())
        break
      case 'br':
        ostream = res.pipe(zlib.createBrotliDecompress())
        break
      }
      break
    case 304:
      break
    default:
      this.failed = true
      break
    }

    let size = 0

    ostream.on('data', (chunk: Buffer) => {
      if (!sha256) {
        return
      }
      if ((size += chunk.length) > MANIFEST_MAX_SIZE) {
        mVerbose && log(this.origin, 'size exceeded')
        res.destroy()
        return
      }
      sha256.update(chunk)
    })
    ostream.on('end', () => {
      this.req = null
      if (!sha256) {
        return
      }
      const hash = sha256.digest()
      this.parseHash(hash)
    })
    ostream.on('error', err => {
      mVerbose && log(this.origin, 'stream err:', err.message)
      this.req = null
      this.failed = true
      res.destroy()
    })
  }

  private parseHash(hash: Buffer) {
    if (!this.manifestHash) {
      // first time
      this.manifestHash = hash
      return
    }
    if (this.manifestHash.compare(hash) === 0) {
      // no change
      return
    }
    this.manifestHash = hash

    for (const ws of this.clients) {
      ws.send(hash)
    }
    console.log(`${this.origin} updated`)
  }
}


const mOriginSiteMap = new Map<string, Site>()
const mIdleSiteSet = new Set<Site>()

function getSite(manifestUrl: URL) {
  let site = mOriginSiteMap.get(manifestUrl.origin)
  if (site) {
    if (site.idleTimes !== 0) {
      site.idleTimes = 0
      site.update()
      mIdleSiteSet.delete(site)
      mVerbose && log(site.origin, 'resume')
    }
    return site
  }

  // clear cache
  if (mOriginSiteMap.size === MAX_SITE_NUM) {
    if (mIdleSiteSet.size === 0) {
      mVerbose && log('MAX_SITE_NUM reached')
      return
    }
    for (const site of mIdleSiteSet) {
      site.close()
      mOriginSiteMap.delete(site.origin)
    }
    mIdleSiteSet.clear()
  }

  site = new Site(manifestUrl)
  site.update()
  mOriginSiteMap.set(manifestUrl.origin, site)
  return site
}

function checkUpdateManually(query: string) {
  const m = query.match(/site=([^&]+)/)
  if (!m) {
    return
  }
  const origin = decodeURIComponent(m[1])
  const site = mOriginSiteMap.get(origin)
  if (!site || site.checkNum === MAX_CHECK_PRE_PERIOD) {
    return
  }
  mVerbose && log(site.origin, 'check manually')
  site.checkNum++
  site.update()
}

function checkUpdatePeriodly() {
  for (const site of mOriginSiteMap.values()) {
    if (site.empty()) {
      if (site.idleTimes++ === 0) {
        mIdleSiteSet.add(site)
        mVerbose && log(site.origin, 'pause')
      }
      continue
    }
    if (site.failed) {
      if (site.failNum === MAX_FAIL_NUM) {
        mVerbose && log(site.origin, 'too many errors')
        site.close()
        mOriginSiteMap.delete(site.origin)
        continue
      }
      site.failNum++
      site.failed = false
    } else {
      site.failNum = 0
    }
    site.update()
    site.checkNum = 0
  }
}

function welcome(ws: WebSocket, manifestUrl: URL, addr: string) {
  const site = getSite(manifestUrl)
  if (!site) {
    ws.close()
    return
  }
  site.add(ws)

  console.log(site.origin, 'add'.green, addr)

  ws.onmessage = () => {
    mVerbose && log(site.origin, addr, 'unexrpected msg')
    ws.close()
  }
  ws.onclose = () => {
    console.log(site.origin, 'del'.yellow, addr)
    site.del(ws)
  }
  ws.onerror = err => {
    mVerbose && log(site.origin, addr, 'ws err:', err.message)
  }
}

function getPathAndQuery(url: string) {
  const pos = url.indexOf('?')
  if (pos === -1) {
    return [url, '']
  }
  return [url.substr(0, pos), url.substr(pos + 1)]
}

function getClientAddr(req: http.IncomingMessage) {
  const addr = req.headers['x-client-addr']
  if (addr) {
    return addr as string
  }
  const port = req.socket.remotePort
  const ip = req.socket.remoteAddress
  if (!ip) {
    return '?'
  }
  return ip.replace(/^::ffff:/, '') + ':' + port
}

function parseReqOrigin(origin: string) {
  if (!origin) {
    return
  }
  try {
    var url = new URL(origin)
  } catch (err) {
    return
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return
  }
  if (url.pathname !== '/') {
    return
  }
  return url
}

function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const [path, query] = getPathAndQuery(req.url || '')

  switch (path) {
  case '/update':
    checkUpdateManually(query)
    res.end()
    break
  default:
    res.end('freecdn update service')
    return
  }
}

const mWss = new WebSocket.Server({ noServer: true })

function checkManifestPath(path: string) {
  [path] = getPathAndQuery(path)
  return /\.(?:txt|conf)$/.test(path)
}

function onUpgrade(req: http.IncomingMessage, sock: net.Socket, head: Buffer) {
  const addr = getClientAddr(req)
  const url = parseReqOrigin(req.headers.origin || '')
  if (!url) {
    mVerbose && log('invalid origin:', req.headers.origin, addr)
    sock.destroy()
    return
  }

  const [path, query] = getPathAndQuery(req.url || '')
  if (query) {
    // custom manifest path
    const m = query.match(/manifest=([^&]+)/)
    if (m) {
      const manifestPath = decodeURIComponent(m[1])
      if (checkManifestPath(manifestPath)) {
        url.pathname = manifestPath
      } else {
        mVerbose && log('invalid manifest path:', manifestPath, addr)
      }
    }
  }

  mWss.handleUpgrade(req, sock, head, ws => {
    welcome(ws, url, addr)
  })
}

function main(args: any) {
  const timer = +args.timer * 1000
  if (!(timer > 0)) {
    console.error('timer must be greater than 0')
    return
  }
  mVerbose = !!args.verbose

  let svr: http.Server | https.Server

  if (args.ssl) {
    if (!args.key) {
      console.error('missing `key` argument')
      return
    }
    if (!args.cert) {
      console.error('missing `cert` argument')
      return
    }
    svr = https.createServer({
      key: fs.readFileSync(args.key),
      cert: fs.readFileSync(args.cert),
    })
  } else {
    svr = http.createServer()
  }

  if (args.socket) {
    if (fs.existsSync(args.socket)) {
      fs.rmSync(args.socket)
    }
    svr.listen(args.socket, () => {
      const addr = svr.address() as string
      console.log('listen', addr.green)
    })
  } else {
    svr.listen(+args.port, args.address, () => {
      const addr = svr.address() as net.AddressInfo
      console.log('listen', addr.address + ':' + String(addr.port).green)
    })
  }

  svr.on('request', onRequest)
  svr.on('upgrade', onUpgrade)
  svr.on('error', err => {
    console.error(err.message)
    clearInterval(tid)
  })

  const tid = setInterval(checkUpdatePeriodly, timer)
  let quit = false

  process.on('SIGINT', () => {
    if (quit) {
      console.log('force quit'.red)
      process.exit(2)
    }
    console.log('quit...'.yellow)
    quit = true

    svr.close()
    for (const site of mOriginSiteMap.values()) {
      site.close()
    }
    clearInterval(tid)
  })
}

new Command()
  .option('-p, --port <port>', 'Port to listen', '30000')
  .option('-a, --address <address>', 'Address to listen', '0.0.0.0')
  .option('-s, --socket <path>', 'Unix socket to listen')
  .option('-K, --key <path>', 'Path to ssl key file')
  .option('-C, --cert <path>', 'Path to ssl cert file')
  .option('-S, --ssl', 'Enable https')
  .option('-t, --timer <timer>', 'Check timer', '60')
  .option('--verbose', 'Verbose mode')
  .action(args => {
    try {
      main(args)
    } catch (err) {
      console.error(err.message)
      process.exit(1)
    }
  })
  .version(VER)
  .parse(process.argv)
