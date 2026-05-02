import { type VercelConfig } from '@vercel/config/v1';

/**
 * The Vercel project was created with framework preset "Other", which made Vercel
 * treat the deploy as a static site (looking for files in `public/`) and ignore the
 * Next.js routing. Result: every route returned 404 in production. Declaring
 * `framework: 'nextjs'` here pins it correctly so Next's router, middleware (proxy.ts),
 * and serverless functions all wire up.
 */
export const config: VercelConfig = {
  framework: 'nextjs',
};
