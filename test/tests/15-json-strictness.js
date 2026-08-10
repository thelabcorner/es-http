/*
 * 15-json-strictness.js — eshttp.json strictness + ESON parity regressions.
 * Guards the fixes from task t4-eson (eshttp.json ⇄ ESON differential):
 *   1. parse now rejects RFC 8259-invalid text the old parser accepted:
 *      leading zeros, bare/trailing decimal point, malformed \u escapes,
 *      raw control chars inside strings, nesting beyond depth 512.
 *   2. stringify now emits json2/ESON short escapes (\b \f \n \r \t) for
 *      control chars while keeping the documented 7-bit-clean \uXXXX for
 *      non-ASCII (api-spec §5).
 *   3. eshttp.json.parse gained an optional reviver (json2 walk semantics)
 *      with the never-throw contract preserved.
 * Corpus mirrors eson/tests/fixtures.ts + eson-test-entry.ts; the live
 * differential runs in test/parity/parity.mjs.
 */
"use strict";

module.exports = function (suite, env) {
    const eshttp = env.eshttp;
    const A = env.assert;
    const EQ = env.assertEq;

    // =====================================================================
    // 1. RFC 8259 strictness — invalid text must parse to null (never throw)
    // =====================================================================
    const invalidTexts = [
        // leading zeros
        "01", "-01", "00", "-00", "00.5", "01e1",
        // bare / trailing decimal point
        "1.", "-.5", ".5",
        // malformed \u escapes (parseInt truncation regression)
        '"\\u12g4"', '"\\u12x4"', '"\\u000x"', '"\\u00zz"', '"\\u123"', '"\\u00"',
        // raw control chars inside strings (RFC 8259 forbids U+0000..U+001F)
        '"a\nb"', '"a\tb"', '"a\rb"', '"a\u0000b"', '"\u0000"', '{"a":"b\u0000c"}',
        // misc strictness
        "1e", "1e+", "1e-", "-", "+1", "0x1", "Infinity", "NaN", "undefined",
        "1..2", "1.2.3", "truefalse", "'a'", '"a"x'
    ];

    suite.test("Q7 json strictness: 32 invalid texts parse to null, never throw", function () {
        for (let i = 0; i < invalidTexts.length; i++) {
            const t = invalidTexts[i];
            let out = "UNSET";
            env.assertNoThrow(function () { out = eshttp.json.parse(t); }, "parse must not throw: " + JSON.stringify(t));
            EQ(out, null, "must reject: " + JSON.stringify(t));
        }
    });

    suite.test("Q7 json strictness: leading zeros are rejected ('01','-01','00','-00')", function () {
        EQ(eshttp.json.parse("01"), null, "01");
        EQ(eshttp.json.parse("-01"), null, "-01");
        EQ(eshttp.json.parse("00"), null, "00");
        EQ(eshttp.json.parse("-00"), null, "-00");
        EQ(eshttp.json.parse("0"), 0, "0 still valid");
        EQ(eshttp.json.parse("-0"), 0, "-0 still valid");
        EQ(eshttp.json.parse("0.5"), 0.5, "0.5 still valid");
    });

    suite.test("Q7 json strictness: bare/trailing decimal points are rejected", function () {
        EQ(eshttp.json.parse("1."), null, "1.");
        EQ(eshttp.json.parse("-.5"), null, "-.5");
        EQ(eshttp.json.parse(".5"), null, ".5");
        EQ(eshttp.json.parse("1.5"), 1.5, "1.5 still valid");
    });

    suite.test("Q7 json strictness: malformed \\u escapes are rejected", function () {
        EQ(eshttp.json.parse('"\\u12g4"'), null, "non-hex digit in 4-char escape");
        EQ(eshttp.json.parse('"\\u000x"'), null, "non-hex 4th char");
        EQ(eshttp.json.parse('"\\u00zz"'), null, "non-hex chars");
        EQ(eshttp.json.parse('"\\u123"'), null, "short escape");
        EQ(eshttp.json.parse('"\\u0041"'), "A", "valid escape still decodes");
    });

    suite.test("Q7 json strictness: raw control chars inside strings are rejected", function () {
        EQ(eshttp.json.parse('"a\nb"'), null, "raw newline");
        EQ(eshttp.json.parse('"a\tb"'), null, "raw tab");
        EQ(eshttp.json.parse('"a\u0000b"'), null, "raw NUL mid-string");
        EQ(eshttp.json.parse('"\u0000"'), null, "raw NUL alone");
        EQ(eshttp.json.parse('{"a":"b\u0000c"}'), null, "raw NUL in value");
        EQ(eshttp.json.parse('"a\\nb"'), "a\nb", "escaped newline still valid");
        EQ(eshttp.json.parse('"a\\u0000b"'), "a\u0000b", "\\u0000 escape still valid");
    });

    // =====================================================================
    // 2. nesting depth cap (ESON MAX_DEPTH = 512 parity)
    // =====================================================================
    function deepArrayText(d) {
        let s = "0";
        for (let k = 0; k < d; k++) s = "[" + s + "]";
        return s;
    }

    suite.test("Q7 json strictness: nesting depth 512 accepted, 513/600 rejected", function () {
        const ok512 = eshttp.json.parse("[" + deepArrayText(511) + "]");
        A(ok512 !== null, "depth 512 must be accepted");
        EQ(eshttp.json.parse("[" + deepArrayText(512) + "]"), null, "depth 513 must be rejected");
        EQ(eshttp.json.parse("[" + deepArrayText(599) + "]"), null, "depth 600 must be rejected");
    });

    // =====================================================================
    // 3. stringify — json2/ESON byte parity for control chars
    // =====================================================================
    suite.test("Q7 json stringify: control chars use json2/ESON short escapes", function () {
        EQ(eshttp.json.stringify("a\nb"), '"a\\nb"', "newline");
        EQ(eshttp.json.stringify("a\tb"), '"a\\tb"', "tab");
        EQ(eshttp.json.stringify("a\rb"), '"a\\rb"', "carriage return");
        EQ(eshttp.json.stringify("a\bb"), '"a\\bb"', "backspace");
        EQ(eshttp.json.stringify("a\fb"), '"a\\fb"', "form feed");
    });

    suite.test("Q7 json stringify: other control chars use \\uXXXX", function () {
        EQ(eshttp.json.stringify("\u0000"), '"\\u0000"', "NUL");
        EQ(eshttp.json.stringify("\u001f"), '"\\u001f"', "unit separator");
        EQ(eshttp.json.stringify("\u007f"), '"\\u007f"', "DEL");
        EQ(eshttp.json.stringify("\u2028"), '"\\u2028"', "line separator");
        EQ(eshttp.json.stringify("\u2029"), '"\\u2029"', "paragraph separator");
    });

    suite.test("Q7 json stringify: 7-bit clean \\uXXXX for non-ASCII is preserved", function () {
        EQ(eshttp.json.stringify("\u00e9"), '"\\u00e9"', "e-acute");
        EQ(eshttp.json.stringify("\u4e2d"), '"\\u4e2d"', "CJK");
        EQ(eshttp.json.stringify("\ud83d\ude00"), '"\\ud83d\\ude00"', "surrogate pair");
        // and round-trips through the parser
        EQ(eshttp.json.parse(eshttp.json.stringify("\u00e9")), "\u00e9", "round-trip");
    });

    // =====================================================================
    // 4. reviver (json2 walk semantics, added for ESON parity)
    // =====================================================================
    suite.test("Q7 json parse: reviver doubles numbers bottom-up", function () {
        const out = eshttp.json.parse('{"a":{"b":1},"c":2}', function (k, v) {
            return typeof v === "number" ? v * 2 : v;
        });
        EQ(out.a.b, 2, "nested number doubled");
        EQ(out.c, 4, "top number doubled");
    });

    suite.test("Q7 json parse: reviver undefined return deletes the key", function () {
        const out = eshttp.json.parse('{"a":{"b":1},"c":2}', function (k, v) {
            return k === "b" ? undefined : v;
        });
        EQ(Object.prototype.hasOwnProperty.call(out.a, "b"), false, "key deleted");
        EQ(out.c, 2, "c preserved");
    });

    suite.test("Q7 json parse: reviver applies to arrays and root (key '')", function () {
        const arr = eshttp.json.parse('[1,{"x":2}]', function (k, v) {
            return k === "x" ? v * 10 : v;
        });
        EQ(arr[1].x, 20, "array element object key transformed");
        const root = eshttp.json.parse("7", function (k, v) {
            return k === "" && typeof v === "number" ? 99 : v;
        });
        EQ(root, 99, "root reviver");
    });

    suite.test("Q7 json parse: no reviver arg leaves the value raw; throwing reviver -> null", function () {
        const raw = eshttp.json.parse('{"a":1}');
        EQ(raw.a, 1, "raw parse unchanged");
        let r = "UNSET";
        env.assertNoThrow(function () {
            r = eshttp.json.parse('{"a":1}', function () { throw new Error("boom"); });
        }, "throwing reviver must not escape (never-throw)");
        EQ(r, null, "throwing reviver -> null");
    });

    // =====================================================================
    // 5. spot differential vs known ESON/json2 outputs (fixed gaps)
    // =====================================================================
    suite.test("Q7 json parity spot-check: eson fixture expectations hold", function () {
        EQ(eshttp.json.stringify({ a: "x" }), '{"a":"x"}', "flatObject");
        EQ(eshttp.json.stringify({ "a b": 1 }), '{"a b":1}', "spaceKey");
        EQ(eshttp.json.stringify([null, true, false]), "[null,true,false]", "scalarsArray");
        EQ(eshttp.json.stringify({ u: undefined, f: function () { return 1; } }), "{}", "undef/fn omitted");
        EQ(eshttp.json.stringify([undefined]), "[null]", "undefined -> null in arrays");
        EQ(eshttp.json.stringify(-0), "0", "negativeZero");
        EQ(eshttp.json.stringify(NaN), "null", "nan");
        EQ(eshttp.json.stringify(1e21), "1e+21", "bigExp");
        EQ(eshttp.json.parse('{"a":1,"a":2}').a, 2, "duplicate keys last wins");
        EQ(eshttp.json.parse('  { "a" : 1 }  ').a, 1, "whitespace tolerated");
        EQ(eshttp.json.parse('"\ud83d\ude00"'), "\ud83d\ude00", "surrogate pair text");
    });
};
