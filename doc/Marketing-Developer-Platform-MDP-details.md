## Table of Contents
- [LinkedIn App Sharing — What's Actually Possible](#linkedin-app-sharing--whats-actually-possible)
- [Community Management API vs. Marketing Developer Platform](#community-management-api-vs-marketing-developer-platform)
- [The Hard Truth About Personal Profile Posting](#the-hard-truth-about-personal-profile-posting)
- [The Realistic Pivot for a SaaS Product](#the-realistic-pivot-for-a-saas-product)
- [What This Means for Your Architecture](#what-this-means-for-your-architecture)
- [How It Works](#how-it-works)
- [The Catch — Back to the Same Wall](#the-catch--back-to-the-same-wall)
- [Practical Recommendation](#practical-recommendation)
- [What This Means Strategically](#what-this-means-strategically)
- [The Honest Path Forward](#the-honest-path-forward)
- [The Scope Picture Is Now Clearer](#the-scope-picture-is-now-clearer)
- [What the Community Management API Actually Gets You](#what-the-community-management-api-actually-gets-you)
- [Your Application Checklist](#your-application-checklist)
- [Recommended Sequencing](#recommended-sequencing)
- [LinkedIn OAuth 2.0 Scope Use Case Table](#linkedin-oauth-20-scope-use-case-table)
- [Scope Combinations and What They Unlock Together](#scope-combinations-and-what-they-unlock-together)
- [What This Means for Your Application](#what-this-means-for-your-application)
- [Complete LinkedIn OAuth 2.0 Scope Catalog](#complete-linkedin-oauth-20-scope-catalog)
- [Key Takeaways for Your Application](#key-takeaways-for-your-application)

# Marketing Developer Platform (MDP) - details

**Created:** 4/2/2026 20:36:50  
**Updated:** 5/18/2026 8:42:21  
**Exported:** 5/18/2026 8:42:53  
**Link:** [https://claude.ai/chat/227ea2f1-a94e-4de9-93b1-aa289fd4832b](https://claude.ai/chat/227ea2f1-a94e-4de9-93b1-aa289fd4832b)  


From what I can tell, I have  access rights to the following endpoints and more:



/rest/assets	ACTION w_organization_social	



/rest/assets	ACTION w_organization_social	



/rest/assets	ACTION w_organization_social	



/rest/assets	ACTION w_organization_social	



/rest/assets/{assetId}	GET	w_organization_social



/rest/images FINDER w_organization_social, rw_ads	



/rest/images	BATCH_GET	w_organization_social, r_organization_social, w_member_social	



/rest/images	ACTION w_organization_social, rw_ads, w_member_social	



/rest/images/{imageId}	PARTIAL_UPDATE	w_organization_social, rw_ads, w_member_social	



/rest/images/{imageId}	GET	w_organization_social, r_organization_social, w_member_social



/rest/posts	BATCH_GET	r_organization_social	



/rest/posts	FINDER r_organization_social	



/rest/posts	FINDER r_organization_social	



/rest/posts	CREATE	w_organization_social, w_member_social	



/rest/posts/{postUrn}	GET	r_organization_social	



/rest/posts/{postUrn}	DELETE	w_organization_social, w_member_social	



/rest/posts/{postUrn}	PARTIAL_UPDATE	w_organization_social, w_member_social		


## Prompt:
4/2/2026, 8:36:51 PM

Am I able to share my LinkedIn app to let anybody other than myself post LinkedIn content through?



## Response:
4/2/2026, 8:37:04 PM

Yes, but with important caveats depending on what you mean by "anybody."

## LinkedIn App Sharing — What's Actually Possible
[back to top ↩](#table-of-contents)

**Short answer:** LinkedIn restricts who can use your app based on your product access tier, and "anybody" requires specific approval.

---

### The Three Scenarios

**1. Your own accounts only (current state)**
By default, a LinkedIn app can only authenticate *you* (the app developer/owner). This is what you have now.

**2. A closed set of known users**
You can allow specific LinkedIn members to OAuth through your app without any special approval — they just need to authorize via your OAuth flow. This works today. However, LinkedIn limits the number of authorized members on unapproved apps (typically **~10-25 members** in "development mode").

**3. Truly open / anybody**
This requires LinkedIn to grant your app **Marketing Developer Platform (MDP)** access, which involves:
- A formal application/review process
- A legitimate business use case
- Compliance with LinkedIn's API Terms of Service
- Typically, a verified company behind the app

---

### The Relevant LinkedIn Product Access Tiers

| Tier | Who Can Use It | Approval Needed |
|------|---------------|-----------------|
| Default (Sign In with LinkedIn) | Limited test users | No |
| Community Management API | Org page posting (not personal) | Yes |
| Marketing Developer Platform | Broad member posting | Yes — significant bar |
| Compliance API | Regulated industries | Yes — very high bar |

---

### The Practical Implication for Your Architecture

Your multi-tenant SaaS model *does* require MDP-level access if tenants are arbitrary LinkedIn members posting personal profile content. For **org/company page posting**, the Community Management API is the more attainable path.

**Recommendation:** Before building multi-tenant onboarding flows, confirm which LinkedIn content surfaces you're targeting — personal profiles vs. company pages — because the approval path and API surface are completely different, and personal profile posting at scale is significantly harder to get approved for.

Have you already applied for or received any elevated LinkedIn API access beyond the default app?



## Prompt:
4/2/2026, 8:45:08 PM

No I have not. I just finished building the application I could do personal posts. Next up is to broaden our user base.

Is accessing the community  management API a stepping stone to marketing developer platform?



## Response:
4/2/2026, 8:45:28 PM

Not exactly — they're parallel tracks, not a ladder.

````plaintext
Web Search: LinkedIn Community Management API vs Marketing Developer Platform access requirements 2025
````

> **Increasing Access - LinkedIn | Microsoft Learn** [microsoft.com](https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access?view=li-lms-2025-11)
>
> **Migration Guide for Community Management API - LinkedIn | Microsoft Learn** [microsoft.com](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-api-migration-guide?view=li-lms-2026-02)
>
> **LinkedIn API | Community Management API** [linkedin.com](https://developer.linkedin.com/product-catalog/marketing/community-management-api)
>
> **Marketing API FAQ - LinkedIn | Microsoft Learn** [microsoft.com](https://learn.microsoft.com/en-us/linkedin/marketing/lms-faq?view=li-lms-2026-02)
>
> **Community Management - Overview - LinkedIn | Microsoft Learn** [microsoft.com](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2025-11)
>
> **LinkedIn Marketing API Program Access Tiers - LinkedIn | Microsoft Learn** [microsoft.com](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/marketing-tiers?view=li-lms-2025-11)
>
> **Community Management App Review - LinkedIn | Microsoft Learn** [microsoft.com](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2026-02)
>
> **LinkedIn Community Management API | Mixpost Documentation** [mixpost.app](https://docs.mixpost.app/services/social/linked-in/community-management-api/)
>
> **LinkedIn API: How to Get Access, What It Costs, and Better ...** [outx.ai](https://www.outx.ai/blog/linkedin-api-guide)
>
> **Migrate to the new Community Management API and continue to support the growth of your customers’ professional communities** [linkedin.com](https://www.linkedin.com/developers/news/featured-updates/community-management-migration)
>
They're parallel tracks, not a ladder. Here's the full picture:

---

## Community Management API vs. Marketing Developer Platform
[back to top ↩](#table-of-contents)

### They Solve Different Problems

| | Community Management API | Marketing Developer Platform |
|---|---|---|
| **Posts on behalf of** | Company/org pages | Ad campaigns & analytics |
| **Personal profiles** | Closed permission (`r_member_social`) — not generally available | Not in scope |
| **Your use case fit** | Partial — org pages only | No — it's ad-focused |
| **Approval bar** | Moderate | High |

**Neither one unlocks personal profile posting for arbitrary users.** That permission (`r_member_social`) is a closed permission — meaning LinkedIn controls access on a case-by-case basis and it is not generally available to third-party apps.

---

## The Hard Truth About Personal Profile Posting
[back to top ↩](#table-of-contents)

Your current app posts on *your own* personal profile because you authenticated as yourself. Extending that to arbitrary users requires `r_member_social` at scale, and LinkedIn has effectively locked that down. Tools like Buffer, Hootsuite, and later Taplio have it because they negotiated access years ago — the door is much narrower now.

---

## The Realistic Pivot for a SaaS Product
[back to top ↩](#table-of-contents)

The most attainable path that aligns with your existing architecture is:

1. **Target company page posting** via Community Management API — this is approvable, has a clear review process, and fits a SaaS model well
2. **Require your tenants to be org page admins** — this is actually a better B2B product fit anyway (businesses pay for tools, not individuals)

The Community Management APIs are only available to registered legal organizations for commercial use cases — personal email addresses won't pass vetting, and you must have a business email, legal name, registered address, website, and privacy policy.

---

## What This Means for Your Architecture
[back to top ↩](#table-of-contents)

Before investing further in multi-tenant personal profile flows, you have a fork-in-the-road decision:

- **Path A:** Pivot to company page posting — approvable, SaaS-friendly, B2B market
- **Path B:** Pursue `r_member_social` directly — long shot, no guaranteed approval, LinkedIn's discretion entirely

Do you have a registered business entity behind this project? That's the gate LinkedIn checks first for the Community Management API, and it would shape which path is even viable for you right now.



## Prompt:
4/2/2026, 8:48:56 PM

If others want to use my software to post LinkedIn content through, do they have to set up their own developer account or could they post content through my LinkedIn app?



## Response:
4/2/2026, 8:49:10 PM

They can post through **your** LinkedIn app — that's the standard OAuth model. They do **not** need their own developer account.

---

## How It Works
[back to top ↩](#table-of-contents)

When a user wants to use your app:

1. They click "Connect LinkedIn" in your UI
2. They're redirected to LinkedIn's OAuth consent screen — **under your app's branding/credentials**
3. They authorize your app to act on their behalf
4. LinkedIn issues an access token tied to **their** profile but scoped to **your** app
5. Your app stores that token and uses it to post on their behalf

They never see your client ID/secret. They just see a LinkedIn permission dialog. This is identical to how Buffer, Hootsuite, etc. work.

---

## The Catch — Back to the Same Wall
[back to top ↩](#table-of-contents)

This works fine technically, but you're still gated by what **your app's approved permissions** are. Specifically:

- Your app can only request scopes LinkedIn has granted **your app**
- Personal profile posting (`r_member_social` / `w_member_social`) is a **closed scope** — even if users OAuth through your app, if LinkedIn hasn't granted your app that scope, the tokens won't have it
- Right now, your app works for **you** because you authenticated during development — LinkedIn gives developers limited self-testing ability

So the user experience of "sign in with LinkedIn and post" is straightforward to build. **Getting LinkedIn to approve your app to do that for arbitrary users is the real obstacle** — not the OAuth mechanics.

---

## Practical Recommendation
[back to top ↩](#table-of-contents)

Given where you are, the most pragmatic next step is probably:

1. **Apply for Community Management API** (company page posting) now — you have a working app to demonstrate, which is what LinkedIn wants to see in the review
2. **Build the OAuth multi-user flow** in parallel — the code is the same regardless of which scopes get approved
3. **Simultaneously contact LinkedIn developer support** and ask directly about `w_member_social` access for a SaaS use case — you may get a clearer answer than the documentation gives

Do you have a registered business entity and a privacy policy URL? Those are the two things that will immediately block or unblock your Community Management API application.



## Prompt:
4/2/2026, 9:25:52 PM

Can I scale the creation of LinkedIn apps using the API?  What if I create software for people to post it through, which also offers a one-clickability to create and connect a LinkedIn app with their version of the software I wrote?



## Response:
4/2/2026, 9:26:14 PM

Great question — and a creative workaround attempt. The short answer is **no, LinkedIn doesn't offer an API to programmatically create apps.**

## What This Means Strategically
[back to top ↩](#table-of-contents)

The idea you're describing — customers bring their own LinkedIn app credentials — is actually a **real pattern** used by some SaaS tools, but it shifts burden onto the user and is a terrible onboarding experience. Tools like Zapier have done this with some platforms but it's a last resort, not a feature.

The **correct architecture** for what you're building is:

```
Your one LinkedIn app (approved for the right scopes)
        ↓
Multiple users OAuth through YOUR app
        ↓
You store their tokens, post on their behalf
```

This is exactly how Buffer, Hootsuite, Taplio, and every other LinkedIn scheduling tool works. **One app, many users.** The bottleneck is solely LinkedIn approving your app for the right scopes.

---

## The Honest Path Forward
[back to top ↩](#table-of-contents)

| What you want | What LinkedIn actually allows |
|---|---|
| Personal profile posting for many users | `w_member_social` — closed scope, case-by-case approval |
| Company page posting for many users | Community Management API — approvable with registered business |
| Programmatic app creation | Does not exist |
| One-click credential setup for tenants | Technically possible but ToS-risky and bad UX |

The pivotal question remains: do you have a registered business entity? That single fact determines whether the Community Management API path is open to you right now — and that's likely your fastest route to a multi-user product.



## Prompt:
4/3/2026, 10:44:13 AM

I have access to a registered business entity, yes, and have set one up in the past.



## Response:
4/3/2026, 10:44:36 AM

Good — that unblocks the Community Management API path. Before you invest time in the application, there's one more strategic question worth settling first.

---

## The Scope Picture Is Now Clearer
[back to top ↩](#table-of-contents)

`r_member_social` is a closed permission — LinkedIn is not accepting access requests at this time due to resource constraints. That's a hard stop on **reading** personal profile posts. However, `w_member_social` (writing/posting) tells a different story.

The Community Management API's content management features — covering creation, modification, and reading of rich content on behalf of organizations or brands — require `w_organization_social`, `r_organization_social`, and `w_member_social`.

That last scope — `w_member_social` — is significant. The Community Management API **does** include personal profile posting capability, specifically for employee advocacy (resharing org content through employee profiles). It's not unlimited personal posting, but it's a legitimate door.

---

## What the Community Management API Actually Gets You
[back to top ↩](#table-of-contents)

| Capability | Included |
|---|---|
| Company page posts | ✅ Full — text, images, video, carousels, polls |
| Personal profile posting | ✅ Limited — employee resharing/advocacy use case |
| Read personal feed | ❌ `r_member_social` closed entirely |
| Arbitrary personal posting | ❌ Not supported under any current program |

---

## Your Application Checklist
[back to top ↩](#table-of-contents)

Since you have a registered business entity, here's exactly what you need assembled before applying:

**Hard requirements — missing any one of these gets you rejected:**
- Business email address (no Gmail/personal)
- Legal business name, registered address
- Public-facing website
- Privacy policy URL
- LinkedIn Company Page with you as super admin
- App logo that contains no LinkedIn/Microsoft branding

**What LinkedIn will evaluate:**
- Your use case description — needs to align with their supported solutions
- A working demo (Development tier first, then a screen recording for Standard tier upgrade)
- Data handling and storage practices

---

## Recommended Sequencing
[back to top ↩](#table-of-contents)

1. **Apply for Community Management API Development tier now** — your existing working app is your strongest asset; you have something real to demonstrate
2. **Pivot your SaaS framing toward company pages as the primary use case** — personal profile posting as a secondary feature (employee advocacy), not the headline
3. **Build your multi-tenant OAuth flow in parallel** — the code doesn't change based on approval status
4. **Target Standard tier within 12 months** — you must upgrade to Standard tier within twelve months of receiving Development tier access to move to live production and remove API call restrictions

The registered business entity was the gating factor. You're now in a position to actually apply. Do you want to work through what your use case description should say — that's the part most applications get wrong?



## Prompt:
4/4/2026, 11:28:16 AM

Build me a use case table around OAuth 2.0 permission scopes:

 w_organization_social, r_organization_social, and w_member_social.



## Response:
4/4/2026, 11:28:43 AM

>
Here's a comprehensive use case table built directly from LinkedIn's official documentation and what each scope actually permits within the Community Management API.

---

## LinkedIn OAuth 2.0 Scope Use Case Table
[back to top ↩](#table-of-contents)

### `w_organization_social` — Write to Organization Pages
*Post, comment, and like on behalf of an organization*

| Use Case | What Your App Can Do | Applies To |
|---|---|---|
| Company page publishing | Create text, image, video, carousel, and poll posts | Org page tenants |
| Comment management | Post comments on org page content on behalf of admins | Org page tenants |
| Reaction management | Like/react to posts on behalf of the org | Org page tenants |
| Comment editing | Edit existing page comments | Org page admins |
| @mention members | Tag members in posts using People Typeahead API | Org page admins |
| AI content publishing | Push AI-generated content directly to company pages | Core agent feature |
| Scheduled posting | Queue and auto-publish org content at optimal times | Core agent feature |

---

### `r_organization_social` — Read from Organization Pages
*Retrieve organizations' posts, comments, likes, and analytics*

| Use Case | What Your App Can Do | Applies To |
|---|---|---|
| Post retrieval | Fetch existing org posts for analysis or display | Dashboard |
| Engagement monitoring | Read comments and reactions on org posts | Dashboard |
| Follower statistics | Lifetime and time-bound follower counts | Analytics |
| Page statistics | View and click stats for org/brand pages | Analytics |
| Share statistics | Aggregate performance data across date ranges | Analytics |
| Video analytics | Retrieve play counts, watch time, viewer metrics | Analytics |
| Content performance | Feed AI pipeline with what content is resonating | Agent feedback loop |
| Social action notifications | Real-time alerts for new comments and @mentions | Engagement feature |

---

### `w_member_social` — Write on Behalf of Individual Members
*Post, comment, and like on behalf of an authenticated member*

| Use Case | What Your App Can Do | Applies To |
|---|---|---|
| Employee advocacy | Members reshare company page content to their profiles | Brand amplification |
| Profile-level reactions | Like/react to posts on behalf of authenticated users | Engagement feature |
| Profile-level comments | Comment on posts as an authenticated individual | Engagement feature |
| Content amplification | Employees boost org posts through their own networks | Core SaaS differentiator |

> ⚠️ **Critical constraint:** `w_member_social` within the Community Management API is specifically scoped to enabling brands to leverage employee networks for content resharing and amplification via employee profiles — it is not a general-purpose personal profile posting scope. It is not a replacement for the closed `r_member_social` permission, and LinkedIn draws a hard line between employee advocacy and arbitrary personal posting.

---

## Scope Combinations and What They Unlock Together
[back to top ↩](#table-of-contents)

| Combination | Unlocks |
|---|---|
| `w_organization_social` only | Publish to org pages — no analytics, no reading back |
| `r_organization_social` only | Read-only analytics dashboard — no publishing |
| `w_organization_social` + `r_organization_social` | Full org page management — publish, read, analyze |
| All three | Full org management **plus** employee advocacy resharing |

---

## What This Means for Your Application
[back to top ↩](#table-of-contents)

The practical SaaS story you should tell LinkedIn in your application is:

**Primary use case** → `w_organization_social` + `r_organization_social`: AI-generated content publishing and performance analytics for company pages managed by your tenants.

**Secondary use case** → `w_member_social`: Employees of those organizations resharing company content to amplify brand reach — a defensible, LinkedIn-approved pattern.

What you should **not** frame as a use case is arbitrary personal profile posting — LinkedIn is not accepting access requests for `r_member_social` at this time due to resource constraints, and framing `w_member_social` as general personal posting would likely trigger rejection.

The employee advocacy angle is your strongest argument for including `w_member_social` — and it's a genuinely valuable SaaS feature that tools like Sprout Social and Hootsuite charge premium tier prices for.



## Prompt:
4/4/2026, 11:30:38 AM

Are these three scopes a complete listing or are other available?



## Response:
4/4/2026, 11:31:12 AM

Let me pull the full current scope catalog directly from LinkedIn's documentation.

No — those three are not a complete listing. They're just the three required for content management. Here is the full picture pulled directly from LinkedIn's official permissions table.

---

## Complete LinkedIn OAuth 2.0 Scope Catalog
[back to top ↩](#table-of-contents)

Organized by which API product grants them. Your Community Management API application is highlighted.

### Open Permissions — No Approval Required

These are available to all developers via self-service in the Developer Portal.

| Scope | Description | Auth Type |
|---|---|---|
| `profile` | Member's name, headline, and photo | 3-legged |
| `email` | Member's primary email address | 3-legged |
| `w_member_social` | Post, comment, like on behalf of a member | 3-legged |

> ⚠️ `w_member_social` appears here **and** under Community Management API — but access through the open "Share on LinkedIn" product is more limited in practice than what Community Management grants.

---

### Community Management API Scopes — ★ Your Target

The full scope set granted upon Community Management API approval is:

| Scope | Description | What It Enables for Your App |
|---|---|---|
| `w_organization_social` | Post, comment, like on org's behalf | AI content publishing to company pages |
| `w_organization_social_feed` | Manage social actions for org pages you admin | Deeper engagement management on org posts |
| `r_organization_social` | Read org posts, comments, engagement data | Analytics, content performance feedback loop |
| `r_organization_social_feed` | Read social actions for orgs you admin | Community management focused reading |
| `r_organization_followers` | Access followers' data for @mention in posts | People Typeahead / @mention capability |
| `rw_organization_admin` | Manage org pages and retrieve reporting data | Admin role management, page settings |
| `w_member_social` | Post, comment, like on member's behalf | Employee advocacy / resharing |
| `w_member_social_feed` | Create, modify, delete comments and reactions as a member | Member-level engagement actions |
| `r_basicprofile` | Member name, photo, headline, public URL | Basic identity for authenticated users |
| `r_1st_connections_size` | Count of member's 1st-degree connections | Network size context |
| `r_member_profileAnalytics` | Profile viewers, followers, search appearances | Personal profile analytics *(API v202504+)* |
| `r_member_postAnalytics` | Post-level analytics for member content | Post performance data *(API v202506+)* |

---

### Advertising API Scopes — Separate Approval Track

| Scope | Description |
|---|---|
| `r_ads` | Read member's advertising accounts |
| `rw_ads` | Manage and read ad accounts |
| `r_ads_reporting` | Retrieve advertising account reports |
| `r_organization_admin` | Org page reporting (follower, visitor, content analytics) |
| `rw_dmp_segments` | Create/manage matched audiences *(Matched Audiences API — requires Advertising first)* |
| `rw_media_plans` | Manage media plans *(Media Planning API — requires Advertising first)* |

---

### Other Approved API Scopes

| Scope | Program | Description |
|---|---|---|
| `rw_conversions` | Conversions API | Upload and manage conversion tracking data |
| `r_marketing_leadgen_automation` | Lead Sync API | Access lead gen forms and retrieve leads |
| `r_liteprofile` | Lead Sync / Conversions API | Member name and photo (lightweight) |
| `r_events` | Events Management API | Retrieve org events |
| `rw_events` | Events Management API | Create and manage org events |

---

### Compliance Scopes — Permanently Closed

| Scope | Description |
|---|---|
| `r_compliance` | Retrieve activity for compliance monitoring/archiving |
| `w_compliance` | Manage and delete data for compliance |

Access to compliance permissions is closed and may not be requested.

---

### Sales Navigator Scopes — Separate Partner Program

| Scope | Description |
|---|---|
| `r_sales_nav_analytics` | Sales Navigator analytics |
| `r_sales_nav_display` | Display services for Sales Navigator |
| `r_sales_nav_validation` | CRM data validation *(2-legged)* |
| `r_sales_nav_profiles` | Matched public member profile info *(2-legged)* |

---

## Key Takeaways for Your Application
[back to top ↩](#table-of-contents)

**You already had 3 of the 12 Community Management scopes in mind.** The ones worth noting that you likely didn't account for:

- **`r_organization_social_feed`** and **`w_organization_social_feed`** are distinct from their non-feed counterparts — the `_feed` variants are Community Management API exclusive and give you tighter, admin-scoped access
- **`rw_organization_admin`** is required if your tenants need to manage page settings or you need to verify admin roles programmatically
- **`r_member_profileAnalytics`** and **`r_member_postAnalytics`** are new additions (2025) that give you personal analytics data — potentially valuable for a future personal profile analytics feature
- **`r_organization_followers`** is the gate for the @mention/People Typeahead feature, which is a meaningful engagement differentiator

None of the Advertising, Sales Navigator, or Compliance scopes are relevant to your current product direction.





---
Powered by [Claude Exporter](https://www.ai-chat-exporter.net)