---
name: draft-invoice
description: Draft a client invoice from the canonical Drive template + Obsidian Company frontmatter. Computes hours from SolidTime for hourly clients, uses fixed amount for monthly_flat, copies and edits the per-client Drive template, exports a PDF preview, and waits for Brad's explicit "send" before dispatching via Gmail. Triggered by "draft invoice for <client>", "/draft-invoice <client>", or "create the <client> invoice for <month>".
---

# draft-invoice

Generates a client invoice end-to-end. Always ends with a preview and an approval gate — **never** sends without Brad replying "send" or "approve".

## Inputs you resolve, in order

1. **Client name** from Brad's request. Match against `/workspace/extra/obsidian/JBH/90-System/Companies/<Client>.md` aliases. If ambiguous, ask.
2. **Period** — derive from `Invoice Schedule` frontmatter:
   - `monthly` → previous full calendar month, unless Brad specified ("for May", "this month", etc.)
   - `biweekly` → trailing 14 days ending on `Invoice Next Due`
   - `bucket` → since `Last Invoice Date` (no fixed cycle)
   - If Brad explicitly named a month/range, use that.
3. **Frontmatter fields** read from the Company file:
   - `Invoice Rate`, `billing_type`, `monthly_value`, `Invoice Schedule`
   - `Invoice Next Due`, `Last Invoice Date`
   - `Billing Entity`, `Billing Email`, `Billing Method`
   - `Invoice Template` — Drive Doc ID of the canonical template for this client
   - `Solidtime Client` — exact project/client name in SolidTime
   - `Invoice Buffer` — multiplier on raw hours (e.g. 1.10 = +10%)

   **`billing_type` fallback:** if missing but `monthly_value` is set, treat as `monthly_flat`. If both missing and `Invoice Rate` is hourly-looking (< 1000), treat as `hourly` and confirm with Brad before continuing.

4. **Sender mailbox = `Billing Email`.** This is the GWS account that sends the invoice (e.g. `brad@demandgenguy.com` for DGG clients, `bradhess@usecache.com` for Cache). Pass it to `gws-account` as the account argument.

5. **Recipient resolution** (separate from sender — important):
   - Read the Company file body for an `Email:` line, typically `Email: [[<Person>|address@domain]]`. The address after `|` is the recipient.
   - If only a wikilink is present (`Email: [[Adam Meshberg]]`), open `/workspace/extra/obsidian/JBH/90-System/People/<Person>.md` and read its `email:` frontmatter.
   - If neither resolves, **stop and ask Brad** — never default the recipient.
   - Always show the resolved recipient in the preview so Brad can override.

## Step 1 — Compute the line items

### `billing_type: monthly_flat`
Total = `monthly_value`. No SolidTime call. Single line item describing the retainer for the period.

### `billing_type: hourly`
Pull hours from SolidTime. The OneCLI proxy injects `Authorization: Bearer` for `100.69.48.89` automatically — no headers needed in your `curl`.

```bash
ORG=ef6327db-3c14-4296-a9da-93966eb6b2d2
BASE=http://100.69.48.89:8088/api/v1

# 1. Resolve the SolidTime client UUID by name
CLIENT_NAME="<value of Solidtime Client frontmatter>"
CLIENT_ID=$(curl -s "$BASE/organizations/$ORG/clients" \
  | jq -r --arg n "$CLIENT_NAME" '.data[] | select(.name == $n) | .id')

# 2. Pull time entries for the period (start/end inclusive, ISO date)
curl -s "$BASE/organizations/$ORG/time-entries?client_ids[]=$CLIENT_ID&start=$START&end=$END" \
  | jq '.data | map({start, end, duration, description, project_id, task_id, billable})'
```

Sum `duration` (seconds) across billable entries → `raw_hours = sum/3600`.

Apply `Invoice Buffer` if set: `billable_hours = round(raw_hours * Invoice_Buffer, 2)`. Show both raw and buffered in the preview so Brad can see what was applied.

Total = `billable_hours * Invoice Rate`.

If hours = 0, **stop** and ask Brad — likely the SolidTime project name doesn't match `Solidtime Client`, or no time was logged. Don't generate an empty invoice.

### `billing_type: bucket`
Same hourly query, but compare `sum(billable_hours)` against `Bucket-Hours` and `Bucket-Total` from frontmatter. Flag if exceeded.

## Step 2 — Copy and edit the Drive template

The canonical templates live in Drive folder `1oa178XuJKcqpgsOmCBaG2HQbffSXkvjy`. Per-client template Doc IDs are in each Company file's `Invoice Template` field — **always** prefer that field over searching the folder.

