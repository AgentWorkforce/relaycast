/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@agent-relay/dashboard'],
  async rewrites() {
    const apiTarget = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3890';
    return [
      {
        source: '/api/:path*',
        destination: `${apiTarget}/api/:path*`,
      },
      {
        source: '/ws',
        destination: `${apiTarget}/ws`,
      },
    ];
  },
};
module.exports = nextConfig;
