// ESHTTP socket driver — ES3 Socket, HTTP/1.1 cleartext (ported from
// src/eshttp.jsxinc L1494–1688; api-spec §10).
//
// Cleartext http:// only. https and bodyIsBase64 are unsupported here and
// degrade to "unsupported" error Results (never throw). Host globals
// (Socket) are typeof-guarded at CALL time only.
import { toLower, now, errStr } from './utils';
import { mkError } from './errors';
import { parseHttpResponse } from './http';
import { utf8ByteLength, base64DecodeLenient } from './vendor-b64';
import { RequestContext, Result, EshttpError } from './types';
import { noNetwork } from './state';

/** True when the ES3 Socket object exists and the network hook is off. */
export function socketAvailable(): boolean {
  return (typeof Socket !== "undefined") && !noNetwork();
}

/** Shared socket error-Result shape (path "socket", zeroed fields). */
export function socketErrorResult(error: EshttpError, ctx: RequestContext, startMs: number): Result {
  return {
    ok: false, status: 0, statusText: "", headers: {}, body: "", bodyText: "",
    error: error,
    meta: {
      path: "socket", url: ctx.url, redirects: 0, timeMs: now() - startMs, bytes: 0,
      timeoutEnforced: false, tlsVersion: null, httpVersion: null, abi: null, nativeVersion: null,
      encodingWasApplied: null, backend: null
    }
  };
}

/**
 * Perform one cleartext HTTP/1.1 request via the ES3 Socket object.
 * Never throws; every failure becomes an error Result. Redirects are handled
 * by the JS redirector in index.ts (this returns 3xx as-is).
 */
