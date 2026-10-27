# Media & the Library

Everything an agent *produces* for you — a report, a PDF, a page, an image, a video — is a
**deliverable**, and every deliverable lands in one place: the **Library**. This page covers where
deliverables live and how agents create visual media.

## The Library — every deliverable, kept

When an agent finishes something worth keeping, it **publishes** it to the Library and links it from
its report in your Inbox. The Library is the durable gallery of those snapshots — nothing an agent
made for you gets lost in a terminal scrollback.

**Browsing.** The Library opens as a grid of cards — image thumbnails, the opening lines of each
report — grouped by day (Today, Yesterday, This week, then by month). Narrow it with the **search** box
(press `/`), the **type** chips (Docs · Images · Video · Pages · Other), the **agent** picker, or the
**folder** tree on the left; sort by date, name or size; switch to a compact **list** with the toggle
on the right. It loads as you scroll, and a card only fetches its small thumbnail when it comes into
view, so a Library of hundreds stays quick. Archived deliverables sit behind **Archived** under the
folders, each with a **Restore**.

**Viewing.** Click a card to open it full-screen. **← / →** step through the current (filtered) set,
**Esc** returns to the grid, and the details panel on the right holds sharing, move and delete. What
the viewer shows depends on the file:

- **HTML** — a dashboard, report, or one-off page an agent built renders as a **live page**, not raw
  source; **Open** views it standalone. (It runs sandboxed — interactive HTML/JS works, but the page
  can't touch your session or the console around it.)
- **PDF** — rendered inline.
- **Images / video** — full size, with the **cost** of generating them.
- **Text / markdown / data** — shown as formatted content (Markdown can also download as a PDF).

Deliverables are read-only snapshots; re-running an agent publishes a new one rather than overwriting.

## Generating images and video

Claude can't draw or film on its own, so agents get two governed tools when your workspace has media
generation switched on (**Connections → Creds → Media generation**, one Atlas Cloud key powers both):

- **`image_generate`** — text → image. Returns in seconds.
- **`video_generate`** — text → video, or **image → video**: hand it an image (a Library image from a
  prior `image_generate`, a file the agent is working with, or a URL) and it animates *that*. Video
  renders **asynchronously** — usually minutes — and posts an **Inbox card** when the clip is ready.

Agents can also **edit** an existing image (the original is never changed — the edit saves as a new
Library image). Everything they make lands in the Library like any other deliverable.

## It's governed like everything else

Media generation costs real money, so it runs through the same gateway as every other agent action:

- **Cost-metered** — each generation is estimated and **counts against the budget**; a run can't quietly
  burn through spend making images.
- **Audited** — every generation is in the **Audit** log with its cost.
- **Per-artifact cost** — the Library shows what each image or clip cost to make.

An admin picks the default image/video models (with live per-model pricing) in **Connections → Creds →
Media generation**; agents can name a specific model when it matters, or let the sensible default stand.

## Asking for media in a prompt

Just ask, the way you'd ask a designer:

- *"Draw a hero image for the launch post — dark, minimal, a single glowing node."*
- *"Turn that image into a 4-second loop."*
- *"Build an HTML dashboard of this week's numbers and publish it to the Library."*

The deliverable shows up in the Library and in the run's report.
