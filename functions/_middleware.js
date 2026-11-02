// Frozen legacy cloud (4.0): the site is the download page in site/; functions/api only stays so 3.x users' desktop
// apps can move their data home (host/export). Visitors on an old hostname go to the main one (wrangler.toml [vars]).
// API calls are left alone so old desktop apps pointed at the old address keep working.
export async function onRequest({ request, env, next }) {
  const canonical = env.CANONICAL_HOST, legacy = (env.LEGACY_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const url = new URL(request.url);
  if (canonical && legacy.includes(url.hostname) && request.method === 'GET' && !url.pathname.startsWith('/api/')) {
    url.hostname = canonical;
    return Response.redirect(url.toString(), 301);
  }
  return next();
}
