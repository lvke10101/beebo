# Beebo — Project Memory

Compact technical map. Read this before touching code. Don't re-explore
the codebase for anything already answered here — go straight to the
cited file/line/function.

## Stack & Run

- Backend: Flask + raw `sqlite3` (no ORM), single file `app.py` (~700 lines).
- DB: `beebo.db` (SQLite file, committed in repo during dev). Schema created
  in `init_db()` (`app.py:35-95`) — tables: `users`, `posts`, `post_images`,
  `comments`, `likes`.
- Frontend: single file `beebo.html` (~2930 lines) — vanilla JS, no build
  step, no framework. All views are `<div id="...-view">` blocks toggled by
  `showView(name)` (`beebo.html:1334`).
- Images stored on disk at `static/uploads/`, served via
  `/static/uploads/<filename>` route (`app.py:106`), referenced in DB as
  `post_images.image_path` (a `/static/uploads/...` URL string, not a blob).
- Auth: Flask session cookie (`session['user_id']`), secret key persisted to
  `.flask_secret_key` on disk so sessions survive server restarts.
- Two-agent AI dev workflow used for backend/frontend split: this repo's
  frontend is edited by Claude (chat), backend by Claude Code in terminal.
  When a fix needs backend changes, write a self-contained prompt for
  Claude Code rather than editing `app.py` directly — see chat history.

## Architecture map — where things live

| Concern | Location |
|---|---|
| DB schema / table creation | `app.py:35-95` (`init_db`) |
| Post creation (JSON + multipart w/ images) | `app.py:237` (`POST /api/posts`) |
| Post feed fetch (batched image join) | `app.py:352` (`GET /api/posts`) |
| Comments fetch | `app.py:465` (`GET /api/posts/<id>/comments`) |
| Post→dict shaping incl. `images` array | `app.py:424` (`row_to_post_dict`) |
| Feed rendering (post cards) | `beebo.html:1698` (`renderFeedPosts`) → `buildPostCardHtml` (`beebo.html:1645`) |
| Post image grid markup | `beebo.html:1625` (`buildPostImagesHtml`) |
| Comment/Post-detail overlay open | `beebo.html:2381` (`openCommentOverlay`) |
| Comment-button click → reads post data from DOM dataset | `beebo.html:2217-2244` |
| HTML-escaping utility (used for all dataset/attr values) | `beebo.html:1594` (`escapeHtml`) |
| Compose/publish flow | `beebo.html:2069` (`handlePostSubmit`) |

## Key data flow — post images (important, non-obvious)

Post images are **not** re-fetched when the comment overlay opens. The
overlay is populated entirely from the clicked post card's DOM
`dataset` attributes (`beebo.html:2217-2244`), which were serialized as
JSON into `data-post-images="..."` when the card was built
(`buildPostCardHtml`, `beebo.html:1658`). There is no `GET /api/posts/<id>`
single-post endpoint — the overlay has no fallback fetch if the dataset
is empty/corrupt. **Any future overlay field (images, content, etc.) must
survive round-tripping through an HTML attribute** — if you add a new
post field, it either goes through `escapeHtml()` into a `data-*` attribute
(same pattern as existing fields), or you add a real per-post GET endpoint.
Don't assume the overlay can "just re-fetch" — it currently can't.

Image list per post lives in `post_images` (separate table, not a JSON
column) — chosen over a JSON column so multiple images per post don't need
a migration, order is preserved via `position`, and `ON DELETE CASCADE`
cleans up orphans when a post is deleted (rationale recorded in the repo's
own `IMPLEMENTATION_COMPLETE.md`).

## Non-obvious decisions worth preserving

- Multipart `POST /api/posts` handles both text-only (JSON body) and
  image posts (`multipart/form-data`) on the **same** endpoint — not split
  into two routes — to keep post creation atomic and client code simple
  (`app.py:237`, see also `handlePostSubmit`, `beebo.html:2069`).
- `escapeHtml()` (`beebo.html:1594`) is used everywhere a value is
  interpolated into an HTML **attribute**, not just text content. It must
  escape `"` and `'` in addition to `& < >` — text-node escaping alone is
  not attribute-safe. This was the source of a real bug (see log below).
  Any new code that writes `data-foo="${...}"` must run the value through
  `escapeHtml()`, and must not assume `div.textContent → innerHTML` is
  sufficient — it isn't, for attributes.
- Audience validation is intentionally lenient: unrecognized values fall
  back to `'Academic'` instead of erroring, so older/partial clients don't
  break (`VALID_AUDIENCES`, `app.py:30`).