Use the sender mailbox resolved in step 4 (the Company's `Billing Email`) as the `gws-account` account argument. That sender's Drive scope must be able to read the template Doc — if the copy call 404s, the template is owned by a different account and Brad needs to either share it with the sender or change `Billing Email`.

```bash
TEMPLATE_ID=$(grep -m1 '^Invoice Template:' "/workspace/extra/obsidian/JBH/90-System/Companies/<Client>.md" | awk '{print $3}')
SENDER="<Billing Email value>"

# Copy the template into the same Drive folder, named for the period
gws-account "$SENDER" drive files copy \
  --params '{"fileId":"'$TEMPLATE_ID'","name":"Invoice — <Client> — <YYYY-MM>"}'
# → returns new file id; capture it
```

### Discover placeholders, then substitute

You don't know the placeholder syntax in advance. Read the new copy's body once with `documents.get`, scan for `{{...}}`, `<<...>>`, `[...]`, `__...__`, or visible literal placeholders ("CLIENT NAME", "INVOICE #", "TOTAL"). Use whatever pattern actually appears.

Then issue a `documents.batchUpdate` with one `replaceAllText` request per placeholder:

```bash
gws-account "$SENDER" docs documents.batchUpdate \
  --params '{
    "documentId":"<new doc id>",
    "requests":[
      {"replaceAllText":{"containsText":{"text":"{{CLIENT}}","matchCase":true},"replaceText":"Meshberg Group"}},
      {"replaceAllText":{"containsText":{"text":"{{PERIOD}}","matchCase":true},"replaceText":"May 2026"}},
      ...
    ]
  }'
```

**Common substitutions** (adapt names to what the template actually uses):
- Client name, billing entity, billing email
- Invoice number — generate as `<CLIENT_INITIALS>-<YYYYMM>` unless the template implies a sequential scheme. If unclear, leave a `[VERIFY #]` marker and call it out in the preview message.
- Invoice date = today; Payment due = `Invoice Next Due` if it's >= today, else today + Net (read from template if visible, otherwise ask).
- Period label, hours (raw + buffered if applied), rate, line-item description, subtotal, total.
- Payment method line — pull from `Billing Method`.

If after substitution any `{{...}}`-style tokens remain, **stop and report them** — that's a placeholder you didn't catch. Don't ship a doc with leftovers.

## Step 3 — Export the preview PDF

```bash
NEW_ID="<new doc id>"
mkdir -p "/workspace/extra/clients/projects/<client-slug>/invoices"
gws-account "$SENDER" drive files export \
  --params '{"fileId":"'$NEW_ID'","mimeType":"application/pdf"}' \
  > "/workspace/extra/clients/projects/<client-slug>/invoices/Invoice — <Client> — <YYYY-MM>.pdf"
```

## Step 4 — Send Brad the preview (approval gate)

Post a single message with:
- The Drive Doc link (so he can open and edit if needed)
- Local PDF path
- Period, hours summary, total
- Recipient email + method
- Any flags (`[VERIFY #]` left in, hours buffer applied, bucket overrun, stale frontmatter, etc.)

End with: *"Reply `send` to dispatch, or edit the Doc first and then reply `send` and I'll re-export."*

**Stop here.** Do not send. Wait for Brad's explicit `send` / `approve` / `go`.

## Step 5 — On approval, send

Re-export the PDF first (in case Brad edited the Doc), then:

```bash
gws-account "$SENDER" gmail send \
  --params '{
    "to":"<resolved recipient address from step 5>",
    "subject":"Invoice — <Client> — <Period>",
    "body":"<short note from frontmatter or the template's accompanying language>",
    "attachments":["/workspace/extra/clients/projects/<client-slug>/invoices/Invoice — <Client> — <YYYY-MM>.pdf"]
  }'
```

Then update the Obsidian Company frontmatter (write back):
- `Last Invoice Date: <today YYYY-MM-DD>`
- `Invoice Next Due: <next cycle>` — for monthly, +1 month; biweekly, +14d; bucket, leave as-is.

Confirm to Brad: doc link + sent timestamp + the frontmatter update.

## What you don't do

- **Never** send without Brad's explicit approval reply.
- **Never** invent hours. If SolidTime returns nothing, surface that — don't guess.
- **Never** modify the template Doc itself. Always work on a copy.
- **Never** publish/share the new Doc beyond Brad and the billing email recipient.
- If frontmatter is missing required fields (`Invoice Template`, `Billing Email`, `Invoice Rate`), stop and ask Brad to fill them in — don't fall back to defaults.

## Related

- The follow-up nudge flow (past-due reminders) is a separate scheduled task. This skill only does generation + send.
- For ad-hoc one-off invoices that aren't tied to a Company file, ask Brad — those are rare enough to handle conversationally rather than via this skill.
