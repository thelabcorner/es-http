/*
 * 40-codec-parity.js — Q5: base64 + UTF-8 codec parity with ESB64.
 * ==================================================================
 * Q5 is the "non-ASCII UTF-8 round-trip, end to end" acceptance item. The
 * end-to-end wire cases live in 20-native-abi.js / 30-socket-wire.js; this
 * suite pins the CODEC ITSELF, which those tests only exercise incidentally.
 *
 * The reference is the sibling ESB64 library (read-only source of truth at
 * ../esb64). eshttp's helpers must behave lane-for-lane like ESB64:
 *
 *   helpers.base64Encode   = WHATWG btoa            (latin1 only)
 *   helpers.base64Decode   = WHATWG forgiving-base64 decode
 *   helpers.utf8Encode     = TextEncoder            (lone surrogate -> U+FFFD)
 *   helpers.utf8Decode     = WHATWG UTF-8 decoder   (error GROUPING)
 *   helpers.utf8ByteLength = utf8Encode(x).length
 *
 * Every check below is a REGRESSION GUARD for a divergence that was found
 * and fixed during the parity pass (task t5-esb64) — each one FAILED against
 * the pre-parity codec:
 *
 *   G1 base64Encode accepted chars > 0xFF (silently truncating) instead of
 *      throwing InvalidCharacterError.
 *   G2 base64Encode did not coerce non-string input (String(x)); numbers,
 *      null and false produced "" or a TypeError.
 *   G3 base64Decode accepted malformed input (bad length, stray/misplaced
 *      '=', invalid characters) instead of throwing — it silently skipped
 *      unknown chars and returned partial data.
 *   G4 base64Decode stripped \s (which includes NBSP, U+2028, U+FEFF …)
 *      instead of the five ASCII whitespace chars the spec allows.
 *   G5 utf8Encode encoded surrogate PAIRS as two 3-byte sequences (CESU-8)
 *      instead of one 4-byte sequence, and never emitted U+FFFD for lone
 *      surrogates.
 *   G6 utf8ByteLength counted every char >= 0x800 as 3 bytes, so astral
 *      characters were counted as 6 — a WRONG Content-Length on the wire.
 *   G7 utf8Decode accepted overlong forms, surrogate-encoded code points and
 *      out-of-range sequences, and did not apply WHATWG error grouping.
 *
 * The exhaustive differential (esb64's own vectors + the WPT base64 corpus +
 * seeded fuzz, ~104K checks) lives in test/parity/esb64-parity.mjs and is run
 * separately — it needs the esb64 sibling checkout, so it is not wired into
 * this always-runnable suite.
 *
 * This file is QA infrastructure only — NOT part of the eshttp library.
 */
"use strict";

