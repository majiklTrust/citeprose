

# Steps 1-8, Path to Marketing Developer Platform (MDP)

**Created:** 5/16/2026 13:57:18  
**Updated:** 5/17/2026 22:52:41  
**Exported:** 5/18/2026 8:29:47  
**Link:** [https://claude.ai/chat/3c20becf-2996-40d2-903b-bdfd54fb80ad](https://claude.ai/chat/3c20becf-2996-40d2-903b-bdfd54fb80ad)  



**Question 1:**
Tell us about your business and the product that will leverage API access. Please provide a detailed description otherwise your application will be rejected.
>  **Response 1:**
>
> majiklTrust Market Intelligence, LLC is an Illinois-registered B2B Software-as-a-Service company that provides an AI-powered market intelligence and content operations platform for professional organizations. Our platform — operating at ***REMOVED*** — enables marketing teams, communications professionals, and executive leadership to systematically monitor industry developments and research-backed content to their LinkedIn organization pages.
>
> The platform is architected as a multi-tenant SaaS application serving independent business clients, each of which is mapped to a single LinkedIn organization page under their administrative control. Each tenant organization onboards through a formal registration process, connects their LinkedIn organization page via OAuth 2.0 authorization, and operates within a fully isolated data environment. Our customer base consists of businesses seeking to establish and maintain a credible, consistent LinkedIn presence without the resource overhead of a dedicated content operations team.
>
> The product workflow operates in three phases. First, our research engine continuously monitors a curated portfolio of RSS and Atom news feeds spanning the client's declared industry topics. Second, our AI pipeline synthesizes and corrborates the most relevant current developments into professionally framed draft posts appropriate for a business audience on LinkedIn, subject to quality scoring, responsible AI and content safety filtering. Third, content is published to the client's connected LinkedIn organization page through a manual approval process.
>
> majiklTrust Market Intelligence operates as a registered LLC with a defined privacy policy at [privacy-policy.html](https://alpha.***REMOVED***/privacy-policy.html). We are seeking LinkedIn API access to provide our client organizations with a professional, compliant, and scalable pathway to managing their LinkedIn organization page content.

---

**Question 2:**
What do you plan to build with the APIs? Please provide a detailed description otherwise your application will be rejected. Tip: Review the restricted use cases to ensure your use case is supported.
>  **Response 2:**
>
> We are building brand management and content publishing integration that allows our business clients to publish organic posts to their LinkedIn organization pages entirely within the scope of the Community Management API.
>
> **Specific API capabilities we will use:**
>
> **Organization Page Publishing (`w_organization_social`):** Our platform publishes approved posts to the authenticated client's LinkedIn organization page using the `/rest/posts` endpoint. Posts are authored to the client's own page. All content passes through automated quality scoring and a content safety filter before submission. An authorized operator reviews and approves each post. 
>
> **Organization ACL Lookup (`r_organization_social`):** During the OAuth onboarding flow, we call `/v2/organizationAcls` to enumerate the LinkedIn organization pages the authenticating user administers. This ensures the correct page is connected to the client's workspace and that only verified page administrators can authorize the integration. The resolved organization name and URN are confirmed by the authorizing user before setup completes. If a user administers multiple organization pages, a selection screen is presented and their choice is re-verified against the ACL list before being stored — preventing a crafted URL from associating an unauthorized page with a workspace.
>
> **What we do not build:** Our integration does not interact with personal member profiles, read post engagement or analytics data, send InMail or direct messages, automate connection requests, perform member data harvesting, or perform any action not explicitly authorized by the page administrator during the OAuth consent flow.
>
> **Compliance posture:** OAuth tokens are encrypted at rest using AES-256-GCM with per-tenant HKDF-derived keys and are stored in a database scoped to the individual client tenant, never shared across accounts. Token revocation is supported through LinkedIn's native permitted-services page at linkedin.com/psettings/permitted-services. Our privacy policy at ***REMOVED*** explicitly documents LinkedIn data handling, use restrictions, and deletion procedures in alignment with LinkedIn's API Terms of Service.


