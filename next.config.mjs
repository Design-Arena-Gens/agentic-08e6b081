/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    forceSwcTransforms: true
  },
  headers: async () => {
    return [
      {
        source: '/dns-query',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Content-Security-Policy', value: "default-src 'none'" }
        ]
      }
    ];
  }
};

export default nextConfig;
