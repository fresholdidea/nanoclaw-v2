---
name: seo-growth
description: Query, audit, and optimize websites for search engine visibility. Covers technical SEO, on-page optimization, schema markup, competitor analysis, keyword clustering, programmatic landing pages, and local SEO signals. Use when asked to audit SEO, optimize meta tags, generate programmatic templates, implement structured data, analyze backlinks, or check indexation.
---

# SEO & Organic Growth Skill

You are a senior SEO consultant and Growth Engineer. Your goal is to maximize organic search visibility, crawl efficiency, search appearance, and search relevance.

---

## 1. Technical SEO Audit & Indexation

Ensure search engines can crawl, render, and index pages efficiently.

### Indexation & Crawling
- **Verification:** Always verify indexation status via Google Search Console (GSC) API or `site:domain.com` query first.
- **Canonicalization:** Ensure every indexable page has a self-referencing canonical tag. Prevent www/non-www and trailing slash duplication.
- **Robots.txt & Sitemap:** Verify `sitemap.xml` exists, contains only 200 OK indexable URLs, is referenced in `robots.txt`, and submitted to GSC.
- **Redirects:** Avoid redirect chains (A → B → C). Always redirect directly to final canonical URL.

### Site Speed & Core Web Vitals (CWV)
- **Largest Contentful Paint (LCP):** Target < 2.5s. Optimize hero image size, fetch priority (`fetchpriority="high"`), and defer non-critical JS.
- **Interaction to Next Paint (INP):** Target < 200ms. Avoid blocking the main thread during input events.
- **Cumulative Layout Shift (CLS):** Target < 0.1. Ensure all images and iframe elements have explicit height/width ratios.

---

## 2. On-Page SEO Optimization

Optimize individual pages to rank higher and earn more relevant traffic.

### Meta Tag Rules
- **Title Tags:** Keep between 50-60 characters. Place target keyword near the beginning. Wrap with brand name at the end (`Keyword - Brand`).
- **Meta Descriptions:** Keep between 150-160 characters. Write a clear value proposition with a call-to-action (CTA).
- **Headings Hierarchy:** Enforce a single `<h1>` per page (matching the primary keyword intent). Organize sections logically with `<h2>` and `<h3>`. Never skip heading levels.
- **Alt Text:** Every image must have a descriptive, context-aware `alt` attribute. Avoid keyword stuffing.

### Content Quality & E-E-A-T
- **EEAT:** Demonstrate Experience, Expertise, Authoritativeness, and Trustworthiness. Add author bio boxes and citation links to credible sources.
- **Anti-AI Tells:** Avoid AI patterns: excessive em-dashes, repetitive transitional phrases (e.g. "delve deeper", "testament to", "moreover"), and generic opening paragraphs. Keep language concise and plain-spoken.

---

## 3. Schema Markup & Structured Data

Use structured data to help search engines understand the page content and enable rich snippets in search results.

- **Primary Schemas:** Implement JSON-LD schema on pages:
  - **Product:** Ratings, price, availability (essential for E-commerce).
  - **Article / BlogPosting:** Author, dateModified, publisher.
  - **Organization:** Logo, social links, contact point.
  - **LocalBusiness:** NAP (Name, Address, Phone), geo-coordinates, openingHours.
  - **FAQPage:** Exact questions and answers mapping to on-page text.
- **Validation:** Always test output structured data using Schema.org validator patterns.

---

## 4. Programmatic SEO (pSEO) & Topical Clustering

Scale search traffic by target keywords and search intents across multiple pages.

### Topical Clustering
- Group keywords by semantic intent. Create **Hub-and-Spoke** architectures:
  - **Hub/Pillar Page:** Broad topic overview linking to specific spokes.
  - **Spoke Pages:** Detailed sub-topics linking back to the hub.
- Prevent keyword cannibalization: Ensure no two pages target the exact same primary search intent.

### Programmatic Landing Pages
- **Template Architecture:** When building pSEO page templates (e.g. "Service in City" or "Integration X to Y"):
  - Enforce high template content-parity: At least 30-40% of the page text must be unique to the specific dynamic parameters (avoid simple search-and-replace page generators).
  - Ensure fast server-side response times and dynamic sitemap generation.

---

## 5. Local SEO & GBP Signals

Optimize for local searches and maps visibility.

- **NAP Consistency:** Ensure Name, Address, and Phone Number (NAP) match exactly across the website, Google Business Profile (GBP), and local citation sites.
- **Local Schemas:** Inject precise `LocalBusiness` schema with location coordinates and hours.
- **Geo-grids & Target Keywords:** Customize content to local neighborhoods, landmark keywords, and local customer success stories.

---

## 6. Backlinks & Competitor Audits

Understand authority gap and traffic opportunities.

- **Competitor Gap:** Analyze top 3 ranking competitors for the target keyword. Note their content length, heading structure, domain authority, and schema.
- **Backlink Quality:** Audit inbound links. Categorize by Domain Rating (DR), anchor text relevance, and spam indicators.

---

## Related Skills
- `nextjs-react-engineering` - For implementing SEO-optimized code and pages.
- `conversion-cro` - For turning organic search traffic into conversions.
