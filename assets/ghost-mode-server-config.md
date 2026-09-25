# Making www.majikl.com an "internet ghost"

Goal: the page stays fully public with no login, but search engines and crawlers do not
index it, do not list it, and ideally never fetch it. It is reachable only by someone who
already knows the exact URL.

There is no single setting that does all of this. It works in layers. The three files you
now have cover the parts that live in the page and at the site root. This document adds the
server header, which is the strongest layer, plus an honest list of what these controls
cannot do.

## The three layers, and why you want all of them

1. In-page meta tags (already added to the HTML head).
   Handles compliant crawlers that fetch and parse the HTML. Directives include noindex,
   nofollow, noarchive, nosnippet, noimageindex, and a no-referrer policy so the secret URL
   is not leaked in the Referer header when a visitor clicks an outbound link.

2. robots.txt at the site root (provided as robots.txt).
   Asks compliant crawlers, including AI scrapers, not to fetch the page at all.

3. X-Robots-Tag HTTP response header (configured below).
   The strongest layer. It applies the noindex directive at the HTTP level, so it works even
   for non-HTML responses and even when a crawler does not parse the page body. Serve it on
   every response for this page.

Belt and suspenders is the right posture here. Ship all three.

## X-Robots-Tag header, per host

Pick the block that matches where the page is hosted. The header value used throughout is:

    noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate

### Nginx

    location = /index.html {
        add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate" always;
    }

To apply it to the whole site, put the add_header line inside the server block instead:

    server {
        # ... existing config ...
        add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate" always;
    }

### Apache (.htaccess at the site root)

    <IfModule mod_headers.c>
        Header set X-Robots-Tag "noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate"
    </IfModule>

### Netlify (netlify.toml at the repo root)

    [[headers]]
      for = "/*"
      [headers.values]
        X-Robots-Tag = "noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate"

Netlify also serves your robots.txt automatically if it is in the publish directory.

### Cloudflare Pages (_headers file in the output directory)

    /*
      X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate

### Vercel (vercel.json at the repo root)

    {
      "headers": [
        {
          "source": "/(.*)",
          "headers": [
            { "key": "X-Robots-Tag", "value": "noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate" }
          ]
        }
      ]
    }

### Cloudflare in front of any origin (Transform Rule)

If Cloudflare proxies the domain, add a Response Header Transform Rule:
set X-Robots-Tag to the value above for all requests on majikl.com.

## Verify it is working

After deploy, from a terminal:

    curl -sI https://www.majikl.com/ | grep -i x-robots-tag
    curl -s  https://www.majikl.com/robots.txt

The first should print the X-Robots-Tag line. The second should print the disallow rules.
You can also paste the URL into a search engine with a site: query, for example
`site:majikl.com`, and confirm nothing shows up once crawlers have re-processed the site.
If the page was ever indexed before, use Google Search Console's Removals tool and Bing
Webmaster Tools to speed up removal; the noindex header will keep it out going forward.

## What these controls genuinely cannot do

Being honest so there are no surprises.

1. A URL is a secret only as long as it stays secret. Anyone you send it to can share it,
   paste it into a chat that gets crawled, or post it publicly. None of these controls stop
   that. If the link leaks, the page is reachable.

2. robots.txt and meta and header directives are voluntary. Mainstream engines (Google,
   Bing, DuckDuckGo, and the major AI crawlers) honor them. Bad-actor scrapers and unknown
   bots can ignore all of them. The only way to hard-block a non-compliant bot is at the
   server or firewall level (block by user agent or IP, or add a per-request access rule),
   and even that is an ongoing cat-and-mouse effort. The genuinely reliable hard control is
   authentication, which you have ruled out.

3. The hostname is not a secret. When you get a TLS certificate for www.majikl.com, the
   hostname is published in public Certificate Transparency logs. Anyone can discover that
   the hostname exists by searching those logs, for example on crt.sh. They will not get the
   page content or the path, but the existence of the host is public. If even the hostname
   must stay hidden, you would need a wildcard certificate and an unguessable subdomain, or
   an unguessable long path on a shared host, which raises the same do-not-leak-the-URL point
   as item 1.

4. The Internet Archive (Wayback Machine) largely stopped honoring robots.txt for archiving.
   The noarchive directive helps with search-engine caches. To keep the page out of the
   Wayback Machine specifically, request exclusion directly through archive.org.

5. Direct navigation, DNS lookups, and referral analytics on sites you link to can still
   reveal that the page was visited. The no-referrer policy in the page reduces referral
   leakage from outbound clicks, but inbound analytics on the hosting side still see hits.

## Practical recommendation

Ship all three layers (meta tags, robots.txt, X-Robots-Tag header). Never publish the URL
anywhere public, never submit it to a search engine or sitemap, and treat the URL itself as
the access secret. That combination gives you a page that is public, login-free, and absent
from search and crawler indexes, which is exactly the ghost behavior you asked for, within
the honest limits above.
