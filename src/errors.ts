// ESHTTP error taxonomy (ported from src/eshttp.jsxinc L1265–1301; api-spec §7).
//
// 14 stable codes; each maps to { category, retryable }. `eshttp.error` exposes
// the codes as constants (they equal the strings). `mkError` builds the public
// error object shape { code, category, message, retryable, detail? }.
//
// Pure module — no host dependencies.
import { ErrorTaxonomyEntry, EshttpError } from './types';
import { has } from './utils';

/** Taxonomy table (14 codes × category × retryable) — api-spec §7. */
var _ERRORS: { [code: string]: ErrorTaxonomyEntry } = {
  "invalid-args":        { category: "usage",     retryable: false },
  "bad-url":             { category: "usage",     retryable: false },
  "invalid-header":      { category: "usage",     retryable: false },
  "unsupported":         { category: "usage",     retryable: false },
  "dns":                 { category: "transport", retryable: true  },
  "connect":             { category: "transport", retryable: true  },
  "network":             { category: "transport", retryable: true  },
  "tls":                 { category: "tls",       retryable: false },
  "timeout":             { category: "timeout",   retryable: true  },
  "aborted":             { category: "abort",     retryable: false },
  "too-many-redirects":  { category: "protocol",  retryable: false },
  "body-too-large":      { category: "protocol",  retryable: false },
  "invalid-json":        { category: "protocol",  retryable: false },
  "internal":            { category: "internal",  retryable: false }
};

/** eshttp.error constants object (code string → same string). */
var _errorConsts: { [code: string]: string } = {};
var _errKey: string;
for (_errKey in _ERRORS) {
  if (has(_ERRORS, _errKey)) { _errorConsts[_errKey] = _errKey; }
}

/**
 * Build a public error object (api-spec §7 shape). Unknown codes degrade to
 * "internal". `detail` is attached only when provided.
 */
export function mkError(code: string, message?: string, detail?: any): EshttpError {
  var meta = _ERRORS[code] || _ERRORS["internal"];
  var err: EshttpError = {
    code: code,
    category: meta.category,
    message: message || code,
    retryable: meta.retryable
  };
  if (detail) { err.detail = detail; }
  return err;
}

export { _ERRORS, _errorConsts };
