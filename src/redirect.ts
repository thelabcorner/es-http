// ESHTTP JS redirector — socket path only (ported from src/eshttp.jsxinc
// L1963–1991; api-spec §8).
//
// Determines the next-hop parameters for a 3xx response: 301/302/303 ->
// GET + body dropped + Content-Type/Content-Length dropped; 307/308 preserve
// method + body. Authorization dropping on cross-host redirects is handled
// in index.ts (_request), where the ORIGINAL ctx.parsed is still available.
import { resolveUrl } from './url';
import { toLower } from './utils';
import { RequestContext, HeaderPair } from './types';

/** Next-hop context fragment: url + method + headers + body. */
export interface NextHop {
  url: string;
  method: string;
  headers: HeaderPair[];
  body: string;
  bodyIsBase64: boolean;
}

/**
 * Build the next-hop parameters from a raw 3xx response. `ctx` is the
 * CURRENT request context (already advanced by earlier hops, if any).
 */
export function redirectResult(raw: any, ctx: RequestContext, location: any): NextHop {
  var next: NextHop = {
    url: resolveUrl(ctx.url, location),
    method: ctx.method,
    headers: ctx.headers,
    body: ctx.body,
    bodyIsBase64: ctx.bodyIsBase64
  };
  if (raw.status === 301 || raw.status === 302 || raw.status === 303) {
    next.method = "GET";
    next.body = "";
    next.bodyIsBase64 = false;
    // drop Content-Type / Content-Length on method change
    var filtered: HeaderPair[] = [];
    var i: number;
    for (i = 0; i < next.headers.length; i++) {
      var ln = toLower(next.headers[i][0]);
      if (ln === "content-type" || ln === "content-length") { continue; }
      filtered.push(next.headers[i]);
    }
    next.headers = filtered;
  }
  // 307/308 preserve method + body (already defaulted)
  return next;
}
