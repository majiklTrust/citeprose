# Server-level hard block for the worst-behaved scrapers (www.majikl.com)

This is a different layer from robots.txt and the noindex tags. Those are polite requests
that good crawlers honor. This layer is a hard block: it inspects the User-Agent on every
incoming request and returns HTTP 403 Forbidden to a curated list of aggressive scrapers,
whether or not they would have honored robots.txt.

Apply this site-wide, not just to the one page. Aggressive SEO and data-broker crawlers hit
every path they can find, so blocking them at the edge protects the whole domain and reduces
load. It does not affect real visitors or the search engines you may still want on the rest
of the site (Googlebot, Bingbot, and similar are not in this list).

## Honest limits, so there are no surprises

1. User-Agent is self-reported and trivially spoofable. This block stops the honest-but-greedy
   commercial crawlers that identify themselves (Ahrefs, Semrush, Bytespider, and the like).
   A determined scraper can set its User-Agent to look like Chrome and walk right past it.
2. For adversaries that spoof a browser UA, the tools that actually help are rate limiting,
   Cloudflare Bot Fight Mode or managed challenges, and IP reputation blocking. Those are
   separate from this file. Say the word and I will add a rate-limit config too.
3. Keep the list under review. New scrapers appear constantly; treat the list below as a
   starting set you extend over time.

## The block list

Case-insensitive match on any of these User-Agent substrings returns 403:

    Bytespider, PetalBot, MJ12bot, AhrefsBot, SemrushBot, DotBot, BLEXBot, DataForSeoBot,
    Barkrowler, SeekportBot, serpstatbot, ZoominfoBot, MegaIndex, SearchmetricsBot, BUbiNG,
    360Spider, Sogou, MauiBot, magpie-crawler, GrapeshotCrawler, SEOkicks, Riddler, Cliqzbot,
    CensysInspect, zgrab, masscan, l9explore, Nuclei, Expanse, NetSystemsResearch,
    InternetMeasurement

Pick the block that matches your host.

## Nginx

Put the map in the http context (for example a file in /etc/nginx/conf.d/), then the guard
inside the server block.

    # /etc/nginx/conf.d/00-bad-bots.conf   (http context)
    map $http_user_agent $majikl_bad_bot {
        default 0;
        "~*(?:Bytespider|PetalBot|MJ12bot|AhrefsBot|SemrushBot|DotBot|BLEXBot|DataForSeoBot|Barkrowler|SeekportBot|serpstatbot|ZoominfoBot|MegaIndex|SearchmetricsBot|BUbiNG|360Spider|Sogou|MauiBot|magpie-crawler|GrapeshotCrawler|SEOkicks|Riddler|Cliqzbot|CensysInspect|zgrab|masscan|l9explore|Nuclei|Expanse|NetSystemsResearch|InternetMeasurement)" 1;
    }

    # inside your server { } block:
    server {
        # ... existing config ...
        if ($majikl_bad_bot) {
            return 403;
        }

        # optional: also refuse requests that send no User-Agent at all
        if ($http_user_agent = "") {
            return 403;
        }
    }

Reload with: nginx -t and then systemctl reload nginx

## Apache (.htaccess at the site root, Apache 2.4)

    <IfModule mod_rewrite.c>
        RewriteEngine On
        RewriteCond %{HTTP_USER_AGENT} (Bytespider|PetalBot|MJ12bot|AhrefsBot|SemrushBot|DotBot|BLEXBot|DataForSeoBot|Barkrowler|SeekportBot|serpstatbot|ZoominfoBot|MegaIndex|SearchmetricsBot|BUbiNG|360Spider|Sogou|MauiBot|magpie-crawler|GrapeshotCrawler|SEOkicks|Riddler|Cliqzbot|CensysInspect|zgrab|masscan|l9explore|Nuclei|Expanse|NetSystemsResearch|InternetMeasurement) [NC]
        RewriteRule .* - [F,L]
    </IfModule>

The [F] flag returns 403 Forbidden. [NC] makes the match case-insensitive.

## Cloudflare (WAF custom rule)

