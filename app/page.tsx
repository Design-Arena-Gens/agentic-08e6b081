export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <main>
      <h1>DoH Proxy Edge</h1>
      <p>/dns-query implements RFC 8484 DoH proxy with upstream racing.</p>
      <p>Set env <code>DOH_UPSTREAMS</code> (comma-separated) to customize upstreams.</p>
    </main>
  );
}
