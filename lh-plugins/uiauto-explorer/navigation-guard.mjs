const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const DOCUMENT_TYPES = new Set(['Document']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_BLOCKED_LOG = 80;
const MAX_REDIRECTS = 10;

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function normalizeAllowedOrigins(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeOrigin).filter(Boolean))];
}

export function isAllowedNavigationUrl(value, allowedOrigins) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return false;
  }
  if (url.href === 'about:blank') return true;
  if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password) return false;
  return allowedOrigins.includes(url.origin);
}

/**
 * Keep every browser page, popup and redirect inside the explicitly allowed origins.
 *
 * Playwright's context route does not see the destination of a server-side redirect:
 * Chromium follows the new Location internally. The CDP Fetch domain pauses every
 * document request, including each redirect hop, before it is sent. The context route
 * remains as the first-navigation guard for newly created popup pages, which can begin
 * navigating before a page-specific CDP session is attached.
 */
export async function installNavigationGuard(context, rawOrigins, options = {}) {
  const allowedOrigins = normalizeAllowedOrigins(rawOrigins);
  if (!allowedOrigins.length) {
    return {
      allowedOrigins,
      blocked: () => [],
      guardPage: async () => undefined,
      dispose: async () => undefined,
    };
  }

  const onBlocked = typeof options.onBlocked === 'function' ? options.onBlocked : () => undefined;
  const onError = typeof options.onError === 'function' ? options.onError : () => undefined;
  const blocked = [];
  const pageGuards = new WeakMap();
  const sessions = new Set();
  let disposed = false;

  const recordBlocked = (value, source, pageUrl = '') => {
    const entry = {
      url: String(value || '').slice(0, 2000),
      source,
      pageUrl: String(pageUrl || '').slice(0, 2000),
      allowedOrigins: [...allowedOrigins],
      at: new Date().toISOString(),
    };
    blocked.push(entry);
    if (blocked.length > MAX_BLOCKED_LOG) blocked.shift();
    try {
      onBlocked(entry);
    } catch {
      // A log sink must not weaken the navigation boundary.
    }
  };

  const safeRedirectHeaders = (headers, from, to) => {
    if (from.origin === to.origin) return headers;
    const next = { ...headers };
    for (const name of [
      'authorization',
      'cookie',
      'proxy-authorization',
      'host',
      'content-length',
    ]) {
      delete next[name];
    }
    return next;
  };

  /**
   * New popup pages are not exposed to Playwright until their navigation finishes.
   * For their first request, preflight every redirect with manual follow and stop on
   * the first unauthorized Location. A successful first response is then fulfilled;
   * for an allowed redirect chain Chromium can continue normally with the final URL.
   */
  const inspectPopupNavigation = async (route, request) => {
    let current = request.url();
    let method = request.method();
    let postData = request.postDataBuffer() || undefined;
    let headers = await request.allHeaders().catch(() => request.headers());
    let firstResponse = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response;
      try {
        response = await route.fetch({
          url: current,
          method,
          headers,
          postData,
          maxRedirects: 0,
        });
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
        await route.abort('failed');
        return false;
      }
      firstResponse ||= response;
      if (!REDIRECT_STATUSES.has(response.status())) {
        await route.fulfill({ response: firstResponse });
        return true;
      }
      const location = response.headers().location;
      if (!location) {
        await route.fulfill({ response: firstResponse });
        return true;
      }
      let next;
      try {
        next = new URL(location, current);
      } catch {
        recordBlocked(location, 'popup-redirect', current);
        await route.abort('blockedbyclient');
        return false;
      }
      if (!isAllowedNavigationUrl(next.href, allowedOrigins)) {
        recordBlocked(next.href, 'popup-redirect', current);
        await route.abort('blockedbyclient');
        return false;
      }
      headers = safeRedirectHeaders(headers, new URL(current), next);
      if (
        response.status() === 303 ||
        ([301, 302].includes(response.status()) && method.toUpperCase() === 'POST')
      ) {
        method = 'GET';
        postData = undefined;
        delete headers['content-type'];
        delete headers['content-length'];
        delete headers['transfer-encoding'];
      }
      current = next.href;
    }
    await route.abort('failed');
    onError(new Error(`弹窗重定向超过 ${MAX_REDIRECTS} 次`));
    return false;
  };

  await context.route('**/*', async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.continue();
    const allowed = isAllowedNavigationUrl(request.url(), allowedOrigins);
    let pageUrl = '';
    let requestPage = null;
    let frameUnavailable = false;
    try {
      const frame = request.frame();
      pageUrl = frame?.url() || '';
      requestPage = frame?.page?.() || null;
    } catch {
      // Popup documents can be intercepted before Playwright has attached a frame.
      frameUnavailable = true;
    }
    if (frameUnavailable) {
      if (!allowed) {
        recordBlocked(request.url(), 'route', pageUrl);
        return route.abort('blockedbyclient');
      }
      await inspectPopupNavigation(route, request);
      return undefined;
    }
    // A popup can begin navigating before context.on('page') finishes attaching CDP.
    // Wait for the request page guard before releasing this first request, otherwise
    // a same-origin popup that immediately 302s cross-origin could race the guard.
    if (requestPage) await guardPage(requestPage);
    else await Promise.all(context.pages().map((page) => guardPage(page)));
    if (allowed) return route.continue();
    recordBlocked(request.url(), 'route', pageUrl);
    return route.abort('blockedbyclient');
  });

  const guardPage = (page) => {
    if (disposed) return Promise.resolve();
    const existing = pageGuards.get(page);
    if (existing) return existing;
    const task = (async () => {
      try {
        const session = await context.newCDPSession(page);
        if (disposed) {
          await session.detach().catch(() => undefined);
          return;
        }
        sessions.add(session);
        session.on('Fetch.requestPaused', async (event) => {
          if (disposed) return;
          const isDocument = DOCUMENT_TYPES.has(event.resourceType);
          const allowed = !isDocument || isAllowedNavigationUrl(event.request.url, allowedOrigins);
          try {
            if (allowed) {
              await session.send('Fetch.continueRequest', { requestId: event.requestId });
            } else {
              recordBlocked(event.request.url, 'cdp', page.url());
              await session.send('Fetch.failRequest', {
                requestId: event.requestId,
                errorReason: 'BlockedByClient',
              });
            }
          } catch (error) {
            if (!disposed) onError(error instanceof Error ? error : new Error(String(error)));
          }
        });
        session.on('Inspector.detached', () => sessions.delete(session));
        await session.send('Fetch.enable', {
          patterns: [{ urlPattern: '*', requestStage: 'Request' }],
        });
      } catch (error) {
        if (!disposed) onError(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    pageGuards.set(page, task);
    return task;
  };

  context.on('page', (page) => void guardPage(page));
  await Promise.all(context.pages().map((page) => guardPage(page)));

  return {
    allowedOrigins,
    blocked: () => blocked.map((entry) => ({ ...entry })),
    guardPage,
    dispose: async () => {
      disposed = true;
      await Promise.all(
        [...sessions].map(async (session) => {
          await session.send('Fetch.disable').catch(() => undefined);
          await session.detach().catch(() => undefined);
        }),
      );
      sessions.clear();
      await context.unroute('**/*').catch(() => undefined);
    },
  };
}
