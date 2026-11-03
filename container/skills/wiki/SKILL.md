---
name: wiki
description: Maintain the persistent compounding wiki inside Brad's Obsidian vault at `50-Wiki/` with raw sources at `50-Sources/`. Use for `/wiki ingest <source>`, `/wiki query <question>`, `/wiki lint`, or when the weekly wiki-lint scheduled task fires.
---

# Wiki Maintenance Skill

You maintain a persistent, compounding wiki knowledge base inside an Obsidian vault. The wiki sits at `/workspace/extra/obsidian/50-Wiki/` with raw sources at `/workspace/extra/obsidian/50-Sources/`. The rest of the Obsidian vault is available read-only at `/workspace/extra/obsidian/` for context (companies, people, clients, meeting notes).

Client deliverables and data files are at `/workspace/extra/clients/` (read-only).

## Architecture

Three layers:

1. **Sources** (`50-Sources/`) — immutable raw inputs. You read but never modify these. The user drops files here or gives you URLs to download.
2. **Wiki** (`50-Wiki/`) — your domain. You create and maintain all pages here: summaries, entity pages, concept pages, comparisons, syntheses.
3. **Schema** (this file) — your operating instructions.

The Wiki is the durable knowledge corpus. NanoClaw memory is only operational state and routing pointers, and the Wiki group does not use Mnemon. Do not invoke Mnemon writes from this group or copy an entire Wiki page into another memory store.

## Page Types

- **Source summaries** — one per ingested source. Key takeaways, relevance, links to entity/concept pages.
- **Entity briefs** — people, companies, tools, platforms. Cross-referenced, with a `canonical` frontmatter link when a record already exists elsewhere in the vault. Do not create a second mutable person or company record.
- **Concept pages** — ideas, strategies, frameworks, patterns.
- **Synthesis pages** — comparisons, analyses, or explorations that draw from multiple sources.

All pages use Obsidian `[[wikilinks]]` for internal links. Include YAML frontmatter with `type` (wiki-summary, wiki-entity, wiki-concept, wiki-synthesis), `sources` (list of source files), and `updated` date. A `sources: []` value is an explicit provenance gap, not permission to invent a source.

## Special Files

- **`index.md`** — catalog of every wiki page with link, one-line summary, and category. Update on every ingest. Read this first when answering queries.
- **`log.md`** — append-only chronological record. Format: `## [YYYY-MM-DD] action | Description`. Actions: ingest, query, lint, update.

## Operations

### Ingest

When the user provides a source (file, URL, or points to an existing file):

1. Save or verify the raw source in `50-Sources/`. For URLs, download the full content:
   - PDFs/files: `curl -sLo 50-Sources/filename.pdf "url"`
   - Web pages: use `agent-browser` or `WebFetch` to get full text, save as markdown in `50-Sources/`
2. Read the source thoroughly.
3. Discuss key takeaways with the user.
4. Create/update wiki pages:
   - Write a source summary page
   - Create or update entity pages for people, companies, tools mentioned
   - Create or update concept pages for ideas, strategies, frameworks
   - Add cross-references (`[[wikilinks]]`) between new and existing pages
   - Check existing pages for information that should be updated or enriched
5. Update `index.md` with all new/changed pages.
6. Append to `log.md`.

**CRITICAL — One source at a time.** When given multiple files or a folder, process each source individually and completely before moving to the next. For each source: read it, discuss takeaways, create/update ALL wiki pages (summary, entities, concepts, cross-references, index, log), and fully finish before starting the next. Never batch-read all files then process together — this produces shallow, generic pages.

### Vault context during ingest

Check existing Obsidian content for relevant context:
- `90-System/Companies/` — existing company profiles
- `90-System/People/` — existing people profiles
- `30-Areas/Clients/` — client context
- `40-Resources/` — existing reference material
- `/workspace/extra/clients/` — client deliverables and data

When an entity already exists in the vault (e.g., a company in `90-System/Companies/`), link to it rather than duplicating. Note connections between wiki content and existing vault content.

### Query

When the user asks a question:

1. Read `index.md` to locate relevant pages.
2. Read those pages.
3. Synthesize an answer with `[[wikilinks]]` citations.
4. If the answer produces valuable new synthesis, offer to save it as a wiki page.

### Lint

Periodic health check:

1. **Run the deterministic structural pass first:**
   ```bash
   node /app/skills/wiki/scripts/wiki-lint.mjs --root /workspace/extra/obsidian/50-Wiki
   ```
   Treat errors as blockers. The script checks frontmatter, index coverage, resolvable links, orphan pages, provenance fields, canonical entity links, and the maintenance backlog. It intentionally ignores historical prose in `log.md` when checking the link graph.
2. **Scan all wiki pages for:**
   - Contradictions between pages
   - Orphan pages (no inbound links)
   - Stale content superseded by newer sources
   - Missing cross-references
   - Important concepts mentioned but lacking dedicated pages
   - Gaps — topics that should be covered based on the sources
3. Report findings.
4. Offer to fix issues. Unwritten methodology candidates belong in `backlog.md` as plain text until a source supports a page; do not leave speculative broken wikilinks in active pages.
5. Append lint results to `log.md`.
