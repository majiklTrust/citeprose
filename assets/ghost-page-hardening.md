# Hardening the secret-URL page (www.majikl.com) without adding a login

Your design is a capability URL: the long unguessable path is the only secret, the page is
public, and noindex keeps it out of search. This document keeps that model but plugs the
leak and transport gaps, and offers one optional upgrade (a signed, expiring link) that adds
real expiry and revocation without a login wall.

Read the priorities in order. Item 0 buys you more safety than everything else combined.

## 0. Limit the exposure window (highest value, no code)

The page exists to pass Stripe account activation. Treat its public life as temporary:
publish the URL, let Stripe verify, then once the account is activated either take the page
down or move it behind Cloudflare Access or a real login. A leaked link can only hurt you
while the page is live, so shrinking that window from "forever" to "a few days" is the single
biggest improvement available. Stripe itself expects access blockers to be removed only
temporarily during verification, so a short public window matches their process.

## 1. Force HTTPS and turn on HSTS

The secret path is only hidden on the wire if the request is encrypted. Never let plain HTTP
serve or redirect the page in cleartext more than the one initial bounce.

Nginx:

    server {
        listen 80;
        server_name www.majikl.com majikl.com;
        return 301 https://www.majikl.com$request_uri;
    }

    server {
        listen 443 ssl;
        server_name www.majikl.com;
        # ... ssl_certificate etc ...
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    }

Once you are confident every subdomain is HTTPS only, consider submitting the domain to the
HSTS preload list so browsers never try HTTP even on first visit.

## 2. Serve the noindex and privacy directives as HTTP headers too

The meta tags only exist inside the HTML. Duplicating them as response headers covers edge
cases and is the server-side source of truth. Scope this to the one path so the rest of the
site is unaffected.

Nginx (exact-match location for the secret page):

    location = /YOUR-SECRET-PATH.html {
        add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet, noimageindex" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header Cache-Control "private, no-store, max-age=0" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Content-Security-Policy "frame-ancestors 'none'" always;
    }

What each one buys you:
- X-Robots-Tag: the header form of your noindex, read even if HTML parsing is skipped.
- Referrer-Policy: reinforces the meta referrer so the URL is not leaked on outbound clicks.
- Cache-Control private, no-store: keeps shared and CDN caches from retaining a copy of the
  page at an address someone else might reach.
- X-Content-Type-Options nosniff: stops content-type games.
- Content-Security-Policy frame-ancestors 'none': stops the page being embedded in an iframe
  on another site, which is one more way a URL and its content get surfaced.

Apache equivalent (.htaccess), wrapped so it applies to the one file:

    <Files "YOUR-SECRET-PATH.html">
        Header set X-Robots-Tag "noindex, nofollow, noarchive, nosnippet, noimageindex"
        Header set Referrer-Policy "no-referrer"
        Header set Cache-Control "private, no-store, max-age=0"
        Header set X-Content-Type-Options "nosniff"
        Header set Content-Security-Policy "frame-ancestors 'none'"
    </Files>

## 3. Do not let the server reveal structure

- Turn off directory listing so the parent folder cannot be browsed.
  Nginx: autoindex off;  Apache: Options -Indexes
- Return an identical generic 404 for wrong paths, so probing cannot distinguish "exists but
  forbidden" from "does not exist." A static page at an unguessable path already behaves this
  way; just confirm there is no custom error that echoes the requested path back.
- Publish no sitemap that includes this page, and never link to it from any other page on the
  site or from any public profile.

## 4. Keep the page self-contained

The delivered page already inlines all CSS and makes no third-party requests, which matters
more than it looks: every external font, script, image, or analytics call would send this
page's URL in the Referer header to that third party and land in their logs. Keep it that way.
If you ever add analytics, use a first-party or server-side method, not a third-party tag.

## 5. Keep the bad-bot User-Agent block

The server-level 403 block from bad-bot-useragent-block.md still applies site-wide and is
worth keeping. It will not stop a scraper that already has the URL and spoofs a browser UA,
but it turns away the honest commercial crawlers.

## Optional upgrade: a signed, expiring link (expiry and revocation, still no login)

A plain capability URL never expires and cannot be revoked short of changing the path. If you
want a link you can time-box or invalidate, sign it. The visitor still just clicks a URL, so
there is no login prompt, but the link stops working after a deadline or after you rotate the
secret.

### Option A: Nginx secure_link (no app code)

    # http or server context
    # secret is a server-side key the visitor never sees
    location = /YOUR-SECRET-PATH.html {
        secure_link $arg_sig,$arg_exp;
        secure_link_md5 "$secure_link_expires YOUR-SECRET-PATH.html YOUR_SERVER_SIDE_SECRET";

        if ($secure_link = "") { return 403; }   # signature did not validate
        if ($secure_link = "0") { return 410; }  # link expired

        # ... serve the file, plus the headers from section 2 ...
    }

You then hand out URLs of the form:

    https://www.majikl.com/YOUR-SECRET-PATH.html?exp=<unix-expiry>&sig=<base64url-md5-hmac>

Generate the signature server-side. Rotating YOUR_SERVER_SIDE_SECRET instantly invalidates
every link ever issued.

### Option B: application-level HMAC check

If a small app or serverless function sits in front, verify an HMAC token before serving:

    // pseudocode
    const [exp, sig] = [query.exp, query.sig]
    if (Date.now()/1000 > Number(exp)) return respond(410)   // expired
    const expected = base64url(hmacSha256(SERVER_SECRET, `${PATH}:${exp}`))
    if (!timingSafeEqual(sig, expected)) return respond(403) // bad signature
    // else serve the page with the section 2 headers

Tradeoff to weigh for Stripe: a verifier needs the link to work during the whole review
window, so set the expiry generously (for example a week or two) or be ready to re-issue a
fresh signed link if it lapses mid-review. Expiry and revocation are the upside; a link that
dies at the wrong moment is the downside, so tune the TTL to the job.

## Honest bottom line

With items 0 through 5 in place you have a public, login-free page that is out of search,
hard to intercept, hard to cache or embed, and not discoverable without the URL. That is a
strong version of the ghost model. What no amount of hardening changes is the core property:
the URL is the credential, and anyone who obtains it can view the page. If that residual risk
is unacceptable, the only real fix is a gate (Cloudflare Access with an email allowlist, or a
login), which trades away the no-login requirement. For a time-boxed Stripe activation page,
the capability URL plus a short exposure window is a reasonable and proportionate choice.
