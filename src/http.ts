// ESHTTP HTTP response parsing — shared by the socket path (ported from
// src/eshttp.jsxinc L1146–1265; api-spec §10).
//
// Pure, Illustrator-agnostic. Input: raw HTTP/1.1 response text. Output:
// { status, statusText, httpVersion, headers, body, bodyBytes, ok, error }.
// Handles the status line, header block, Content-Length, chunked
// transfer-encoding, read-to-EOF bodies, and the maxBodyBytes cap. NEVER
// throws — parse failures become { error } records.
import { trim } from './utils';
import { mkError } from './errors';
import { parseResponseHeaders } from './headers';
import { utf8ByteLength } from './vendor-b64';
import { base64EncodeBytes } from './vendor-b64';

/** Parsed HTTP response record (socket driver input). */
export interface HttpResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: any;            // { map, list }
  body: string;
  bodyBytes: string;
  ok: boolean;
  error: any;              // EshttpError | null
}

/**
 * Parse a raw HTTP/1.1 response text. Never throws; malformed input becomes
 * an { error } record (network/internal taxonomy).
 */
export function parseHttpResponse(raw: any, maxBodyBytes: any): HttpResponse {
  var result: HttpResponse = {
    status: 0, statusText: "", httpVersion: "", headers: { map: {}, list: [] },
    body: "", bodyBytes: "", ok: false,
    error: null
  };
  if (typeof raw !== "string") {
    result.error = mkError("internal", "socket returned non-string data");
    return result;
  }
  var headEnd = raw.indexOf("\r\n\r\n");
  var sepLen = 4;
  if (headEnd < 0) {
    headEnd = raw.indexOf("\n\n");
    sepLen = 2;
  }
  if (headEnd < 0) {
    result.error = mkError("network", "malformed HTTP response (no header terminator)");
    return result;
  }
  var headText = raw.substring(0, headEnd);
  var bodyRaw = raw.substring(headEnd + sepLen);

  var lines = headText.split(/\r?\n/);
  var statusLine = lines.length > 0 ? trim(lines[0]) : "";
  var sm = /^HTTP\/(\d(\.\d)?)\s+(\d{3})\s*(.*)$/.exec(statusLine);
  if (!sm) {
    result.error = mkError("network", "malformed status line: '" + statusLine + "'");
    return result;
  }
  result.httpVersion = sm[1];
  result.status = parseInt(sm[3], 10);
  result.statusText = sm[4] || "";
  result.headers = parseResponseHeaders(lines.slice(1).join("\n"));
  result.ok = (result.status >= 200 && result.status < 300);

  var te = result.headers.map["transfer-encoding"];
  var cl = result.headers.map["content-length"];

  var body = bodyRaw;
  if (result.status === 204 || result.status === 304 || /^HEAD$/i.test(headText)) {
    body = "";
  } else if (te && /chunked/i.test(te)) {
    var dechunked = dechunk(bodyRaw);
    if (dechunked.error) {
      result.error = dechunked.error;
      return result;
    }
    body = dechunked.body !== undefined ? dechunked.body : "";
  } else if (cl !== undefined && cl !== null && cl !== "") {
    var clen = parseInt(cl, 10);
    if (!isNaN(clen)) {
      body = bodyRaw.substring(0, clen);
    }
  }
  if (maxBodyBytes && utf8ByteLength(body) > maxBodyBytes) {
    result.error = mkError("body-too-large", "response body exceeds maxBodyBytes");
    result.body = body;
    return result;
  }
  result.body = body;
  // Wire bytes, not latin1-validated text: use the non-throwing lane so a
  // malformed body can never turn a Result into a throw.
  result.bodyBytes = base64EncodeBytes(body);
  return result;
}

/** Dechunk result: either { body } or { error }. */
export interface DechunkResult {
  body?: string;
  error?: any;
}

/**
 * Decode chunked transfer-encoding. Never throws; malformed input becomes
 * { error } (network taxonomy).
 */
export function dechunk(data: any): DechunkResult {
  // Defensive: never throw even on a non-string (helpers surface).
  if (typeof data !== "string") {
    return { error: mkError("internal", "dechunk: non-string input") };
  }
  var out: string[] = [];
  var i = 0;
  var n = data.length;
  for (;;) {
    var lineEnd = data.indexOf("\r\n", i);
    var sepLen = 2;
    if (lineEnd < 0) {
      lineEnd = data.indexOf("\n", i);
      sepLen = 1;
    }
    if (lineEnd < 0) {
      return { error: mkError("network", "chunked: unterminated size line") };
    }
    var sizeLine = trim(data.substring(i, lineEnd));
    var semi = sizeLine.indexOf(";");
    if (semi >= 0) { sizeLine = sizeLine.substring(0, semi); }
    var size = parseInt(sizeLine, 16);
    if (isNaN(size) || size < 0) {
      return { error: mkError("network", "chunked: bad chunk size '" + sizeLine + "'") };
    }
    i = lineEnd + sepLen;
    if (size === 0) {
      // trailers until blank line
      var ti = data.indexOf("\r\n\r\n", i);
      if (ti < 0) { ti = data.indexOf("\n\n", i); }
      break;
    }
    if (i + size > n) {
      return { error: mkError("network", "chunked: truncated chunk") };
    }
    out.push(data.substring(i, i + size));
    i += size;
    // skip trailing CRLF of the chunk
    if (data.charAt(i) === "\r") { i += 1; }
    if (data.charAt(i) === "\n") { i += 1; }
  }
  return { body: out.join("") };
}
