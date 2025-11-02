# DoH Proxy Edge (RFC 8484)

- Edge runtime Next.js app exposing `/dns-query` compatible with RFC 8484
- Upstream racing with exponential moving average latency memory per region
- Configure upstreams via `DOH_UPSTREAMS` (comma separated), defaults include Cloudflare/Google/Quad9

Deploy on Vercel. Configure env `DOH_UPSTREAMS` if desired.
