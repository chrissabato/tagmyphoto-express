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
`app.js`, `logo.svg`, and the `vendor/` folder to a repository and enable
GitHub Pages (Settings → Pages → Deploy from branch), pointing at the
branch/folder containing these files.