module.exports = function (suite, env) {
    const eshttp = env.eshttp;
    const H = eshttp.helpers;
    const A = env.assert;
    const EQ = env.assertEq;

    // Assert fn() throws an Error named InvalidCharacterError (btoa/atob).
    // NOTE: the library runs inside a `vm` sandbox, so the Error it throws is
    // built from the SANDBOX's Error constructor — `instanceof Error` is false
    // across that realm boundary. Duck-type on the Error shape instead.
    function throwsInvalidChar(fn, msg) {
        let threw = null;
        let caught = false;
        try { fn(); } catch (e) { caught = true; threw = e; }
        A(caught, msg + " — expected a throw, nothing was thrown");
        A(threw !== null && typeof threw === "object",
            msg + " — expected an Error object, got " + typeof threw + " " + String(threw));
        A(typeof threw.message === "string" && threw.message.length > 0,
            msg + " — Error must carry a message");
        EQ(threw.name, "InvalidCharacterError", msg + " — error name");
    }

    // =====================================================================
    // G1/G2 — base64Encode is btoa: latin1-only, String()-coercing
    // =====================================================================
    suite.test("Q5 base64Encode matches RFC 4648 §10 vectors", function () {
        const vectors = [
            ["", ""], ["f", "Zg=="], ["fo", "Zm8="], ["foo", "Zm9v"],
            ["foob", "Zm9vYg=="], ["fooba", "Zm9vYmE="], ["foobar", "Zm9vYmFy"]
        ];
        for (const [input, expected] of vectors) {
            EQ(H.base64Encode(input), expected, "btoa(" + JSON.stringify(input) + ")");
            // Node's native btoa is the third oracle.
            EQ(H.base64Encode(input), btoa(input), "native btoa parity: " + JSON.stringify(input));
        }
    });

    suite.test("Q5 base64Encode is binary-safe across the full byte range", function () {
        for (let b = 0; b < 256; b++) {
            const s = String.fromCharCode(b);
            EQ(H.base64Encode(s), btoa(s), "byte " + b);
        }
        // NUL, DEL and 0xFF specifically (the classic truncation bugs).
        EQ(H.base64Encode("\u0000"), "AA==", "NUL");
        EQ(H.base64Encode("\u0000\u0000"), "AAA=", "NUL NUL");
        EQ(H.base64Encode("a\u0000b"), "YQBi", "embedded NUL");
        EQ(H.base64Encode("\u00ff"), "/w==", "0xFF");
        EQ(H.base64Encode("\u007f"), "fw==", "DEL");
        EQ(H.base64Encode("\u00e9\u0080"), "6YA=", "two high bytes");
    });

    suite.test("Q5 G1 base64Encode rejects non-latin1 input (btoa semantics)", function () {
        // Pre-parity these were silently truncated to a wrong byte.
        throwsInvalidChar(function () { H.base64Encode("\u0100"); }, "U+0100");
        throwsInvalidChar(function () { H.base64Encode("\ud800"); }, "lone high surrogate");
        throwsInvalidChar(function () { H.base64Encode("\udc00"); }, "lone low surrogate");
        throwsInvalidChar(function () { H.base64Encode("\ud83d\ude00"); }, "emoji");
        throwsInvalidChar(function () { H.base64Encode("caf\u00e9 \u4e2d"); }, "mixed latin1 + CJK");
    });

    suite.test("Q5 G2 base64Encode coerces non-string input with String()", function () {
        EQ(H.base64Encode(123), "MTIz", "number");
        EQ(H.base64Encode(null), "bnVsbA==", "null");
        EQ(H.base64Encode(false), "ZmFsc2U=", "false");
        EQ(H.base64Encode(0), "MA==", "zero");
        for (const v of [123, null, false, 0, -1, 1.5]) {
            EQ(H.base64Encode(v), btoa(v), "native btoa parity: " + String(v));
        }
    });

    // =====================================================================
    // G3/G4 — base64Decode is WHATWG forgiving-base64
    // =====================================================================
    suite.test("Q5 base64Decode accepts the forgiving cases the spec allows", function () {
        const ok = [
            ["", ""], ["Zg==", "f"], ["Zm8=", "fo"], ["Zm9v", "foo"],
            ["Zm9vYmFy", "foobar"],
            // missing padding is tolerated
            ["Zg", "f"], ["Zm8", "fo"], ["Zm9vYg", "foob"],
            // ASCII whitespace is stripped anywhere
            ["Z m 8 =", "fo"], ["\tZ\r\nm8\n=", "fo"], ["\fZm8=\f", "fo"], [" \nZm9v", "foo"],
            ["AA==", "\u0000"], ["/w==", "\u00ff"], ["AIAB", "\u0000\u0080\u0001"]
        ];
        for (const [input, expected] of ok) {
            EQ(H.base64Decode(input), expected, "atob(" + JSON.stringify(input) + ")");
            EQ(H.base64Decode(input), atob(input), "native atob parity: " + JSON.stringify(input));
        }
    });

    suite.test("Q5 G3 base64Decode rejects malformed input instead of guessing", function () {
        // Every one of these silently returned partial data pre-parity.
        const bad = ["A", "Zm9vY", "=", "====", "A===", "Zg=A", "=AA", "AB==CD",
            "Zm9v!", "-", "Zm9v_", "\u00e9", "\u0000", "\u007f", "abc==",
            "////A", "AAAA/", "abcd\u0000nonsense"];
        for (const input of bad) {
            throwsInvalidChar(function () { H.base64Decode(input); },
                "atob(" + JSON.stringify(input) + ") must reject");
            // Node's native atob must reject it too.
            let nativeThrew = false;
            try { atob(input); } catch (e) { nativeThrew = true; }
            EQ(nativeThrew, true, "native atob also rejects " + JSON.stringify(input));
        }
    });

    suite.test("Q5 G3 base64Decode rejects long padding runs (no O(n) blowup)", function () {
        const pad = new Array(1001).join("=");
        throwsInvalidChar(function () { H.base64Decode("a" + pad); }, "1000 '=' after 1 char");
        throwsInvalidChar(function () { H.base64Decode("ab" + pad); }, "1000 '=' after 2 chars");
        throwsInvalidChar(function () { H.base64Decode("abcd" + pad); }, "1000 '=' after 4 chars");
    });

    suite.test("Q5 G4 base64Decode strips only the five ASCII whitespace chars", function () {
        // \s in a JS regex also matches NBSP / U+2028 / U+FEFF etc. The spec
        // treats those as INVALID characters, not whitespace — a \s-based
        // strip accepted them silently.
        for (const ws of [" ", "\t", "\n", "\f", "\r"]) {
            EQ(H.base64Decode("Zm" + ws + "9v"), "foo", "ASCII ws " + JSON.stringify(ws) + " is stripped");
        }
        for (const notWs of ["\u000b", "\u00a0", "\u2003", "\u2028", "\u2029", "\ufeff"]) {
            throwsInvalidChar(function () { H.base64Decode("Zm" + notWs + "9v"); },
                JSON.stringify(notWs) + " is not base64 whitespace");
        }
    });

    suite.test("Q5 base64 round-trips arbitrary binary payloads", function () {
        const payloads = ["", "a", "ab", "abc", "\u0000", "a\u0000b",
            "\u0000\u0001\u0002\u00fd\u00fe\u00ff"];
        for (const p of payloads) {
            EQ(H.base64Decode(H.base64Encode(p)), p, "roundtrip " + JSON.stringify(p));
        }
        // every 2-byte combination across the range boundaries
        for (let a = 0; a < 256; a += 17) {
            for (let b = 0; b < 256; b += 13) {
                const s = String.fromCharCode(a) + String.fromCharCode(b);
                EQ(H.base64Decode(H.base64Encode(s)), s, "roundtrip bytes " + a + "," + b);
            }
        }
        // a payload longer than the codec's internal flush threshold
        let big = "";
        for (let i = 0; i < 5000; i++) { big += String.fromCharCode(i & 0xff); }
        EQ(H.base64Decode(H.base64Encode(big)), big, "5000-byte roundtrip");
        EQ(H.base64Encode(big), btoa(big), "5000-byte native btoa parity");
    });

    // =====================================================================
    // G5/G6 — utf8Encode / utf8ByteLength are TextEncoder-exact
    // =====================================================================
    suite.test("Q5 utf8Encode matches Buffer across the UTF-8 length boundaries", function () {
        const inputs = ["", "hello", "\u0000", "\u007f", "\u0080", "\u07ff",
            "\u0800", "\ud7ff", "\ue000", "\uffff", "\ufffd",
            "caf\u00e9", "\u65e5\u672c\u8a9e", "\u03c0", "\u0000\u007f\u00ff"];
        for (const s of inputs) {
            EQ(H.utf8Encode(s), Buffer.from(s, "utf8").toString("binary"),
                "utf8Encode " + JSON.stringify(s));
            EQ(H.utf8ByteLength(s), Buffer.byteLength(s, "utf8"),
                "utf8ByteLength " + JSON.stringify(s));
        }
    });

    suite.test("Q5 G5 utf8Encode emits 4-byte sequences for surrogate pairs (not CESU-8)", function () {
        // Pre-parity these produced SIX bytes (two 3-byte sequences).
        const pairs = [
            ["\ud83d\ude00", "8J+YgA=="],   // U+1F600
            ["\ud800\udc00", "8JCAgA=="],   // U+10000 (min astral)
            ["\udbff\udfff", "9I+/vw=="]    // U+10FFFF (max)
        ];
        for (const [input, b64] of pairs) {
            const bytes = H.utf8Encode(input);
            EQ(bytes.length, 4, "4 bytes for " + JSON.stringify(input));
            EQ(H.base64Encode(bytes), b64, "encodeUtf8 " + JSON.stringify(input));
            EQ(bytes, Buffer.from(input, "utf8").toString("binary"), "Buffer parity");
            EQ(H.utf8Decode(bytes), input, "astral roundtrip");
        }
    });

    suite.test("Q5 G5 utf8Encode replaces lone surrogates with U+FFFD (TextEncoder)", function () {
        const cases = [
            ["\ud800", "\ufffd"], ["\udc00", "\ufffd"], ["\udbff", "\ufffd"],
            ["\udfff", "\ufffd"], ["\ud800a", "\ufffda"], ["a\udc00", "a\ufffd"],
            ["\ud800\ud83d\ude00", "\ufffd\ud83d\ude00"]
        ];
        for (const [input, normalized] of cases) {
            EQ(H.utf8Encode(input), Buffer.from(input, "utf8").toString("binary"),
                "lone surrogate " + JSON.stringify(input) + " -> Buffer parity");
            EQ(H.utf8Decode(H.utf8Encode(input)), normalized,
                "lone surrogate normalizes to " + JSON.stringify(normalized));
        }
    });

    suite.test("Q5 G6 utf8ByteLength equals utf8Encode(x).length for every input class", function () {
        // A wrong byte length here is a wrong Content-Length on the wire.
        const inputs = ["", "hello", "caf\u00e9", "\u65e5\u672c\u8a9e",
            "\ud83d\ude00", "\ud800\udc00", "\udbff\udfff",
            "\ud800", "\udc00", "\ud800a", "a\udc00",
            "mixed \u00e9 \ud83d\ude00 \u4e2d \ud800 end"];
        for (const s of inputs) {
            EQ(H.utf8ByteLength(s), H.utf8Encode(s).length,
                "byteLength == encoded length for " + JSON.stringify(s));
            EQ(H.utf8ByteLength(s), Buffer.byteLength(s, "utf8"),
                "Buffer.byteLength parity for " + JSON.stringify(s));
        }
        // The specific pre-parity bug: astral chars counted as 6, not 4.
        EQ(H.utf8ByteLength("\ud83d\ude00"), 4, "emoji is 4 bytes, not 6");
        EQ(H.utf8ByteLength("\ufeff"), 3, "BOM is 3 bytes");
    });

    suite.test("Q5 BOM and >BMP text survive the codec byte-exactly", function () {
        EQ(H.base64Encode(H.utf8Encode("\ufeff")), "77u/", "BOM only");
        EQ(H.base64Encode(H.utf8Encode("\ufeffabc")), "77u/YWJj", "BOM + ASCII");
        EQ(H.utf8Decode(H.utf8Encode("\ufeffabc")), "\ufeffabc", "BOM is data, never stripped");
        const astral = "\ud83d\ude00\ud83c\udf0d\udbff\udfff";
        EQ(H.utf8Decode(H.utf8Encode(astral)), astral, "astral roundtrip");
    });

    // =====================================================================
    // G7 — utf8Decode is the WHATWG decoder (error grouping)
    // =====================================================================
    suite.test("Q5 G7 utf8Decode rejects overlong / surrogate / out-of-range forms", function () {
        // byte strings -> expected decode (WHATWG, hardcoded: Node's ICU
        // TextDecoder groups errors differently)
        const cases = [
            ["\u00c0\u0080", "\ufffd\ufffd", "overlong NUL (C0 80)"],
            ["\u00c1\u0081", "\ufffd\ufffd", "overlong (C1 81)"],
            // E0 80: 80 is below E0's raised lower bound (A0), so the sequence
            // errors there and the trailing 80 is a stray continuation — TWO
            // U+FFFD, not three (WHATWG error grouping, verified vs ESB64).
            ["\u00e0\u0080\u0080", "\ufffd\ufffd", "overlong 3-byte (E0 80 80)"],
            ["\u00f0\u0080\u0080\u0080", "\ufffd\ufffd\ufffd", "overlong 4-byte"],
            ["\u00e0\u009f\u00bf", "\ufffd\ufffd", "E0 lower bound (9F < A0)"],
            ["\u00ed\u00a0\u0080", "\ufffd\ufffd", "surrogate-encoded (ED A0 80)"],
            ["\u00ed\u00bf\u00bf", "\ufffd\ufffd", "ED upper bound (BF > 9F)"],
            ["\u00f4\u0090\u0080\u0080", "\ufffd\ufffd\ufffd", "> U+10FFFF (F4 90 …)"],
            ["\u00f5\u0080\u0080\u0080", "\ufffd\ufffd\ufffd\ufffd", "F5 start byte"],
            ["\u00ff\u00fe", "\ufffd\ufffd", "FF FE"],
            ["\u0080", "\ufffd", "stray continuation"],
            ["\u00c2", "\ufffd", "truncated 2-byte at EOF"],
            ["\u00f0\u009f\u0098", "\ufffd", "truncated 4-byte at EOF"],
            ["\u00c3\u0090/", "\u00d0/", "valid 2-byte then ASCII"]
        ];
        for (const [bytes, expected, why] of cases) {
            EQ(H.utf8Decode(bytes), expected, why);
        }
    });

    suite.test("Q5 G7 utf8Decode reprocesses valid start bytes after an error (WHATWG)", function () {
        // A bad continuation must not swallow the byte that follows it: the
        // next valid start byte begins a NEW sequence.
        EQ(H.utf8Decode("\u00c2A"), "\ufffdA", "ASCII after bad continuation is kept");
        EQ(H.utf8Decode("\u00e0\u00a0A"), "\ufffdA", "truncated 3-byte then ASCII");
        EQ(H.utf8Decode("\u00c2\u00c3\u00a9"), "\ufffd\u00e9", "bad lead then a valid sequence");
        // stray continuation bytes are DISCARDED, not reprocessed
        EQ(H.utf8Decode("a\u0080b"), "a\ufffdb", "stray continuation between ASCII");
    });

    suite.test("Q5 utf8Decode matches TextDecoder on every valid sequence", function () {
        const strings = ["hello", "caf\u00e9", "\u65e5\u672c\u8a9e", "\u03c0",
            "\ud83d\ude00", "\ud800\udc00", "\udbff\udfff", "\ufeffabc",
            "\u0000\u007f\u0080\u07ff\u0800\uffff"];
        for (const s of strings) {
            const bytes = H.utf8Encode(s);
            const td = new TextDecoder("utf-8", { ignoreBOM: true })
                .decode(Buffer.from(bytes, "binary"));
            EQ(H.utf8Decode(bytes), td, "TextDecoder parity for " + JSON.stringify(s));
            EQ(H.utf8Decode(bytes), s, "roundtrip " + JSON.stringify(s));
        }
    });

    suite.test("Q5 utf8Decode leaves pure-ASCII byte strings identical", function () {
        let ascii = "";
        for (let i = 0; i < 128; i++) { ascii += String.fromCharCode(i); }
        EQ(H.utf8Decode(ascii), ascii, "ASCII identity (incl. NUL and DEL)");
        EQ(H.utf8Decode(""), "", "empty string");
    });

    // =====================================================================
    // Never-throw contract: the strict helpers throw, the LIBRARY does not
    // =====================================================================
    suite.test("Q11 strict codec throws never escape through request()", function () {
        // base64Encode/Decode are btoa/atob-strict, so the wire paths use the
        // non-throwing internal lanes. A body full of non-latin1 text and a
        // corrupt base64 body must both still produce a Result.
        // NOTE (T19 clean-reset): with native ALIVE (default responder), a
        // request to port 1 SUCCEEDS (the fake DLL answers 200), so the old
        // "port 1 fails" assumption no longer holds. Force a native
        // transport-error envelope so the wire lane returns an error Result
        // deterministically (never-throw is what's under test, not the port).
        const savedResp = env.controls.nativeState.responder;
        env.controls.setNativeResponder(function () {
            return {
                abi: "http-v1", ok: false, status: 0, statusText: "", headers: {},
                body: "", bodyEncoding: "utf8", error: { code: "connect", message: "boom", category: "transport", retryable: true },
                meta: { path: "native", finalUrl: "http://127.0.0.1:1/x", redirects: 0, timeMs: 1,
                        bytes: 0, tlsVersion: null, httpVersion: null,
                        encodingWasApplied: false, nativeVersion: "1.0.0",
                        winhttpError: null, backend: "winhttp" }
            };
        });
        let r = null;
        env.assertNoThrow(function () {
            r = eshttp.request({ url: "http://127.0.0.1:1/x", method: "POST",
                                 body: "\ud800 lone surrogate \u4e2d\u6587" });
        }, "non-latin1 body must not throw");
        A(r !== null && typeof r === "object", "a Result was returned");
        A(r.error !== null, "transport error surfaces as a Result, not a throw");

        env.assertNoThrow(function () {
            r = eshttp.request({ url: "http://127.0.0.1:1/x", bodyIsBase64: true, body: "!!!not base64!!!" });
        }, "corrupt base64 body must not throw");
        A(r !== null && r.error !== null, "returns an error Result");
        // restore the default responder (healthy native for the base64 tests)
        env.controls.setNativeResponder(savedResp);
    });

    // Two-lane codec contract (blackboard contracts/codec/base64-utf8):
    // STRICT public helpers throw InvalidCharacterError (btoa/atob/WHATWG
    // semantics — the ESB64-parity surface), while the INTERNAL wire lanes
    // (_base64EncodeBytes L606 / _base64DecodeLenient L629) are non-throwing
    // because api-spec promises request() ALWAYS returns a Result. These two
    // lanes must NEVER be collapsed: making the helper lenient would break
    // btoa/atob parity; making the wire lane strict would break never-throw.
    // The same corrupt input must throw on the helper and survive on the wire.
    suite.test("Q11 two-lane codec contract: strict helper throws, wire lane returns Result (same corrupt input)", function () {
        const corrupt = "!!!not@valid#base64!!!";
        // STRICT lane — the public helper must throw InvalidCharacterError.
        throwsInvalidChar(function () { H.base64Decode(corrupt); },
            "helpers.base64Decode must stay btoa/atob-strict on corrupt input");

        // WIRE lane — the identical corrupt bytes through request() must
        // produce a Result, never a throw (bodyIsBase64 opt). The outcome
        // depends on the active transport (native alive -> fake responder
        // returns an envelope); never-throw is the contract under test.
        let r = null;
        env.assertNoThrow(function () {
            r = eshttp.request({ url: "http://127.0.0.1:1/x", bodyIsBase64: true, body: corrupt });
        }, "wire lane must not throw on the same corrupt input");
        A(r !== null && typeof r === "object" && typeof r.body === "string",
            "wire lane returns a well-formed Result, not a throw");

        // WIRE lane — native envelope bodyEncoding:base64 with the same
        // corrupt bytes degrades to a Result and preserves bodyText.
        env.controls.setNativeResponder(function () {
            return {
                abi: "http-v1", ok: true, status: 200, statusText: "OK",
                headers: { "content-type": "application/octet-stream" },
                body: corrupt, bodyEncoding: "base64", error: null,
                meta: { path: "native", finalUrl: "http://127.0.0.1:1/bin", redirects: 0,
                        timeMs: 1, bytes: 0, tlsVersion: null, httpVersion: "1.1",
                        encodingWasApplied: false, nativeVersion: "1.0.0",
                        winhttpError: null, backend: "winhttp" }
            };
        });
        eshttp.forceTransport("native");
        r = null;
        env.assertNoThrow(function () { r = eshttp.request({ url: "http://127.0.0.1:1/bin" }); },
            "native envelope lane must not throw");
        A(r !== null && typeof r.body === "string", "body is a string");
        EQ(r.bodyText, corrupt, "bodyText keeps the raw base64 form on the wire lane");
        });

    suite.test("Q5 native base64 envelope with a corrupt body degrades, never throws", function () {
        // The stub JSON-stringifies whatever the responder returns, so the
        // responder must hand back an OBJECT, not a pre-encoded string.
        env.controls.setNativeResponder(function () {
            return {
                abi: "http-v1", ok: true, status: 200, statusText: "OK",
                headers: { "content-type": "application/octet-stream" },
                body: "!!!not@valid#base64!!!", bodyEncoding: "base64", error: null,
                meta: { path: "native", finalUrl: "http://127.0.0.1:1/bin", redirects: 0,
                        timeMs: 1, bytes: 0, tlsVersion: null, httpVersion: "1.1",
                        encodingWasApplied: false, nativeVersion: "1.0.0",
                        winhttpError: null, backend: "winhttp" }
            };
        });
        eshttp.forceTransport("native");
        let r = null;
        env.assertNoThrow(function () { r = eshttp.request({ url: "http://127.0.0.1:1/bin" }); },
            "malformed base64 in the DLL envelope must not throw");
        A(r !== null && typeof r.body === "string", "body is still a string");
        EQ(r.bodyText, "!!!not@valid#base64!!!", "bodyText keeps the raw base64 form");
        });

    suite.test("Q5 valid native base64 envelope still decodes exactly", function () {
        const raw = "a\u0000b\u00e9\u00ff";
        const b64 = H.base64Encode(raw);
        env.controls.setNativeResponder(function () {
            return {
                abi: "http-v1", ok: true, status: 200, statusText: "OK",
                headers: { "content-type": "application/octet-stream" },
                body: b64, bodyEncoding: "base64", error: null,
                meta: { path: "native", finalUrl: "http://127.0.0.1:1/bin", redirects: 0,
                        timeMs: 1, bytes: raw.length, tlsVersion: null, httpVersion: "1.1",
                        encodingWasApplied: false, nativeVersion: "1.0.0",
                        winhttpError: null, backend: "winhttp" }
            };
        });
        eshttp.forceTransport("native");
        const r = eshttp.request({ url: "http://127.0.0.1:1/bin" });
        EQ(r.body, raw, "binary body decoded byte-exactly");
        EQ(r.bodyText, b64, "bodyText is the base64 form");
        });

    // =====================================================================
    // Regression tests for opt-js _base64EncodeBytes optimization (t2-js-opt)
    // The internal _base64EncodeBytes (non-throwing wire lane) was fused from
    // double-pass to single-pass for non-latin1/binary input. These tests
    // exercise the slow path through parseHttpResponse which uses it for bodyBytes.
    // =====================================================================
    suite.test("Q5 regression: _base64EncodeBytes slow path (non-latin1 body) via parseHttpResponse", function () {
        // parseHttpResponse uses _base64EncodeBytes internally for bodyBytes
        // Non-latin1 body triggers the slow path (masking + encoding fused)
        const bodies = [
            "hello\u0100world",                    // single non-latin1 char
            "a\u00e9b\u00ffc",                     // multiple non-latin1
            "\u0100\u0101\u0102\u0103",            // all non-latin1
            "binary\x00\x01\x02\xff\xfe\xfd",      // binary-like bytes
            "mixed\u00e9\u4e2d\u0000end",          // mixed latin1 + CJK + NUL
            "a".repeat(1000) + "\u0100",           // large body with non-latin1
        ];
        for (const body of bodies) {
            const raw = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " + body.length + "\r\n\r\n" + body;
            const parsed = H.parseHttpResponse(raw, 1000000);
            A(parsed.bodyBytes !== undefined, "bodyBytes present for " + JSON.stringify(body));
            A(typeof parsed.bodyBytes === "string", "bodyBytes is string for " + JSON.stringify(body));
            // bodyBytes should be valid base64 that decodes back to the masked body
            const decoded = H.base64Decode(parsed.bodyBytes);
            // The body is masked to latin1 (charCode & 0xFF) before encoding
            let expected = "";
            for (let i = 0; i < body.length; i++) {
                expected += String.fromCharCode(body.charCodeAt(i) & 0xFF);
            }
            EQ(decoded, expected, "bodyBytes roundtrip for " + JSON.stringify(body));
        }
    });

    suite.test("Q5 regression: _base64EncodeBytes fast path (latin1-only body) via parseHttpResponse", function () {
        // Latin1-only body takes the fast path (delegates to _b64EncodeRaw)
        const bodies = [
            "hello world",
            "a".repeat(100),
            "a".repeat(1000),
            "a".repeat(10000),
            "\x00\x01\x02\x7f\x80\xff",  // full latin1 range
            "",                           // empty body
        ];
        for (const body of bodies) {
            const raw = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " + body.length + "\r\n\r\n" + body;
            const parsed = H.parseHttpResponse(raw, 1000000);
            A(parsed.bodyBytes !== undefined, "bodyBytes present for " + JSON.stringify(body));
            const decoded = H.base64Decode(parsed.bodyBytes);
            EQ(decoded, body, "bodyBytes roundtrip (fast path) for " + JSON.stringify(body));
            // Also verify it matches native btoa
            EQ(parsed.bodyBytes, btoa(body), "bodyBytes matches btoa for " + JSON.stringify(body));
        }
    });

    suite.test("Q5 regression: _base64EncodeBytes handles chunked response bodies", function () {
        // Chunked encoding exercises the dechunk path then bodyBytes encoding
        // Chunk sizes must match the string length of each data chunk (latin1 byte string)
        const body = "hello\u0100world\u00e9test";  // non-latin1 in chunked body
        // "hello" = 5 chars, "\u0100wo" = 3 chars, "rld\u00e9" = 4 chars, "test" = 4 chars
        const chunked = "5\r\nhello\r\n3\r\n\u0100wo\r\n4\r\nrld\u00e9\r\n4\r\ntest\r\n0\r\n\r\n";
        const raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n" + chunked;
        const parsed = H.parseHttpResponse(raw, 1000000);
        A(parsed.bodyBytes !== undefined, "bodyBytes present for chunked");
        const decoded = H.base64Decode(parsed.bodyBytes);
        // The dechunked body should be the concatenated data chunks
        const expectedBody = "hello\u0100world\u00e9test";
        let expected = "";
        for (let i = 0; i < expectedBody.length; i++) {
            expected += String.fromCharCode(expectedBody.charCodeAt(i) & 0xFF);
        }
        EQ(decoded, expected, "chunked bodyBytes roundtrip");
    });

    suite.test("Q5 regression: _base64EncodeBytes bodyBytes survives 204/304/HEAD (no body)", function () {
        // 204 No Content, 304 Not Modified, and HEAD responses have no body
        const cases = [
            "HTTP/1.1 204 No Content\r\n\r\n",
            "HTTP/1.1 304 Not Modified\r\n\r\n",
            "HEAD / HTTP/1.1\r\n\r\n",
        ];
        for (const raw of cases) {
            const parsed = H.parseHttpResponse(raw, 1000000);
            EQ(parsed.body, "", "body empty for " + raw.split("\r\n")[0]);
            EQ(parsed.bodyBytes, "", "bodyBytes empty for " + raw.split("\r\n")[0]);
        }
    });

    suite.test("Q5 regression: _base64EncodeBytes large body (exceeds flush threshold)", function () {
        // Body larger than _B64_FLUSH (128) exercises the flush logic
        const body = "a".repeat(500) + "\u0100" + "b".repeat(500);  // ~1001 chars with non-latin1
        const raw = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " + body.length + "\r\n\r\n" + body;
        const parsed = H.parseHttpResponse(raw, 1000000);
        A(parsed.bodyBytes !== undefined, "bodyBytes present for large body");
        const decoded = H.base64Decode(parsed.bodyBytes);
        let expected = "";
        for (let i = 0; i < body.length; i++) {
            expected += String.fromCharCode(body.charCodeAt(i) & 0xFF);
        }
        EQ(decoded, expected, "large bodyBytes roundtrip");
        // Verify length is correct (base64 of 1001 bytes = 1336 chars with padding)
        A(parsed.bodyBytes.length > 1300, "bodyBytes length reasonable for 1001 bytes");
    });
};







