import type { NextRequest } from 'next/server';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

// In-memory latency store per region -> upstream -> ms (EMA)
const regionalLatencyMs: Map<string, Map<string, number>> = new Map();
const EMA_ALPHA = 0.3;

const DEFAULT_UPSTREAMS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query',
  'https://dns.quad9.net/dns-query',
  'https://doh.opendns.com/dns-query',
  'https://dns.adguard.com/dns-query',
  'https://rubyfish.cn/dns-query'
];

function parseUpstreams(): string[] {
  const env = (process.env.DOH_UPSTREAMS || '').trim();
  if (!env) return DEFAULT_UPSTREAMS;
  return env
    .split(/[,\n\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(u => u.endsWith('/dns-query') || u.includes('?') ? u : (u.replace(/\/$/, '') + '/dns-query'));
}

function getRegionKey(req: NextRequest): string {
  // Prefer Vercel geolocation headers if present
  const country = req.headers.get('x-vercel-ip-country') || '';
  const region = req.headers.get('x-vercel-id') || '';
  // Fallback to Cloudflare style headers if present
  const cfCountry = req.headers.get('cf-ipcountry') || '';
  const key = country || cfCountry || region || 'GLOBAL';
  return key.toUpperCase();
}

function preferByLatency(regionKey: string, upstreams: string[]): string[] {
  const table = regionalLatencyMs.get(regionKey);
  if (!table) return upstreams.slice();
  return upstreams
    .slice()
    .sort((a, b) => (table.get(a) ?? Number.POSITIVE_INFINITY) - (table.get(b) ?? Number.POSITIVE_INFINITY));
}

function updateLatency(regionKey: string, upstream: string, observedMs: number): void {
  let table = regionalLatencyMs.get(regionKey);
  if (!table) {
    table = new Map();
    regionalLatencyMs.set(regionKey, table);
  }
  const prev = table.get(upstream);
  const next = prev === undefined ? observedMs : prev + EMA_ALPHA * (observedMs - prev);
  table.set(upstream, next);
}

function dohRequestHeaders(orig: Headers, method: 'GET' | 'POST'): HeadersInit {
  const headers: Record<string, string> = {
    'accept': 'application/dns-message',
    'user-agent': 'DoH-Proxy-Edge/1.0 (+vercel-edge)'
  };
  if (method === 'POST') {
    headers['content-type'] = 'application/dns-message';
  }
  // Prefer no cache for request to reduce stale results in proxy
  headers['cache-control'] = 'no-cache';
  headers['pragma'] = 'no-cache';
  return headers;
}

function withCorsAndSecurity(h: Headers): Headers {
  const headers = new Headers(h);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  headers.set('access-control-allow-headers', 'Content-Type, Accept');
  headers.set('x-content-type-options', 'nosniff');
  if (!headers.has('content-security-policy')) {
    headers.set('content-security-policy', "default-src 'none'");
  }
  return headers;
}

async function raceUpstreams(
  req: NextRequest,
  method: 'GET' | 'POST',
  upstreams: string[],
  regionKey: string,
  dnsParam: string | null,
  bodyBuf: ArrayBuffer | null
): Promise<Response> {
  const controllers = upstreams.map(() => new AbortController());
  const startTimes = upstreams.map(() => 0);

  const makeFetch = (idx: number): Promise<{ idx: number; res: Response }> => {
    const upstream = upstreams[idx];
    const url = method === 'GET' ? `${upstream}?dns=${dnsParam}` : upstream;
    const init: RequestInit = {
      method,
      headers: dohRequestHeaders(req.headers, method),
      body: method === 'POST' ? bodyBuf : undefined,
      redirect: 'follow',
      cache: 'no-store',
      signal: controllers[idx].signal
    };
    startTimes[idx] = performance.now();
    return fetch(url, init).then(res => ({ idx, res }));
  };

  let settled = false;

  const schedule: Array<Promise<{ idx: number; res: Response }>> = [];
  const HEDGE_DELAY_MS = 35; // small hedge to reduce tail latency

  for (let i = 0; i < upstreams.length; i++) {
    const p = new Promise<{ idx: number; res: Response }>((resolve) => {
      setTimeout(() => {
        makeFetch(i).then(resolve).catch(err => {
          // Swallow errors; they will be handled by other races
          resolve({ idx: i, res: new Response(null, { status: 599, statusText: String(err?.message || 'fetch error') }) });
        });
      }, i * HEDGE_DELAY_MS);
    });
    schedule.push(p);
  }

  return new Promise<Response>((resolve, reject) => {
    schedule.forEach(p => {
      p.then(({ idx, res }) => {
        if (settled) return;
        // Accept first good DoH response
        const okContentType = res.headers.get('content-type')?.includes('application/dns-message');
        if (res.ok && okContentType) {
          settled = true;
          const elapsed = performance.now() - startTimes[idx];
          updateLatency(regionKey, upstreams[idx], elapsed);
          // Abort others
          controllers.forEach((c, j) => { if (j !== idx) try { c.abort(); } catch { /* ignore */ } });
          const headers = withCorsAndSecurity(res.headers);
          // Ensure content-type is correct
          if (!headers.get('content-type')) headers.set('content-type', 'application/dns-message');
          if (!headers.get('cache-control')) headers.set('cache-control', 'public, max-age=60, s-maxage=300');
          resolve(new Response(res.body, { status: res.status, statusText: res.statusText, headers }));
        } else if (res.status >= 200 && res.status < 300 && !okContentType) {
          // Some upstreams may miss content-type on 204, still treat as success but enforce type
          settled = true;
          const elapsed = performance.now() - startTimes[idx];
          updateLatency(regionKey, upstreams[idx], elapsed);
          controllers.forEach((c, j) => { if (j !== idx) try { c.abort(); } catch { /* ignore */ } });
          const headers = withCorsAndSecurity(res.headers);
          headers.set('content-type', 'application/dns-message');
          if (!headers.get('cache-control')) headers.set('cache-control', 'public, max-age=60, s-maxage=300');
          resolve(new Response(res.body, { status: res.status, statusText: res.statusText, headers }));
        } else {
          // Not acceptable; let other races continue
          if (idx === upstreams.length - 1) {
            // Last one finished and still not settled
            // try to surface the last response with headers augmented
            const headers = withCorsAndSecurity(res.headers);
            resolve(new Response(res.body, { status: res.status || 502, statusText: res.statusText || 'Bad Gateway', headers }));
          }
        }
      }).catch(() => {/* ignored */});
    });

    // Safety timeout
    const SAFETY_MS = 3000;
    setTimeout(() => {
      if (!settled) {
        controllers.forEach(c => { try { c.abort(); } catch { /* ignore */ } });
        const headers = withCorsAndSecurity(new Headers());
        headers.set('content-type', 'text/plain; charset=utf-8');
        resolve(new Response('Upstream timeout', { status: 504, headers }));
      }
    }, SAFETY_MS);
  });
}

function validateDnsParam(d: string | null): d is string {
  if (!d) return false;
  // Basic validation: base64url characters only
  return /^[A-Za-z0-9_-]+$/.test(d);
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const dns = url.searchParams.get('dns');
  if (!validateDnsParam(dns)) {
    const headers = withCorsAndSecurity(new Headers());
    headers.set('content-type', 'text/plain; charset=utf-8');
    return new Response('Missing or invalid dns parameter', { status: 400, headers });
  }

  const regionKey = getRegionKey(req);
  const upstreams = preferByLatency(regionKey, parseUpstreams());
  return raceUpstreams(req, 'GET', upstreams, regionKey, encodeURIComponent(dns), null);
}

export async function POST(req: NextRequest): Promise<Response> {
  // Enforce correct content type but still allow proxying if omitted
  const ct = req.headers.get('content-type') || '';
  if (ct && !ct.includes('application/dns-message')) {
    const headers = withCorsAndSecurity(new Headers());
    headers.set('content-type', 'text/plain; charset=utf-8');
    return new Response('Unsupported Media Type: expected application/dns-message', { status: 415, headers });
  }

  const body = await req.arrayBuffer();
  if (!body || (body as ArrayBuffer).byteLength === 0) {
    const headers = withCorsAndSecurity(new Headers());
    headers.set('content-type', 'text/plain; charset=utf-8');
    return new Response('Empty DNS message body', { status: 400, headers });
  }

  const regionKey = getRegionKey(req);
  const upstreams = preferByLatency(regionKey, parseUpstreams());
  return raceUpstreams(req, 'POST', upstreams, regionKey, null, body);
}

export async function OPTIONS(): Promise<Response> {
  const headers = withCorsAndSecurity(new Headers());
  headers.set('content-length', '0');
  return new Response(null, { status: 204, headers });
}
