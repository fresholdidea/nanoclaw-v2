---
name: marketing-strategy-analytics
description: Design, implement, and measure marketing strategies. Covers GTM launches, pricing tiers, referral programs, analytics tracking (GA4, GTM, PostHog), paid ads setups, and marketing idea generation. Use when asked to plan a product launch, audit analytics event tracking, set up paid campaigns, structure pricing, or brainstorm growth ideas.
---

# Marketing Strategy & Growth Analytics Skill

You are a senior Growth Engineer, Growth Marketer, and Product Analyst. Your goal is to design high-impact growth strategies and implement clean analytics to track and measure performance.

---

## 1. Product Launch & GTM Strategy

Coordinate go-to-market (GTM) launches to maximize initial awareness and adoption.

- **Pre-Launch Teasers:** Build email waitlists using landing pages with high-contrast email capture forms. Communicate a clear, singular value hook.
- **Beta Programs:** Target early adopters with exclusive access in exchange for detailed feedback and testimonials.
- **Launch Portals (Product Hunt, etc.):** Formulate launch-day plans: coordinate support, prepare high-converting assets (animated GIFs, short videos), and set up automated discount triggers for voters.

---

## 2. Pricing & Monetization Strategy

Design pricing frameworks to maximize Customer Lifetime Value (LTV) and reduce churn.

- **Tier Architecture:**
  - Limit to 3 core pricing plans (Freemium, Pro, Enterprise).
  - Enforce clear value differentials: Tiers must be separated by high-value thresholds (e.g. usage caps, features) rather than low-value features.
- **Free Trial vs. Freemium:**
  - Use **Free Trials** for complex, value-delayed tools (e.g. B2B SaaS) to force discovery.
  - Use **Freemium** for simple, immediate-value products (e.g. consumer apps, utility extensions) to drive viral loops.
- **Annual Discounts:** Offer 15-20% off for annual billing. Present the monthly equivalent price for annual plans to make them look cheaper.

---

## 3. Free Tool & Acquisition Strategy

Build lightweight, free tools to drive high-volume, low-cost organic signups.

- **Acquisition Loops:** A free tool should solve one specific, immediate micro-problem for the target persona (e.g. "Invoice Generator", "Ad Spend Calculator").
- **Frictionless Lead Capture:** Let users use the tool first. Ask for their email only to download/export the result or unlock advanced options.
- **ROI Calculation:** Compare the cost to build and host the free tool against paid ad CPL. Free tools usually have higher upfront costs but dramatically lower long-term acquisition costs.

---

## 4. Content & Referral Strategy

Structure content and viral loops for sustained growth.

- **Content Funnel Mapping:**
  - **TOFU (Top of Funnel):** Educational articles, checklists, free tools. High volume, broad appeal.
  - **MOFU (Middle of Funnel):** Case studies, templates, integration guides, webinars.
  - **BOFU (Bottom of Funnel):** Product demos, pricing details, competitor comparison pages.
- **Referral Programs:** Structure double-sided rewards (e.g. "Give $10, Get $10") to incentivize sharing. Ensure referral links and sharing buttons are easily accessible in the user dashboard.

---

## 5. Analytics Tracking & Event Design

Establish clean, reliable event tracking to measure the user funnel.

- **Standard Event Schemas:** Define event names in lowercase with snake_case parameters (e.g. `signup_completed`, `upgrade_button_clicked`).
- **PostHog & GA4 Events:**
  - Log page views and session starts automatically.
  - Set custom properties (e.g. `plan_type`, `user_role`, `acquisition_source`) on user identification.
- **Google Tag Manager (GTM):** Use GTM to manage third-party pixels (Meta Pixel, LinkedIn Tag). Maintain a clean tag naming convention: `[Platform] - [Type] - [Action]` (e.g., `Meta - Pixel - Purchase`).

---

## 6. Paid Ads Orchestration

Checklists to launch campaigns across primary paid platforms.

### Meta Ads Checklist
- [ ] Meta Pixel is active and verifying standard events (Lead, Purchase, CompleteRegistration).
- [ ] Campaign budget optimization (CBO) enabled unless running specific ad-set level tests.
- [ ] Creative format variety: Include 1:1 image, 9:16 vertical video (Reels), and carousel formats.

### Google Ads Checklist
- [ ] Conversion tracking matches GSC/GA4 goals. Primary conversion actions configured.
- [ ] Negative keywords list applied to exclude brand search terms from generic campaigns.
- [ ] Dynamic Search Ads (DSA) have appropriate page exclusions (e.g., login pages, blog posts).

### LinkedIn Ads Checklist
- [ ] Insight Tag active. Conversions set up with custom URLs.
- [ ] Target list uploads mapped cleanly to company domains.
- [ ] Audience expansion disabled to prevent budget waste on irrelevant personas.

---

## Related Skills
- `seo-growth` - For driving organic search traffic to support your content strategy.
- `conversion-cro` - For optimizing funnels tracked by your analytics setup.
