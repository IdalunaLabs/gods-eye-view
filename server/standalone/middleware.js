/** Pathname of a Node request URL, without its query or fragment. */
export function requestPathname(url = '/') {
  const value = String(url || '/');
  const query = value.indexOf('?');
  const hash = value.indexOf('#');
  let end = value.length;
  if (query >= 0) end = Math.min(end, query);
  if (hash >= 0) end = Math.min(end, hash);
  const pathname = value.slice(0, end);
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function mountRoute(route) {
  let path = route;
  if (path[path.length - 1] === '/') path = path.slice(0, -1);
  return path;
}

function callLayer(handle, err, req, res, next) {
  const hasError = Boolean(err);
  try {
    if (hasError && handle.length === 4) {
      handle(err, req, res, next);
      return;
    }
    if (!hasError && handle.length < 4) {
      handle(req, res, next);
      return;
    }
  } catch (error) {
    next(error);
    return;
  }
  next(err);
}

/**
 * A Connect-compatible middleware stack. Mount paths strip `req.url` the way
 * Vite's `server.middlewares.use(route, fn)` does, so provider routes can keep
 * reading the suffix they already expect.
 */
export function createMiddleware() {
  const stack = [];
  return {
    /**
     * @param {string|Function} route
     * @param {Function} [handle]
     */
    use(route, handle) {
      if (typeof route !== 'string') {
        handle = route;
        route = '/';
      }
      stack.push({ route: mountRoute(route), handle });
      return this;
    },
    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {(err?: unknown) => void} done
     */
    handle(req, res, done) {
      let index = 0;
      let removed = '';
      let slashAdded = false;
      if (!req.url) req.url = '/';
      req.originalUrl = req.originalUrl || req.url;
      function next(err) {
        if (slashAdded) {
          req.url = req.url.slice(1);
          slashAdded = false;
        }
        if (removed) {
          req.url = removed + req.url;
          removed = '';
        }
        while (index < stack.length) {
          const layer = stack[index++];
          const pathname = requestPathname(req.url);
          const route = layer.route;
          if (
            pathname.toLowerCase().slice(0, route.length) !==
            route.toLowerCase()
          )
            continue;
          const border =
            pathname.length > route.length ? pathname[route.length] : '';
          if (border && border !== '/' && border !== '.') continue;
          if (route.length !== 0) {
            removed = route;
            req.url = req.url.slice(route.length);
            if (!req.url.startsWith('/')) {
              req.url = `/${req.url}`;
              slashAdded = true;
            }
          }
          callLayer(layer.handle, err, req, res, next);
          return;
        }
        done(err);
      }
      next();
    },
  };
}