- No server-side drafts — compose drafts are localStorage-only
  (`COMPOSE_DRAFT_KEY`, `beebo.html:1740`).
- Images are stored on disk (`static/uploads/`), not as DB blobs/base64 —
  keeps DB small, allows swapping to CDN/object storage later without an
  API shape change.

## Bug / fix log

**Problem:** Post images displayed correctly in the Home feed but were
missing from the Post & Comments overlay — consistently, not just after
refresh (refresh just made it the only path being tested).

**Root cause:** `escapeHtml()` (`beebo.html:1594`) only escaped `&`, `<`,
`>` (via `div.textContent`/`innerHTML`), not `"`. It was used to embed
`JSON.stringify(post.images)` into the double-quoted `data-post-images`
attribute (`buildPostCardHtml`, `beebo.html:1658`). Any non-empty image
array contains `"` characters (from JSON string quoting), which
prematurely closed the HTML attribute, corrupting the tag. Reading
`postCard.dataset.postImages` back then yielded a truncated, invalid JSON
string (e.g. `"["`), `JSON.parse` threw, was caught, and silently fell
back to `images = []` (`beebo.html:2217-2230`). Text-only posts were
unaffected because `JSON.stringify([])` → `"[]"` has no embedded quotes.

**Relevant location:** `escapeHtml()` (`beebo.html:1594`); consumed by
`buildPostCardHtml` (`beebo.html:1658`) and read by the comment-button
click handler (`beebo.html:2217-2244`) → `openCommentOverlay`
(`beebo.html:2381`).

**Fix:** `escapeHtml()` now also replaces `"` → `&quot;` and `'` →
`&#39;`. Fixes every `data-post-*` attribute (images, content,
author name, etc.), not just images — any future post field with quote
characters would have hit the same bug.

**Verification:** Published an image post → confirmed feed shows it →
refreshed → opened Post & Comments → image now present. Confirmed via
direct inspection of `post_images` table + `Flask test_client` hitting
`GET /api/posts` (backend was already correct — this was 100% a frontend
serialization bug, no backend change needed).

**Lesson for next session:** Don't assume a "persistence" bug is a
backend/DB problem just because it manifests after a refresh. Check the
backend response first (fast to verify via `test_client` or curl); if the
data is present there, the bug is almost certainly in how the frontend
serializes/reads that data client-side (dataset attributes, localStorage,
in-memory cache), not in storage or retrieval. In this codebase
specifically: the comment overlay has no network fetch for post metadata
at all — always check `beebo.html:2217-2244` and `escapeHtml` first before
looking at `app.py` for anything overlay-related.

## Common mistake to avoid

Don't add a new `GET /api/posts/<id>` endpoint to "fix" overlay data
issues before checking whether the real bug is in the existing
dataset-attribute pipeline (`buildPostCardHtml` → `data-post-*` →
`openCommentOverlay`). That pipeline is intentional (avoids an extra
round-trip) and most overlay bugs so far have been serialization bugs in
it, not missing data.

## Miscellaneous docs already in repo (not duplicated here)

`IMPLEMENTATION_COMPLETE.md`, `API_CHANGES.md`, `BACKEND_SUMMARY.md`,
`FRONTEND_INTEGRATION.md`, `REGRESSION_FIX.md`, `ANIMATION_CHANGES.md` —
scattered session-specific writeups from earlier backend/animation work.
Treat this file as the entry point; only open those if this file doesn't
answer the question and the topic (e.g. like-button animation internals)
matches one of their titles.

## Testing

**IMPORTANT:** `beebo.db` contains production data and must NEVER be the target
of a test run. Always use an isolated test database.

### Safe test workflow

```bash
# 1. Start the server against an isolated test database (not beebo.db)
DB_PATH=beebo_test.db python app.py &

# 2. In another terminal, run the test suite
./test_comments.sh
./test_comments2.sh
./test_follows.sh
./test_highlights.sh

# 3. Clean up the test db when done (safe to delete - it's not beebo.db)
rm -f beebo_test.db
```

### What NOT to do

Never run any `test_*.sh` script against a server started without `DB_PATH` set.
The default database is `beebo.db`, which contains real user data. Running tests
against it will reset the schema and wipe all accounts.

### Verification

To confirm tests ran against the test database only:
```bash
# Check row counts in beebo.db before and after test run
sqlite3 beebo.db "SELECT 'users:', COUNT(*) FROM users; SELECT 'posts:', COUNT(*) FROM posts;"

# They should be identical - tests should not touch beebo.db at all
```