Dashboard: Security, then WAF, then Custom rules, then Create rule.
Action: Block. Use this expression (contains works on every plan):

    (lower(http.user_agent) contains "bytespider") or (lower(http.user_agent) contains "petalbot") or (lower(http.user_agent) contains "mj12bot") or (lower(http.user_agent) contains "ahrefsbot") or (lower(http.user_agent) contains "semrushbot") or (lower(http.user_agent) contains "dotbot") or (lower(http.user_agent) contains "blexbot") or (lower(http.user_agent) contains "dataforseobot") or (lower(http.user_agent) contains "barkrowler") or (lower(http.user_agent) contains "seekportbot") or (lower(http.user_agent) contains "serpstatbot") or (lower(http.user_agent) contains "zoominfobot") or (lower(http.user_agent) contains "megaindex") or (lower(http.user_agent) contains "searchmetricsbot") or (lower(http.user_agent) contains "bubing") or (lower(http.user_agent) contains "360spider") or (lower(http.user_agent) contains "sogou") or (lower(http.user_agent) contains "mauibot") or (lower(http.user_agent) contains "magpie-crawler") or (lower(http.user_agent) contains "grapeshotcrawler") or (lower(http.user_agent) contains "seokicks") or (lower(http.user_agent) contains "censysinspect") or (lower(http.user_agent) contains "zgrab") or (lower(http.user_agent) contains "masscan") or (lower(http.user_agent) contains "l9explore") or (lower(http.user_agent) contains "nuclei") or (lower(http.user_agent) contains "expanse")

On Pro plans and above you can instead use one regex condition:

    http.user_agent matches "(?i)(bytespider|petalbot|mj12bot|ahrefsbot|semrushbot|dotbot|blexbot|dataforseobot|barkrowler|seekportbot|serpstatbot|zoominfobot|megaindex|searchmetricsbot|bubing|360spider|sogou|mauibot|magpie-crawler|grapeshotcrawler|seokicks|censysinspect|zgrab|masscan|l9explore|nuclei|expanse)"

Turning on Cloudflare's Bot Fight Mode in the same Security area adds behavior-based blocking
that catches many UA-spoofing scrapers the list above cannot.

## Vercel (middleware.ts at the project root)

    import { NextRequest, NextResponse } from 'next/server'

    const BAD_BOTS = /(bytespider|petalbot|mj12bot|ahrefsbot|semrushbot|dotbot|blexbot|dataforseobot|barkrowler|seekportbot|serpstatbot|zoominfobot|megaindex|searchmetricsbot|bubing|360spider|sogou|mauibot|magpie-crawler|grapeshotcrawler|seokicks|riddler|cliqzbot|censysinspect|zgrab|masscan|l9explore|nuclei|expanse|netsystemsresearch|internetmeasurement)/i

    export function middleware(req: NextRequest) {
        const ua = req.headers.get('user-agent') || ''
        if (ua === '' || BAD_BOTS.test(ua)) {
            return new NextResponse('Forbidden', { status: 403 })
        }
        return NextResponse.next()
    }

    export const config = { matcher: '/:path*' }

## Netlify (edge function, netlify/edge-functions/bad-bots.js)

    const BAD_BOTS = /(bytespider|petalbot|mj12bot|ahrefsbot|semrushbot|dotbot|blexbot|dataforseobot|barkrowler|seekportbot|serpstatbot|zoominfobot|megaindex|searchmetricsbot|bubing|360spider|sogou|mauibot|magpie-crawler|grapeshotcrawler|seokicks|riddler|cliqzbot|censysinspect|zgrab|masscan|l9explore|nuclei|expanse|netsystemsresearch|internetmeasurement)/i

    export default async (request, context) => {
        const ua = request.headers.get('user-agent') || ''
        if (ua === '' || BAD_BOTS.test(ua)) {
            return new Response('Forbidden', { status: 403 })
        }
        return context.next()
    }

    export const config = { path: '/*' }

## Verify it works

Replace the host and try a blocked User-Agent. You should get 403; a normal browser UA should
get 200.

    curl -s -o /dev/null -w "%{http_code}\n" -A "AhrefsBot/7.0" https://www.majikl.com/
    curl -s -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" https://www.majikl.com/

The first should print 403, the second 200.