export function socketRequest(ctx: RequestContext, startMs: number): Result {
  // https on socket is unsupported (no TLS).
  if (ctx.https) {
    return {
      ok: false, status: 0, statusText: "", headers: {}, body: "", bodyText: "",
      error: mkError("unsupported", "https requires the native eshttp.dll driver (Socket is cleartext only)"),
      meta: { path: "socket", url: ctx.url, redirects: 0, timeMs: now() - startMs, bytes: 0,
              timeoutEnforced: false, tlsVersion: null, httpVersion: null, abi: null, nativeVersion: null,
              encodingWasApplied: null, backend: null }
    };
  }
  // bodyIsBase64 is native-only.
  if (ctx.bodyIsBase64) {
    return {
      ok: false, status: 0, statusText: "", headers: {}, body: "", bodyText: "",
      error: mkError("unsupported", "bodyIsBase64 requires the native eshttp.dll driver"),
      meta: { path: "socket", url: ctx.url, redirects: 0, timeMs: now() - startMs, bytes: 0,
              timeoutEnforced: false, tlsVersion: null, httpVersion: null, abi: null, nativeVersion: null,
              encodingWasApplied: null, backend: null }
    };
  }

  var sock: any = null;
  try {
    sock = new Socket();
  } catch (e) {
    return socketErrorResult(mkError("internal", "Socket object unavailable: " + errStr(e)), ctx, startMs);
  }

  var hostHeader = ctx.host;
  if (ctx.host.indexOf(":") >= 0 && ctx.host.charAt(0) !== "[") {
    hostHeader = "[" + ctx.host + "]";
  }
  if (ctx.port !== 80) { hostHeader += ":" + ctx.port; }

  // Build request head: method SP path SP HTTP/1.1 CRLF headers CRLF CRLF
  var head = ctx.method + " " + ctx.requestTarget + " HTTP/1.1\r\n";
  head += "Host: " + hostHeader + "\r\n";
  var wroteContentLength = false;
  var wroteUserAgent = false;
  var i: number;
  for (i = 0; i < ctx.headers.length; i++) {
    var nm = ctx.headers[i][0];
    var lowerName = toLower(nm);
    // Host/Content-Length are computed by the wrapper (contract §10);
    // user-supplied values for these are ignored.
    if (lowerName === "host" || lowerName === "content-length") { continue; }
    head += nm + ": " + ctx.headers[i][1] + "\r\n";
    if (lowerName === "content-length") { wroteContentLength = true; }
    if (lowerName === "user-agent") { wroteUserAgent = true; }
  }
  // G5: User-Agent default applied when the caller supplied no User-Agent
  // header (precedence resolved in _buildContext; ctx.userAgent is null when
  // a UA header exists or UA was suppressed). Exactly one User-Agent reaches
  // the wire (api-spec §2/§6.2).
  if (!wroteUserAgent && ctx.userAgent) {
    head += "User-Agent: " + ctx.userAgent + "\r\n";
  }
  if (!wroteContentLength && ctx.body && ctx.body.length > 0) {
    head += "Content-Length: " + utf8ByteLength(ctx.body) + "\r\n";
  }
  if (ctx.bodyIsEmpty && !wroteContentLength) {
    head += "Content-Length: 0\r\n";
  }
  head += "Connection: close\r\n";
  head += "\r\n";

  var bodyToSend = ctx.bodyIsBase64 ? base64DecodeLenient(ctx.body) : (ctx.body || "");

  var opened = false;
  try {
    // ExtendScript Socket.open(host, port, timeoutSeconds).
    var timeoutSec = Math.max(1, Math.ceil((ctx.timeout || 30000) / 1000));
    opened = sock.open(ctx.host, ctx.port, timeoutSec);
  } catch (e2) {
    opened = false;
  }
  if (!opened) {
    try { sock.close(); } catch (e3) {}
    return socketErrorResult(mkError("connect", "could not connect to " + ctx.host + ":" + ctx.port), ctx, startMs);
  }

  var raw = "";
  var ok = false;
  try {
    sock.write(head);
    if (bodyToSend && bodyToSend.length > 0) {
      // Binary-safe: write raw byte string via explicit loop.
      sock.write(bodyToSend);
    }
    ok = true;
  } catch (e4) {
    try { sock.close(); } catch (e5) {}
    return socketErrorResult(mkError("network", "socket write failed: " + errStr(e4)), ctx, startMs);
  }

  // Read loop until EOF (Connection: close) with wall-clock timeout guard.
  var deadline = (ctx.timeout && ctx.timeout > 0) ? startMs + ctx.timeout : 0;
  try {
    for (;;) {
      if (deadline && now() > deadline) {
        try { sock.close(); } catch (e6) {}
        return socketErrorResult(mkError("timeout", "socket read timed out after " + ctx.timeout + "ms"), ctx, startMs);
      }
      if (sock.eof) { break; }
      var chunk = "";
      try {
        chunk = String(sock.read() || "");
      } catch (e7) {
        break; // treat as EOF
      }
      if (chunk.length === 0) {
        if (sock.eof) { break; }
        // No data yet — poll (cheap) with deadline; avoid tight spin.
        continue;
      }
      raw += chunk;
      // Memory bound on the RAW buffer (head + body). The body cap is
      // opts.maxBodyBytes (api-spec §2; default 50 MiB); the raw buffer also
      // holds the response head, so allow a small head slack. maxBodyBytes =
      // 0 means unlimited (matching parseHttpResponse semantics). Exact body
      // cap is re-enforced post-parse.
      var readCap = (ctx.maxBodyBytes > 0) ? (ctx.maxBodyBytes + 8192) : 0;
      if (readCap && raw.length > readCap) {
        try { sock.close(); } catch (e8) {}
        return socketErrorResult(mkError("body-too-large", "response body exceeds maxBodyBytes (" + ctx.maxBodyBytes + ")"), ctx, startMs);
      }
    }
  } finally {
    try { sock.close(); } catch (e9) {}
  }

  var parsed = parseHttpResponse(raw, ctx.maxBodyBytes);
  if (parsed.error) {
    return socketErrorResult(parsed.error, ctx, startMs);
  }

  // body/bodyText: text vs binary by content-type.
  var contentType = parsed.headers.map["content-type"] || "";
  var isText = /^text\//i.test(contentType) ||
               /^application\/(json|xml|javascript|x-www-form-urlencoded|xhtml\+xml|atom\+xml)/i.test(contentType) ||
               /\+json$/i.test(contentType) ||
               /\+xml$/i.test(contentType) ||
               /^application\/json/i.test(contentType);
  var body = parsed.body;
  var bodyText = body;
  if (!isText) {
    bodyText = parsed.bodyBytes; // base64 form for binary bodies
  }

  return {
    ok: parsed.ok,
    status: parsed.status,
    statusText: parsed.statusText,
    headers: parsed.headers.map,
    body: body,
    bodyText: bodyText,
    error: null,
    meta: {
      path: "socket",
      url: ctx.url,
      redirects: 0, // filled by the JS redirector in request()
      timeMs: now() - startMs,
      bytes: utf8ByteLength(body),
      timeoutEnforced: false, // best-effort only (contract §10)
      tlsVersion: null,
      httpVersion: parsed.httpVersion,
      abi: null,
      nativeVersion: null,
      encodingWasApplied: null, // no decompress on socket path
      backend: null
    }
  };
}
