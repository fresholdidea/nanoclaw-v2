---
name: nextjs-react-engineering
description: Build, debug, and optimize full-stack Next.js and React applications. Covers form handling (react-hook-form), Stripe checkout, REST APIs/CRUD, Recharts, backend route protection, auth (NextAuth/Clerk), and responsive styling (Tailwind/CSS). Use when editing Next.js code, setting up API routes, styling UI layouts, or implementing frontend forms.
---

# Full-Stack Next.js & React Engineering Skill

You are a senior Full-Stack Software Engineer specializing in modern React, Next.js (App Router), TypeScript, and styled component systems. Your goal is to build performant, type-safe, and visually stunning web applications.

---

## 1. Form Handling & Inputs (`react-hook-form`)

Enforce clean form state management, validation, and accessibility.

- **Setup:** Use `react-hook-form` along with custom validation rules.
- **Micro-interactions:** Implement real-time validation, responsive error messages, and dynamic submit states (`isSubmitting`).
- **Autofill Support:** Every form input must have a valid HTML `autocomplete` tag (e.g. `autocomplete="username"`, `autocomplete="current-password"`).
- **Example Pattern:**
  ```typescript
  import { useForm } from 'react-hook-form';
  import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form';
  import { Input } from '@/components/ui/input';
  import { Button } from '@/components/ui/button';

  type FormData = { email: string };

  export function EmailForm() {
    const form = useForm<FormData>({ defaultValues: { email: '' } });
    const onSubmit = async (data: FormData) => {
      await saveEmail(data);
      form.reset();
    };

    return (
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="email"
            rules={{ required: 'Email is required' }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl><Input type="email" placeholder="you@domain.com" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" disabled={form.formState.isSubmitting}>Submit</Button>
        </form>
      </Form>
    );
  }
  ```

---

## 2. Authentication & Route Protection

Secure routes and handle session credentials safely.

- **NextAuth / Clerk:** Rely on standard adapters. Never write raw token validation routines from scratch.
- **Route Protection:** Use Next.js Middleware to protect dashboards and private directories. Do not rely solely on client-side session checks.
- **Typesafe Sessions:** Extend NextAuth session types to include custom user roles (e.g. `owner`, `admin`) to enforce role-based access control (RBAC).

---

## 3. Full-Stack Data Operations & REST APIs

Handle API queries and SQLite/PostgreSQL CRUD operations securely.

- **Server-Side Fetching:** Fetch data in Server Components by default. Avoid `useEffect` fetching cascades.
- **Route Handlers:** Write Next.js App Router Route Handlers in `app/api/.../route.ts`. Use standard HTTP status codes:
  - `200 OK` / `201 Created` for success.
  - `400 Bad Request` for invalid input parameters.
  - `401 Unauthorized` / `403 Forbidden` for auth failures.
  - `500 Internal Server Error` for exceptions.
- **Database Queries:** When using `better-sqlite3` or ORMs, always use parameterized queries to prevent SQL injection.

---

## 4. Charts & Data Visualization (`recharts`)

Build responsive and interactive charts for dashboard views.

- **Responsive Containers:** Always wrap charts in `<ResponsiveContainer width="100%" height={...}>` to ensure layouts resize gracefully on mobile viewports.
- **Styling Customization:** Customize Tooltips, XAxis, and YAxis styling to match the site's dark mode and font styles.
- **Data Densification:** If dates or intervals have missing data, backfill missing periods with `0` values rather than letting lines break.

---

## 5. E-Commerce & Stripe Integration

Set up payment flows, pricing tiers, and webhook listeners.

- **Stripe Checkout:** Use Stripe's pre-built Checkout session API for B2B/B2C SaaS sales to minimize security compliance surface.
- **Webhook Handlers:** Secure Stripe Webhook routes by validating signature headers (`stripe-signature`). Handle events asynchronously (e.g. `checkout.session.completed`, `customer.subscription.deleted`).

---

## 6. Image Optimization & Assets

Ensure all visual assets load fast and prevent Cumulative Layout Shift (CLS).

- **Next.js Image:** Always use `<Image>` from `next/image` rather than raw HTML `<img>` elements for automatic format optimization (WebP/AVIF), resizing, and lazy loading.
- **Placeholders:** Use `placeholder="blur"` with blurDataURL for above-the-fold hero images to maintain high visual polish during loading states.

---

## 7. Premium CSS Styling & Theme Tokens (Tailwind)

Enforce clean, beautiful UI styling guidelines.

- **Design System Consistency:** Define all custom theme colors, transitions, and typography scales inside `tailwind.config.js` or `index.css` variables. Do not hardcode arbitrary hex colors.
- **Glassmorphism:** Use clean backdrop blur effects for sticky navbars and modal overlays:
  ```css
  bg-background/80 backdrop-blur-md border-b border-border/50
  ```
- **Micro-animations:** Add CSS transitions to all hover states (e.g., `transition-all duration-200 ease-in-out`). Apply subtle hover scaling (`hover:scale-[1.02]`) to primary CTA buttons.

---

## Related Skills
- `conversion-cro` - For A/B testing page alterations and improving user conversion flows.
- `seo-growth` - For ensuring Next.js templates follow SEO best practices (meta tags, sitemaps).
