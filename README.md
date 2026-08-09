# TagMyPhoto Express

A 100% local, client-side photo tagging tool. Open a folder of JPEGs, tag who's
in each photo, and the tags are written straight into each file's IPTC
Keywords and XMP dc:subject fields — the same fields Lightroom, GNOME Files,
Photos, Finder, and Windows Explorer already read as "tags"/"keywords". There
is no server, no database, and no upload: everything happens in your browser,
and nothing ever leaves your device.

Based on the tagging screen from [tagmyphoto](https://github.com/chrissabato/tagmyphoto),
adapted to run without a backend.

## Usage

1. Open `index.html` (locally, or via GitHub Pages) in **Chrome or Edge**.
   This app relies on the File System Access API, which Firefox and Safari
   don't yet support.
2. Click **Open Folder…** and choose a folder of photos. You'll be asked to
   grant read-write access — this is required so tags can be saved back into
   the files.
3. Select a photo, type a name into the tag box (or click a roster
   button), and press Enter/Add. The tag is saved to that photo's file
   immediately.
4. Use **Manage** in the roster panel to maintain a list of names (with
   optional numbers) for one-click tagging. Click **Import from CSV…** to
   paste in a batch of names at once — one person per line, as `Number,Name`
   or just `Name` if there's no number. A header row (`Number,Name`) is
   detected and skipped, and duplicate names (case-insensitive) are skipped
   automatically.
   **Import from Team Website…** pulls a roster directly from a Presto
   Sports roster page (e.g. `/sports/wvball/2025-26/roster`) — paste in the
   page's URL or path and it fetches and parses the number/name table. This
   only works when the app is running embedded on that same site (see
   "Embedding on a team site" below); a browser can't fetch another site's
   pages directly (CORS), which is the whole reason the embed exists.
   You can keep multiple rosters (e.g. one team per season) — switch between
   them with the dropdown at the top of the panel or the Manage Roster modal,
   and use **+ New**, **Rename**, and **Delete** to manage them. Rosters are
   saved in the browser (IndexedDB), so they're still there next time you
   open the app, even in a different folder.
5. Use the left/right arrow keys to move between photos, or check multiple
   thumbnails to tag several photos at once.
6. Next time you visit, use the **Reopen recent…** dropdown to jump back
   into one of your last 8 folders — tags aren't cached anywhere in the app,
   they're read straight back out of the files.
7. **Remove All Keywords…**, below the roster panel, strips every tag from
   every photo in the open folder — useful for starting over. It asks for
   confirmation first (showing how many photos are affected) and shows a
   progress bar while it runs, since it can take a while on a folder with
   hundreds of photos.

## Notes

- Only the top level of the chosen folder is scanned — subfolders aren't
  included.
- Only JPEG files get tags written into them in this version. Other image
  formats can still be viewed and tagged during a session, but the tags
  won't be saved into the file (a notice appears when this is the case).
- Because tags live in the files themselves, backing up your tags is just
  backing up your photos folder — there's no separate export/import to keep
  in sync.
- Tags already on a photo from another program (e.g. keywords added in
  Lightroom) show up here automatically — this app reads both the IPTC
  Keywords and XMP dc:subject fields and merges them.
- Adding and removing tags are both fully reliable and saved straight into
  the file. This app uses a custom-built version of the `exiv2-wasm` library
  (vendored here as `vendor/exiv2.esm.js` / `vendor/exiv2.esm.wasm`) rather
  than the stock npm package, because the stock version can't cleanly clear
  or replace a keyword field once it already has a value — a real problem
  for any photo that's already been through Lightroom or tagged before,
  which is the normal case.

## Deploying to GitHub Pages

This is a static site — no build step. Push `index.html`, `style.css`,
`app.js`, `logo.svg`, `og-image.jpg`, and the `vendor/` folder to a
repository and enable GitHub Pages (Settings → Pages → Deploy from branch),
pointing at the branch/folder containing these files.

## Embedding on a team site

The website roster importer needs to run **same-origin** with the team's
roster pages, or the browser blocks the fetch (CORS). Since this app has no
backend to proxy around that, the fix is to run the app itself on the team's
own site: add a page (e.g. `wubearcats.com/tagmyphoto`) with just this tag:

```html
<script src="https://express.tagmy.photo/embed.js"></script>
```

That injects a small "📷 TagMyPhoto" launch button. Clicking it mounts the
full app inside a shadow root as a full-page overlay — shadow DOM keeps the
app's CSS from colliding with the host site's (and vice versa) while
staying in the same document/origin, so `fetch()` to any other page on that
site works normally and the File System Access API is unaffected (unlike a
cross-origin iframe, which would reintroduce the CORS problem and has
unreliable File System Access API support). A **✕** button closes the
overlay; reopening is instant since it just re-shows the same mounted app
rather than reloading it.

Because the embedded app runs under the team site's origin, its browser
storage (rosters, settings, dark mode) is separate from the storage used
when visiting `express.tagmy.photo` directly — they don't share data.

This currently only understands **Presto Sports** roster pages (one
`<table>`, jersey number in a `.jersey-number` cell, name in the row's
`<th>`). Sidearm support is planned as a second parser, not a redesign.
