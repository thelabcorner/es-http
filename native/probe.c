/* probe.c — isolate url_parse behavior (temp debug tool, not part of deliverables) */
#define WIN32_LEAN_AND_MEAN
#define ESHTTP_STATIC
#define ESHTTP_SELFTEST
#include "eshttp.c"
#pragma comment(lib, "winhttp.lib")
#include <stdio.h>
#include <string.h>

static void t(const char* url) {
    eshttp_url u;
    const char* err = NULL;
    memset(&u, 0, sizeof(u));
    int r = eshttp_st_url_parse(url, &u, &err);
    printf("r=%d url=<%s> err=<%s>", r, url, err ? err : "(none)");
    if (r == 1) {
        char* s = eshttp_st_url_tostring(&u);
        printf("  https=%d host=<%s> port=%d path=<%s> tostring=<%s>",
               u.https, u.host, u.port, u.path, s ? s : "(null)");
        free(s);
        url_free(&u);
    }
    printf("\n");
}

int main(void) {
    /* url_parse cases */
    t("http://user:pw@Example.com:8080/path?q=1#frag");
    t("https://Example.com/path");
    t("https://u:p@example.com:8443/a?b=c");
    t("http://[2001:db8::1]:8080/path");
    t("http://[::1]/x");
    t("https://[::1]:443/y");
    t("http://example.com");
    t("http://example.com?x=1");
    t("HTTP://EXAMPLE.COM/A");
    t("HtTpS://example.com/b");
    t("httpx://example.com/a");
    t("htp://example.com/a");
    t("http:/example.com/a");
    t("http//example.com/a");
    t("://example.com/a");
    t("");
    t(NULL);
    t("http://user%40x:p%40ss@host.example:1234/route");
    t("https://host.example/");
    t("http://host.example#frag");
    t("http://host.example:70000/x");
    t("http://host.example:0/x");
    t("http://:8080/x");
    t("http:///x");
    t("http://[::1/x");
    t("http://a@b@c.example/x");
    t("http://host.example:80x/x");

    /* url_resolve dot-segment cases */
    printf("\n--- url_resolve ---\n");
    {
        eshttp_url b;
        const char* e = NULL;
        const char* cases[][2] = {
            { "http://example.com/a/b", "../c" },
            { "http://example.com/a/b", "../../../x" },
            { "http://example.com/a/b", "c" },
            { "http://example.com/a/b", "." },
            { "http://example.com/a/b", ".." },
            { "http://example.com/a/b", "/x?y=1" },
            { "http://example.com/a/b", "/a/./b/../c" },
            { "http://example.com/a/b", "../c?q=../d#f" },
            { "http://example.com/a/b", "http://other.com/z/../w" },
            { "http://example.com/a/b", "//cdn.example/x" },
            { "http://example.com/", "x" },
        };
        for (size_t i = 0; i < sizeof(cases)/sizeof(cases[0]); i++) {
            if (eshttp_st_url_parse(cases[i][0], &b, &e) == 1) {
                char* r = eshttp_st_url_resolve(&b, cases[i][1]);
                printf("resolve(base=<%s> loc=<%s>) -> <%s>\n", cases[i][0], cases[i][1], r ? r : "(null)");
                free(r);
                url_free(&b);
            } else {
                printf("resolve: base parse failed <%s>\n", cases[i][0]);
            }
        }
    }
    return 0;
}
