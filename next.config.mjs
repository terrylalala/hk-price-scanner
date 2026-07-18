/** @type {import('next').NextConfig} */
const nextConfig = {
  // App Router Route Handlers (app/api/*) stream the request body and do not
  // impose the old 4MB Pages API limit, so downscaled base64 photos are fine
  // with the defaults. No extra config needed.
};

export default nextConfig;
