/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/invitations", destination: "/invitations.html" },
    ];
  },
};

export default nextConfig;
