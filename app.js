// TagMyPhoto Express — 100% local, browser-only.
// Tags are read from / written to each JPEG's IPTC Keywords field and XMP
// dc:subject field via exiv2-wasm, and saved back to disk with the File
// System Access API. No photo or tag data is ever sent anywhere.
//
// Two fields, because real-world tools disagree on which one is "the"
// keywords field: Lightroom, GNOME Files, and most modern XMP-aware tools
// read/write Xmp.dc.subject, while older/simpler tools only look at the
// legacy Iptc.Application2.Keywords. Reads merge both so tags from either
// source are visible. See the comment on writeTagsToFile for how writes
// are handled — the stock exiv2-wasm writeString() can't reliably
// clear/replace either field once it already has a value (confirmed
// against real camera/Lightroom-exported JPEGs, not just synthetic test
// files), so this app uses a self-hosted build with an added removeKey()
// that actually erases a field's entries, letting writes fully rewrite
// both fields instead of only ever adding to them.

// Self-hosted custom build — adds a removeKey() export the upstream
// package doesn't have. Also sidesteps upstream 0.5.13's loader bug, which
// built a doubled "dist/dist/exiv2.js" URL and broke every read/write.
import createExiv2Module from './vendor/exiv2.esm.js';

const IPTC_KEYWORDS_KEY = 'Iptc.Application2.Keywords';
const XMP_SUBJECT_KEY = 'Xmp.dc.subject';
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;
const JPEG_EXT_RE = /\.jpe?g$/i;

let exiv2Promise = null;
function getExiv2() {
  if (!exiv2Promise) exiv2Promise = createExiv2Module();
  return exiv2Promise;
}

function isJpegFile(file) {
  return file.type === 'image/jpeg' || JPEG_EXT_RE.test(file.name);
}

function splitKeywords(text) {
  return text.split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

// A raw metadata value comes back as an array, a joined string, or null/
// undefined depending on the field and how many values it holds.
function parseMultiValue(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return splitKeywords(String(raw));
}

async function readTagsFromFile(file) {
  if (!isJpegFile(file)) return [];
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const exiv2 = await getExiv2();
    const result = exiv2.read(buf);
    const iptcTags = parseMultiValue(result?.iptc?.[IPTC_KEYWORDS_KEY]);
    const xmpTags = parseMultiValue(result?.xmp?.[XMP_SUBJECT_KEY]);
    const seen = new Set();
    const merged = [];
    for (const tag of [...iptcTags, ...xmpTags]) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(tag);
    }
    return merged;
  } catch (err) {
    console.warn('Failed to read tags from', file.name, err);
    return [];
  }
}

// Writes the exact given set of tags into a file's IPTC Keywords and XMP
// dc:subject fields, replacing whatever was there before. Both fields are
// fully cleared first via removeKey() — writeString() alone can't reliably
// clear/replace either field once it already has a value — then rebuilt
// from that clean state: IPTC Keywords as a single ';'-joined string (that
// field only reliably holds one value at a time through this API, and
// readTagsFromFile/parseMultiValue already expect a delimited string
// there), XMP dc:subject as one bag entry per tag (writeString() reliably
// appends to that field once it's non-empty, which starting from a
// removeKey()'d empty field it always is).
//
// Also re-syncs Xmp.iptcExt.PersonInImage from photo.personTags (the subset
// of tags picked from the roster, rather than typed free-hand — see addTag)
// in the same read-modify-write pass, unless a template has locked it with
// a custom value (photo.personInImageLocked). Doing this here rather than
// as a separate write avoids a lost-update race: two independent
// read-modify-write passes against the same file, run concurrently for the
// same photo, would each read before the other's write lands and clobber
// it.
async function writeTagsToFile(photo, tags) {
  if (!photo.isJpeg || !photo.fileHandle) return;
  const exiv2 = await getExiv2();
  const unique = [...new Set(tags)];
  let buf = new Uint8Array(await (await photo.fileHandle.getFile()).arrayBuffer());

  try {
    buf = exiv2.removeKey(buf, IPTC_KEYWORDS_KEY) ?? buf;
    buf = exiv2.removeKey(buf, XMP_SUBJECT_KEY) ?? buf;
    if (unique.length > 0) {
      buf = exiv2.writeString(buf, IPTC_KEYWORDS_KEY, unique.join('; '));
      for (const tag of unique) {
        buf = exiv2.writeString(buf, XMP_SUBJECT_KEY, tag);
      }
    }
    if (!photo.personInImageLocked) {
      const personConfig = TEMPLATE_FIELD_MAP.find(f => f.key === 'PersonInImage');
      buf = writeTemplateField(exiv2, buf, personConfig, photo.personTags.join(', '));
    }
  } catch (err) {
    console.error('Failed to write tags to', photo.name, err);
    throw err;
  }

  const writable = await photo.fileHandle.createWritable();
  await writable.write(buf);
  await writable.close();
}

// Removes a single tag by rewriting both metadata fields from the
// remaining tag list (see writeTagsToFile). Re-reads the file afterward as
// a sanity check — with removeKey() in place this is expected to always
// succeed, so a mismatch here means a genuine bug, not a known limitation.
async function removeTagFromFile(photo, remainingTags, removedTag) {
  if (!photo.isJpeg || !photo.fileHandle) return true;
  await writeTagsToFile(photo, remainingTags);
  const verifyTags = await readTagsFromFile(await photo.fileHandle.getFile());
  return !verifyTags.some(t => t.toLowerCase() === removedTag.toLowerCase());
}

// --- Metadata Templates: field mapping, interpolation, writing ---
// legacy = classic IPTC IIM key (Iptc.Application2.*), xmp = XMP equivalent.
// mode: 'plain' (single writeString, replaces cleanly on its own — confirmed
// against this app's custom exiv2-wasm build), 'list' (comma-split, one
// writeString per value on the XMP side — same pattern as today's
// Keywords/dc:subject — needs removeKey first or values accumulate across
// re-applies), 'langAlt' (plain write; Exiv2 treats an unqualified string as
// x-default and reads it back prefixed with `lang="x-default" `, confirmed
// via spike test). Struct sub-properties (CreatorContactInfo/*) behave
// identically to 'plain' — also confirmed via spike test — so they don't
// need their own mode.
const TEMPLATE_FIELD_MAP = [
  { group: 'Content', key: 'Description', legacyKey: 'Iptc.Application2.Caption', xmpKey: 'Xmp.dc.description', mode: 'langAlt' },
  { group: 'Content', key: 'Headline', legacyKey: 'Iptc.Application2.Headline', xmpKey: 'Xmp.photoshop.Headline', mode: 'plain' },
  { group: 'Content', key: 'Keywords', legacyKey: 'Iptc.Application2.Keywords', xmpKey: 'Xmp.dc.subject', mode: 'list' },
  { group: 'Content', key: 'PersonInImage', legacyKey: null, xmpKey: 'Xmp.iptcExt.PersonInImage', mode: 'list' },
  { group: 'Content', key: 'Scene', legacyKey: null, xmpKey: 'Xmp.iptcExt.Scene', mode: 'list' },
  { group: 'Content', key: 'Event', legacyKey: null, xmpKey: 'Xmp.iptcExt.Event', mode: 'langAlt' },
  { group: 'Content', key: 'OrganisationInImageName', legacyKey: null, xmpKey: 'Xmp.iptcExt.OrganisationInImageName', mode: 'list' },
  { group: 'Content', key: 'OrganisationInImageCode', legacyKey: null, xmpKey: 'Xmp.iptcExt.OrganisationInImageCode', mode: 'list' },
  { group: 'Content', key: 'SpecialInstructions', legacyKey: 'Iptc.Application2.SpecialInstructions', xmpKey: 'Xmp.photoshop.Instructions', mode: 'plain' },
  { group: 'Creator', key: 'Creator', legacyKey: 'Iptc.Application2.Byline', xmpKey: 'Xmp.dc.creator', mode: 'list' },
  { group: 'Creator', key: 'CreatorJobTitle', legacyKey: 'Iptc.Application2.BylineTitle', xmpKey: 'Xmp.photoshop.AuthorsPosition', mode: 'plain' },
  { group: 'Creator', key: 'CreatorAddress', legacyKey: null, xmpKey: 'Xmp.iptc.CreatorContactInfo/Iptc4xmpCore:CiAdrExtadr', mode: 'plain' },
  { group: 'Creator', key: 'CreatorCity', legacyKey: null, xmpKey: 'Xmp.iptc.CreatorContactInfo/Iptc4xmpCore:CiAdrCity', mode: 'plain' },
  { group: 'Creator', key: 'CreatorPostalCode', legacyKey: null, xmpKey: 'Xmp.iptc.CreatorContactInfo/Iptc4xmpCore:CiAdrPcode', mode: 'plain' },
  { group: 'Creator', key: 'CreatorCountry', legacyKey: null, xmpKey: 'Xmp.iptc.CreatorContactInfo/Iptc4xmpCore:CiAdrCtry', mode: 'plain' },
  { group: 'Creator', key: 'CreatorWorkEmail', legacyKey: null, xmpKey: 'Xmp.iptc.CreatorContactInfo/Iptc4xmpCore:CiEmailWork', mode: 'plain' },
  { group: 'Creator', key: 'CreatorWorkURL', legacyKey: null, xmpKey: 'Xmp.iptc.CreatorContactInfo/Iptc4xmpCore:CiUrlWork', mode: 'plain' },
  { group: 'Rights', key: 'CopyrightNotice', legacyKey: 'Iptc.Application2.Copyright', xmpKey: 'Xmp.dc.rights', mode: 'langAlt' },
  { group: 'Rights', key: 'Credit', legacyKey: 'Iptc.Application2.Credit', xmpKey: 'Xmp.photoshop.Credit', mode: 'plain' },
  { group: 'Rights', key: 'Source', legacyKey: 'Iptc.Application2.Source', xmpKey: 'Xmp.photoshop.Source', mode: 'plain' },
  { group: 'Rights', key: 'WebStatement', legacyKey: null, xmpKey: 'Xmp.xmpRights.WebStatement', mode: 'plain' },
  { group: 'Rights', key: 'UsageTerms', legacyKey: null, xmpKey: 'Xmp.xmpRights.UsageTerms', mode: 'langAlt' },
  { group: 'Location', key: 'City', legacyKey: 'Iptc.Application2.City', xmpKey: 'Xmp.photoshop.City', mode: 'plain' },
  { group: 'Location', key: 'Sub-location', legacyKey: 'Iptc.Application2.SubLocation', xmpKey: 'Xmp.photoshop.Location', mode: 'plain' },
  { group: 'Location', key: 'Province-State', legacyKey: 'Iptc.Application2.ProvinceState', xmpKey: 'Xmp.photoshop.State', mode: 'plain' },
  { group: 'Location', key: 'Country-PrimaryLocationName', legacyKey: 'Iptc.Application2.CountryName', xmpKey: 'Xmp.photoshop.Country', mode: 'plain' },
  { group: 'Location', key: 'Country-PrimaryLocationCode', legacyKey: 'Iptc.Application2.CountryCode', xmpKey: 'Xmp.iptc.CountryCode', mode: 'plain' },
];

const TEMPLATE_FIELD_GROUPS = ['Content', 'Creator', 'Rights', 'Location'];

const BUILTIN_VARS = [
  { key: 'photographer', label: 'Photographer name' },
  { key: 'org_name', label: 'Organisation name' },
  { key: 'iptcday', label: 'Day (01–31)' }, { key: 'iptcday_nopad', label: 'Day (1–31)' },
  { key: 'iptcmonth', label: 'Month (01–12)' }, { key: 'iptcmonthname', label: 'Month name' }, { key: 'iptcmonthname_short', label: 'Month short' },
  { key: 'iptcyear4', label: 'Year (2025)' }, { key: 'iptcyear2', label: 'Year short (25)' },
];
// 'persons' is a 10th builtin, computed per-photo, never a form field.
const BUILTIN_VAR_KEYS = new Set([...BUILTIN_VARS.map(v => v.key), 'persons']);

// A var token is a plain word (\w+, the original builtin/custom style), an
// explicit {CUSTOM:label} — the label can contain spaces, slashes, etc.
// since it's only ever used as a fill-in prompt/lookup key, never as a bare
// identifier — or a {SEQ:001}-style auto-incrementing sequence number.
const VAR_TOKEN_RE = /\{(\w+|CUSTOM:[^}]+|SEQ:\d+)\}/gi;
const SEQ_TOKEN_RE = /^SEQ:(\d+)$/i;
const PATTERN_HAS_SEQ_RE = /\{SEQ:\d+\}/i;

// A rename pattern needs its own {SEQ:...} to guarantee unique filenames —
// unlike EXIF/roster-derived vars, nothing else in a pattern is guaranteed
// to differ photo-to-photo.
function patternHasSeq(pattern) {
  return PATTERN_HAS_SEQ_RE.test(pattern || '');
}

function varTokenKey(token) {
  const custom = /^CUSTOM:(.+)$/i.exec(token);
  return custom ? custom[1].trim() : token;
}

// {SEQ:001} → 3-digit sequence starting at 1 (001, 002…); {SEQ:0100} →
// 4-digit sequence starting at 100 (0100, 0101…). The digit count in the
// spec sets the zero-padded width, its numeric value sets the start.
function seqValueForIndex(spec, index) {
  const start = parseInt(spec, 10);
  return String(start + index - 1).padStart(spec.length, '0');
}

// CUSTOM: labels can contain spaces/slashes/etc., which aren't valid in an
// HTML id — used only for generating a safe id/for pair, never for the
// vars/fillIns lookup key (which stays the raw label text).
function slugForId(str) {
  return str.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function interpolateTemplate(template, vars) {
  return template.replace(VAR_TOKEN_RE, (full, token) => {
    const key = varTokenKey(token);
    return vars[key] ?? full;
  });
}

function extractVarKeys(text) {
  const found = [...text.matchAll(VAR_TOKEN_RE)].map(m => varTokenKey(m[1]));
  return found.filter((v, i, a) => a.indexOf(v) === i);
}

function detectFillIns(fields) {
  return extractVarKeys(Object.values(fields).join(' ')).filter(v => !BUILTIN_VAR_KEYS.has(v) && !SEQ_TOKEN_RE.test(v));
}

// --- File renaming: field mapping, builtin vars ---
// Same {var} interpolation as metadata templates, plus vars that only make
// sense for a filename (original name, sequence number, all tags). No
// {ext} var — the original extension is always preserved automatically
// (see buildNewFilename), so a pattern only ever describes the base name.
const RENAME_BUILTIN_VARS = [
  ...BUILTIN_VARS.filter(v => v.key !== 'photographer' && v.key !== 'org_name'),
  { key: 'persons', label: "This photo's tagged names" },
  { key: 'keywords', label: 'All tags/keywords' },
  { key: 'filename', label: 'Original filename (no extension)' },
  { key: 'SEQ:001', label: 'Sequence number — edit the digits to set start & padding, e.g. {SEQ:001} = 001, 002…, {SEQ:0100} starts at 100 with 4 digits' },
];
const RENAME_BUILTIN_VAR_KEYS = new Set(RENAME_BUILTIN_VARS.map(v => v.key));

function detectRenameFillIns(pattern) {
  return extractVarKeys(pattern).filter(v => !RENAME_BUILTIN_VAR_KEYS.has(v) && !SEQ_TOKEN_RE.test(v));
}

// Strips characters that are invalid (or, for trailing dot/space, silently
// dropped by Windows) in a filename. Applied to the whole interpolated base
// name rather than per-variable, since free-text vars like {persons} or a
// custom field can contain anything.
function sanitizeFilenamePart(str) {
  const cleaned = str
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned || 'untitled';
}

// The pattern only ever produces a base name — the original extension is
// always kept as-is and appended here, so patterns can't accidentally
// double up or drop it.
function buildNewFilename(baseName, originalName) {
  const dot = originalName.lastIndexOf('.');
  const ext = dot > 0 ? originalName.slice(dot) : '';
  return sanitizeFilenamePart(baseName) + ext;
}

// Parses 'YYYY-MM-DD' as local y/m/d — new Date(dateStr) parses as UTC and
// can shift the displayed day near timezone boundaries.
function computeDateVars(dateStr) {
  if (!dateStr) return { iptcday: '', iptcday_nopad: '', iptcmonth: '', iptcmonthname: '', iptcmonthname_short: '', iptcyear4: '', iptcyear2: '' };
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return {
    iptcday: String(date.getDate()).padStart(2, '0'),
    iptcday_nopad: String(date.getDate()),
    iptcmonth: String(date.getMonth() + 1).padStart(2, '0'),
    iptcmonthname: MONTHS[date.getMonth()],
    iptcmonthname_short: MONTHS[date.getMonth()].slice(0, 3),
    iptcyear4: String(date.getFullYear()),
    iptcyear2: String(date.getFullYear()).slice(-2),
  };
}

// EXIF date/time values are 'YYYY:MM:DD HH:MM:SS'; DateTimeOriginal (when
// the shutter fired) is preferred over DateTimeDigitized/DateTime (file
// write time, e.g. from scanning or editing) since it's what "event date"
// actually means for a photo.
function computeDateVarsFromExif(exif) {
  const raw = exif?.['Exif.Photo.DateTimeOriginal']
    || exif?.['Exif.Photo.DateTimeDigitized']
    || exif?.['Exif.Image.DateTime'];
  const match = raw && /^(\d{4}):(\d{2}):(\d{2})/.exec(raw);
  if (!match) return computeDateVars('');
  const [, y, m, d] = match;
  return computeDateVars(`${y}-${m}-${d}`);
}

// Writes one interpolated field value using its Exiv2 key mapping. Modes
// confirmed by spike-testing against this app's custom exiv2-wasm build:
// single-value fields (plain/langAlt/struct sub-properties alike) cleanly
// replace on writeString alone, but a removeKey first keeps behavior
// consistent and handles the "template value cleared to empty on a
// re-apply" case. List fields accumulate across writes and require
// removeKey first, same as the existing Keywords/dc:subject writer.
function writeTemplateField(exiv2, buf, config, value) {
  if (config.mode === 'list') {
    const values = splitKeywords(value);
    if (config.legacyKey) buf = exiv2.removeKey(buf, config.legacyKey) ?? buf;
    if (config.xmpKey) buf = exiv2.removeKey(buf, config.xmpKey) ?? buf;
    if (values.length) {
      if (config.legacyKey) buf = exiv2.writeString(buf, config.legacyKey, values.join('; '));
      if (config.xmpKey) for (const v of values) buf = exiv2.writeString(buf, config.xmpKey, v);
    }
  } else { // plain / langAlt
    if (config.legacyKey) buf = exiv2.removeKey(buf, config.legacyKey) ?? buf;
    if (config.xmpKey) buf = exiv2.removeKey(buf, config.xmpKey) ?? buf;
    if (value) {
      if (config.legacyKey) buf = exiv2.writeString(buf, config.legacyKey, value);
      if (config.xmpKey) buf = exiv2.writeString(buf, config.xmpKey, value);
    }
  }
  return buf;
}

// --- Small IndexedDB helper for non-photo state (folder handle, roster) ---
const DB_NAME = 'photo-tagger';
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- App state ---
const state = {
  dirHandle: null,
  photos: [],          // { id, name, fileHandle, url, isJpeg, tags: string[] }
  selectedPhotoId: null,
  checkedIds: new Set(),
  filterUntagged: false,
  rosters: [],           // { id, name, members: [{ id, name, number }] }
  activeRosterId: null,
  metadataTemplates: [],  // { id, name, fields: Record<string,string> }
  activeTemplateId: null,
  renameTemplates: [],    // { id, name, pattern: string }
  activeRenameTemplateId: null,
  settings: { photographer: '', orgName: '', darkMode: false },
};

function persistSettings() {
  return kvSet('settings', state.settings);
}

// Mirrors darkMode to localStorage (synchronous) alongside the IndexedDB
// settings record (async) — a tiny inline script in index.html reads this
// before first paint so the page doesn't flash light before switching to
// the user's saved theme.
function applyTheme() {
  if (state.settings.darkMode) THEME_ROOT.setAttribute('data-theme', 'dark');
  else THEME_ROOT.removeAttribute('data-theme');
  try { localStorage.setItem('darkMode', state.settings.darkMode ? '1' : '0'); } catch (e) {}
}

function suggestedNames() {
  const names = new Set();
  for (const p of state.photos) for (const t of p.tags) names.add(t);
  return [...names];
}

function selectedPhoto() {
  return state.photos.find(p => p.id === state.selectedPhotoId) || null;
}

function activeRoster() {
  return state.rosters.find(r => r.id === state.activeRosterId) || state.rosters[0] || null;
}

function activeRosterMembers() {
  return activeRoster()?.members || [];
}

function rosterNameSet() {
  return new Set(activeRosterMembers().map(m => m.name.toLowerCase()));
}

function activeTemplate() {
  return state.metadataTemplates.find(t => t.id === state.activeTemplateId) || state.metadataTemplates[0] || null;
}

function activeRenameTemplate() {
  return state.renameTemplates.find(t => t.id === state.activeRenameTemplateId) || state.renameTemplates[0] || null;
}

// Checked photos if any are checked, otherwise every photo in the folder —
// same "checked-first" convention addTag uses for its targets.
function renameTargets() {
  return state.checkedIds.size > 0
    ? state.photos.filter(p => state.checkedIds.has(p.id))
    : state.photos;
}

// --- DOM refs ---
// When embedded via embed.js on another site, the app's markup lives inside a
// shadow root rather than the main document, so element lookups and the
// dark-mode attribute both need to target that shadow tree instead of
// `document`. Standalone (index.html loaded directly) these just fall back
// to the normal document.
const ROOT = window.__TMPX_ROOT__ || document;
const THEME_ROOT = window.__TMPX_THEME_ROOT__ || document.documentElement;
const $ = sel => ROOT.querySelector(sel);
const el = {
  app: $('#app'),
  unsupported: $('#unsupported'),
  emptyState: $('#empty-state'),
  workspace: $('#workspace'),
  taggedCount: $('#tagged-count'),
  btnPickFolder: $('#btn-pick-folder'),
  recentFoldersSelect: $('#recent-folders-select'),
  btnOpenHelp: $('#btn-open-help'),
  helpModal: $('#help-modal'),
  btnHelpClose: $('#btn-help-close'),
  btnOpenSettings: $('#btn-open-settings'),
  settingsModal: $('#settings-modal'),
  settingsPhotographer: $('#settings-photographer'),
  settingsOrg: $('#settings-org'),
  settingsDarkMode: $('#settings-dark-mode'),
  btnSettingsClose: $('#btn-settings-close'),
  btnFilterUntagged: $('#btn-filter-untagged'),
  checkedBar: $('#checked-bar'),
  checkedCount: $('#checked-count'),
  btnClearChecked: $('#btn-clear-checked'),
  thumbList: $('#thumb-list'),
  btnPrev: $('#btn-prev'),
  btnNext: $('#btn-next'),
  tagInput: $('#tag-input'),
  btnAddTag: $('#btn-add-tag'),
  tagSuggestions: $('#tag-suggestions'),
  formatNotice: $('#format-notice'),
  tagBadges: $('#tag-badges'),
  mainPhoto: $('#main-photo'),
  rosterButtons: $('#roster-buttons'),
  extraNamesSection: $('#extra-names-section'),
  extraNameButtons: $('#extra-name-buttons'),
  btnClearAllKeywords: $('#btn-clear-all-keywords'),
  clearAllModal: $('#clear-all-modal'),
  clearAllProgressText: $('#clear-all-progress-text'),
  clearAllProgressFill: $('#clear-all-progress-fill'),
  btnManageRoster: $('#btn-manage-roster'),
  rosterModal: $('#roster-modal'),
  rosterSelect: $('#roster-select'),
  rosterSelectModal: $('#roster-select-modal'),
  btnRosterNew: $('#btn-roster-new'),
  btnRosterRename: $('#btn-roster-rename'),
  btnRosterDelete: $('#btn-roster-delete'),
  btnRosterClear: $('#btn-roster-clear'),
  btnRosterExport: $('#btn-roster-export'),
  btnRosterImport: $('#btn-roster-import'),
  rosterImportFile: $('#roster-import-file'),
  rosterIoStatus: $('#roster-io-status'),
  rosterNameEditSection: $('#roster-name-edit-section'),
  rosterNameEditInput: $('#roster-name-edit-input'),
  btnRosterNameEditSave: $('#btn-roster-name-edit-save'),
  btnRosterNameEditCancel: $('#btn-roster-name-edit-cancel'),
  rosterNameInput: $('#roster-name-input'),
  rosterNumberInput: $('#roster-number-input'),
  btnRosterAdd: $('#btn-roster-add'),
  rosterList: $('#roster-list'),
  btnRosterClose: $('#btn-roster-close'),
  btnToggleAddIndividual: $('#btn-toggle-add-individual'),
  addIndividualSection: $('#add-individual-section'),
  btnToggleCsvImport: $('#btn-toggle-csv-import'),
  csvImportSection: $('#csv-import-section'),
  csvImportText: $('#csv-import-text'),
  btnCsvImport: $('#btn-csv-import'),
  csvImportStatus: $('#csv-import-status'),
  btnToggleWebsiteImport: $('#btn-toggle-website-import'),
  websiteImportSection: $('#website-import-section'),
  websiteImportUrl: $('#website-import-url'),
  btnWebsiteImport: $('#btn-website-import'),
  websiteImportStatus: $('#website-import-status'),
  btnToggleJsonImport: $('#btn-toggle-json-import'),
  jsonImportSection: $('#json-import-section'),
  lightbox: $('#lightbox'),
  lightboxImg: $('#lightbox-img'),
  btnLightboxClose: $('#btn-lightbox-close'),

  // Metadata Templates
  btnManageTemplates: $('#btn-manage-templates'),
  btnApplyTemplate: $('#btn-apply-template'),
  templateModal: $('#template-modal'),
  templateSelectModal: $('#template-select-modal'),
  btnTemplateNew: $('#btn-template-new'),
  btnTemplateRename: $('#btn-template-rename'),
  btnTemplateDuplicate: $('#btn-template-duplicate'),
  btnTemplateDelete: $('#btn-template-delete'),
  btnTemplateExport: $('#btn-template-export'),
  btnTemplateImport: $('#btn-template-import'),
  templateImportFile: $('#template-import-file'),
  templateIoStatus: $('#template-io-status'),
  templateNameEditSection: $('#template-name-edit-section'),
  templateNameEditInput: $('#template-name-edit-input'),
  btnTemplateNameEditSave: $('#btn-template-name-edit-save'),
  btnTemplateNameEditCancel: $('#btn-template-name-edit-cancel'),
  templateVarsRow: $('#template-vars-row'),
  templateFields: $('#template-fields'),
  templateCustomVarsSection: $('#template-custom-vars-section'),
  templateCustomVars: $('#template-custom-vars'),
  templatePreview: $('#template-preview'),
  btnTemplateClose: $('#btn-template-close'),

  templateApplyModal: $('#template-apply-modal'),
  templateApplySelect: $('#template-apply-select'),
  templateApplyPhotographer: $('#template-apply-photographer'),
  templateApplyOrg: $('#template-apply-org'),
  templateApplyCustomVarsSection: $('#template-apply-custom-vars-section'),
  templateApplyCustomVars: $('#template-apply-custom-vars'),
  btnTemplateApplyConfirm: $('#btn-template-apply-confirm'),
  btnTemplateApplyCancel: $('#btn-template-apply-cancel'),

  applyTemplateModal: $('#apply-template-modal'),
  applyTemplateProgressText: $('#apply-template-progress-text'),
  applyTemplateProgressFill: $('#apply-template-progress-fill'),

  // File Renaming
  btnManageRename: $('#btn-manage-rename'),
  btnApplyRename: $('#btn-apply-rename'),
  renameModal: $('#rename-modal'),
  renameSelectModal: $('#rename-select-modal'),
  btnRenameNew: $('#btn-rename-new'),
  btnRenameRename: $('#btn-rename-rename'),
  btnRenameDuplicate: $('#btn-rename-duplicate'),
  btnRenameDelete: $('#btn-rename-delete'),
  renameNameEditSection: $('#rename-name-edit-section'),
  renameNameEditInput: $('#rename-name-edit-input'),
  btnRenameNameEditSave: $('#btn-rename-name-edit-save'),
  btnRenameNameEditCancel: $('#btn-rename-name-edit-cancel'),
  renameVarsRow: $('#rename-vars-row'),
  renamePatternInput: $('#rename-pattern-input'),
  renameCustomVarsSection: $('#rename-custom-vars-section'),
  renameCustomVars: $('#rename-custom-vars'),
  renameSeqWarning: $('#rename-seq-warning'),
  renamePreview: $('#rename-preview'),
  btnRenameClose: $('#btn-rename-close'),

  renameApplyModal: $('#rename-apply-modal'),
  renameApplySelect: $('#rename-apply-select'),
  renameApplyCustomVarsSection: $('#rename-apply-custom-vars-section'),
  renameApplyCustomVars: $('#rename-apply-custom-vars'),
  renameApplyScope: $('#rename-apply-scope'),
  btnRenameApplyConfirm: $('#btn-rename-apply-confirm'),
  btnRenameApplyCancel: $('#btn-rename-apply-cancel'),

  renameProgressModal: $('#rename-progress-modal'),
  renameProgressText: $('#rename-progress-text'),
  renameProgressFill: $('#rename-progress-fill'),
};

// --- Rendering ---
function render() {
  renderTopbar();
  renderThumbs();
  renderMainPanel();
  renderRosterPanel();
}

function renderTopbar() {
  const total = state.photos.length;
  const tagged = state.photos.filter(p => p.tags.length > 0).length;
  el.taggedCount.textContent = total ? `${tagged} / ${total} tagged` : '';
}

function renderThumbs() {
  el.checkedBar.classList.toggle('hidden', state.checkedIds.size === 0);
  el.checkedCount.textContent = `${state.checkedIds.size} selected`;
  el.btnFilterUntagged.classList.toggle('active', state.filterUntagged);
  el.btnFilterUntagged.textContent = state.filterUntagged ? 'Show all' : 'Show untagged';

  const photos = state.photos.filter(p => !state.filterUntagged || p.tags.length === 0);
  el.thumbList.innerHTML = '';
  for (const photo of photos) {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.dataset.id = photo.id;
    if (photo.id === state.selectedPhotoId) div.classList.add('selected');
    if (state.checkedIds.has(photo.id)) div.classList.add('checked');

    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = photo.name;
    div.appendChild(img);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'thumb-checkbox';
    checkbox.checked = state.checkedIds.has(photo.id);
    checkbox.addEventListener('click', e => {
      e.stopPropagation();
      if (state.checkedIds.has(photo.id)) state.checkedIds.delete(photo.id);
      else state.checkedIds.add(photo.id);
      renderThumbs();
      el.tagInput.focus();
    });
    div.appendChild(checkbox);

    if (photo.tags.length > 0) {
      const badge = document.createElement('div');
      badge.className = 'thumb-tag-count';
      badge.textContent = photo.tags.length;
      div.appendChild(badge);
    }

    div.addEventListener('click', () => {
      selectPhoto(photo.id);
      state.checkedIds.clear();
      render();
    });

    el.thumbList.appendChild(div);
  }
}

function renderMainPanel() {
  const photo = selectedPhoto();
  el.tagBadges.innerHTML = '';
  if (!photo) return;

  el.mainPhoto.src = photo.url;
  el.mainPhoto.alt = photo.name;

  el.formatNotice.classList.toggle('hidden', photo.isJpeg);

  const idx = state.photos.findIndex(p => p.id === photo.id);
  const atStart = state.checkedIds.size > 0
    ? state.photos.findIndex(p => state.checkedIds.has(p.id)) <= 0
    : idx === 0;
  const atEnd = state.checkedIds.size > 0
    ? Math.max(...state.photos.map((p, i) => state.checkedIds.has(p.id) ? i : -1)) >= state.photos.length - 1
    : idx === state.photos.length - 1;
  el.btnPrev.disabled = atStart;
  el.btnNext.disabled = atEnd;

  if (photo.tags.length === 0) {
    const span = document.createElement('span');
    span.className = 'no-tags';
    span.textContent = 'No tags yet';
    el.tagBadges.appendChild(span);
  } else {
    for (const name of photo.tags) {
      const span = document.createElement('span');
      span.className = 'tag-badge';
      span.textContent = name + ' ';
      const btn = document.createElement('button');
      btn.textContent = '×';
      btn.addEventListener('click', () => removeTag(photo.id, name));
      span.appendChild(btn);
      el.tagBadges.appendChild(span);
    }
  }
}

function renderRosterSelects() {
  for (const sel of [el.rosterSelect, el.rosterSelectModal]) {
    sel.innerHTML = '';
    for (const roster of state.rosters) {
      const opt = document.createElement('option');
      opt.value = roster.id;
      opt.textContent = roster.name;
      if (roster.id === state.activeRosterId) opt.selected = true;
      sel.appendChild(opt);
    }
  }
}

function setActiveRoster(id) {
  state.activeRosterId = id;
  persistRosters();
  renderRosterSelects();
  renderRosterModalList();
  renderRosterPanel();
}

function renderRosterPanel() {
  const photo = selectedPhoto();
  const taggedSet = new Set(photo ? photo.tags.map(t => t.toLowerCase()) : []);

  el.rosterButtons.innerHTML = '';
  for (const member of activeRosterMembers()) {
    const btn = document.createElement('button');
    const isTagged = taggedSet.has(member.name.toLowerCase());
    btn.className = 'chip' + (isTagged ? ' tagged' : '');
    btn.textContent = (member.number ? `#${member.number} ` : '') + member.name;
    btn.disabled = !photo;
    btn.addEventListener('click', () => {
      if (isTagged) removeTag(photo.id, member.name);
      else addTag(member.name, true);
    });
    el.rosterButtons.appendChild(btn);
  }

  const rNames = rosterNameSet();
  const extra = suggestedNames().filter(n => !rNames.has(n.toLowerCase()));
  el.extraNamesSection.classList.toggle('hidden', extra.length === 0);
  el.extraNameButtons.innerHTML = '';
  for (const name of extra) {
    const btn = document.createElement('button');
    const isTagged = taggedSet.has(name.toLowerCase());
    btn.className = 'chip extra' + (isTagged ? ' tagged' : '');
    btn.textContent = name;
    btn.disabled = !photo;
    btn.addEventListener('click', () => {
      if (isTagged) removeTag(photo.id, name);
      else addTag(name);
    });
    el.extraNameButtons.appendChild(btn);
  }
}

// --- Selection & navigation ---
function selectPhoto(id) {
  state.selectedPhotoId = id;
  el.tagInput.value = '';
  hideSuggestions();
  el.tagInput.focus();
  const thumbEl = el.thumbList.querySelector(`[data-id="${id}"]`);
  thumbEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function goPrev() {
  const photos = state.photos;
  if (state.checkedIds.size > 0) {
    const firstIdx = photos.findIndex(p => state.checkedIds.has(p.id));
    if (firstIdx > 0) { selectPhoto(photos[firstIdx - 1].id); state.checkedIds.clear(); render(); }
  } else {
    const idx = photos.findIndex(p => p.id === state.selectedPhotoId);
    if (idx > 0) { selectPhoto(photos[idx - 1].id); render(); }
  }
}

function goNext() {
  const photos = state.photos;
  if (state.checkedIds.size > 0) {
    const lastIdx = Math.max(...photos.map((p, i) => state.checkedIds.has(p.id) ? i : -1));
    if (lastIdx < photos.length - 1) { selectPhoto(photos[lastIdx + 1].id); state.checkedIds.clear(); render(); }
  } else {
    const idx = photos.findIndex(p => p.id === state.selectedPhotoId);
    if (idx < photos.length - 1) { selectPhoto(photos[idx + 1].id); render(); }
  }
}

// --- Tagging ---
// isRosterMember distinguishes a name picked from the roster (button click
// or an autocomplete suggestion flagged isRoster) from one typed by hand:
// only roster-sourced tags get mirrored into PersonInImage, per the app's
// person-vs-keyword split (see writeTagsToFile).
async function addTag(name, isRosterMember = false) {
  name = name.trim();
  if (!name) return;
  const targets = state.checkedIds.size > 0 ? [...state.checkedIds] : [state.selectedPhotoId];
  const writes = [];
  for (const id of targets) {
    const photo = state.photos.find(p => p.id === id);
    if (!photo) continue;
    if (photo.tags.some(t => t.toLowerCase() === name.toLowerCase())) continue;
    photo.tags.push(name);
    if (isRosterMember && !photo.personTags.some(t => t.toLowerCase() === name.toLowerCase())) {
      photo.personTags.push(name);
    }
    writes.push(writeTagsToFile(photo, photo.tags));
  }
  render();
  try {
    await Promise.all(writes);
  } catch (err) {
    alert(`Failed to save tag to file: ${err.message}`);
  }
}

async function removeTag(photoId, name) {
  const photo = state.photos.find(p => p.id === photoId);
  if (!photo) return;
  photo.tags = photo.tags.filter(t => t !== name);
  photo.personTags = photo.personTags.filter(t => t.toLowerCase() !== name.toLowerCase());
  render();
  try {
    const removedFromFile = await removeTagFromFile(photo, photo.tags, name);
    if (!removedFromFile) {
      alert(
        `"${name}" was removed here, but re-reading the file shows it's still in the saved `
        + `metadata. This isn't expected — please report it as a bug.`
      );
    }
  } catch (err) {
    alert(`Failed to remove tag from file: ${err.message}`);
  }
}

// Wipes every tag from every photo in the open folder. Runs strictly one
// photo at a time (rather than in parallel) so the progress bar reflects
// real completed-vs-total counts, and so this doesn't try to hold dozens
// of file writes open at once. The progress modal has no close/cancel
// control by design — it's meant to block the rest of the UI until this
// finishes, since letting someone navigate away or start tagging mid-wipe
// would be confusing.
async function clearAllKeywords() {
  const taggedPhotos = state.photos.filter(p => p.tags.length > 0);
  if (taggedPhotos.length === 0) {
    alert('No photos in this folder have tags to remove.');
    return;
  }
  const confirmed = confirm(
    `Remove ALL keywords from ${taggedPhotos.length} photo${taggedPhotos.length === 1 ? '' : 's'} `
    + `in this folder? This can't be undone.`
  );
  if (!confirmed) return;

  el.clearAllProgressFill.style.width = '0%';
  el.clearAllProgressText.textContent = `0 / ${taggedPhotos.length}`;
  el.clearAllModal.classList.remove('hidden');

  let done = 0;
  const failures = [];
  for (const photo of taggedPhotos) {
    try {
      photo.personTags = [];
      await writeTagsToFile(photo, []);
      photo.tags = [];
    } catch (err) {
      console.error('Failed to clear tags for', photo.name, err);
      failures.push(photo.name);
    }
    done++;
    el.clearAllProgressFill.style.width = `${Math.round((done / taggedPhotos.length) * 100)}%`;
    el.clearAllProgressText.textContent = `${done} / ${taggedPhotos.length}`;
  }

  el.clearAllModal.classList.add('hidden');
  render();

  if (failures.length > 0) {
    alert(
      `Removed keywords from ${taggedPhotos.length - failures.length} photo(s), but failed on `
      + `${failures.length}: ${failures.join(', ')}`
    );
  }
}

el.btnClearAllKeywords.addEventListener('click', clearAllKeywords);

// --- Tag input autocomplete ---
let filtered = [];
let activeIdx = -1;

function buildFiltered(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const photo = selectedPhoto();
  const alreadyTagged = new Set((photo ? photo.tags : []).map(n => n.toLowerCase()));

  const rosterMatches = activeRosterMembers()
    .filter(m => {
      if (alreadyTagged.has(m.name.toLowerCase())) return false;
      const nameMatch = m.name.toLowerCase().includes(q);
      const numMatch = m.number && m.number.toLowerCase().includes(q);
      return nameMatch || numMatch;
    })
    .map(m => ({ label: (m.number ? `#${m.number} ` : '') + m.name, value: m.name, isRoster: true }));

  const rNames = rosterNameSet();
  const nameMatches = suggestedNames()
    .filter(n => n.toLowerCase().includes(q) && !rNames.has(n.toLowerCase()) && !alreadyTagged.has(n.toLowerCase()))
    .map(n => ({ label: n, value: n, isRoster: false }));

  return [...rosterMatches, ...nameMatches].slice(0, 10);
}

function renderSuggestions() {
  el.tagSuggestions.innerHTML = '';
  if (filtered.length === 0) { hideSuggestions(); return; }
  el.tagSuggestions.classList.remove('hidden');
  filtered.forEach((item, i) => {
    const li = document.createElement('li');
    if (i === activeIdx) li.classList.add('active');
    if (item.isRoster) {
      const pill = document.createElement('span');
      pill.className = 'roster-pill';
      pill.textContent = 'roster';
      li.appendChild(pill);
    }
    li.appendChild(document.createTextNode(item.label));
    li.addEventListener('mousedown', e => { e.preventDefault(); submitTagInput(item); });
    el.tagSuggestions.appendChild(li);
  });
}

function hideSuggestions() {
  filtered = [];
  activeIdx = -1;
  el.tagSuggestions.classList.add('hidden');
  el.tagSuggestions.innerHTML = '';
}

function submitTagInput(item) {
  const name = typeof item === 'string' ? item : (item ? item.value : el.tagInput.value.trim());
  if (!name) return;
  addTag(name, !!(item && item.isRoster));
  el.tagInput.value = '';
  hideSuggestions();
  el.tagInput.focus();
}

el.tagInput.addEventListener('input', () => {
  filtered = buildFiltered(el.tagInput.value);
  activeIdx = filtered.length > 0 ? 0 : -1;
  renderSuggestions();
});

el.tagInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIdx = Math.min(activeIdx + 1, filtered.length - 1);
    renderSuggestions();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx = Math.max(activeIdx - 1, -1);
    renderSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIdx >= 0 && filtered[activeIdx]) submitTagInput(filtered[activeIdx]);
    else submitTagInput();
  } else if (e.key === 'Escape') {
    el.tagInput.value = '';
    hideSuggestions();
  }
});

el.btnAddTag.addEventListener('click', () => submitTagInput());

// --- Global keyboard navigation ---
window.addEventListener('keydown', e => {
  const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
  if (inInput && e.target.value !== '') return;
  if (state.photos.length === 0) return;
  if (e.key === 'ArrowLeft') goPrev();
  if (e.key === 'ArrowRight') goNext();
});

el.btnPrev.addEventListener('click', goPrev);
el.btnNext.addEventListener('click', goNext);

el.btnFilterUntagged.addEventListener('click', () => {
  state.filterUntagged = !state.filterUntagged;
  renderThumbs();
});

el.btnClearChecked.addEventListener('click', () => {
  state.checkedIds.clear();
  render();
});

// --- Lightbox ---
el.mainPhoto.parentElement.addEventListener('click', () => {
  const photo = selectedPhoto();
  if (!photo) return;
  el.lightboxImg.src = photo.url;
  el.lightboxImg.alt = photo.name;
  el.lightbox.classList.remove('hidden');
});
el.btnLightboxClose.addEventListener('click', () => el.lightbox.classList.add('hidden'));
el.lightbox.addEventListener('click', e => {
  if (e.target === el.lightbox || e.target === el.lightboxImg) el.lightbox.classList.add('hidden');
});

// --- Roster management ---
function renderRosterModalList() {
  el.rosterList.innerHTML = '';
  const roster = activeRoster();
  for (const member of roster ? roster.members : []) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = (member.number ? `#${member.number} ` : '') + member.name;
    li.appendChild(label);
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.addEventListener('click', () => {
      roster.members = roster.members.filter(m => m.id !== member.id);
      persistRosters();
      renderRosterModalList();
      renderRosterPanel();
    });
    li.appendChild(btn);
    el.rosterList.appendChild(li);
  }
}

function persistRosters() {
  return Promise.all([
    kvSet('rosters', state.rosters),
    kvSet('activeRosterId', state.activeRosterId),
  ]);
}

// Click-outside-to-close: every field in these modals autosaves as you go
// (see persist* calls throughout), so there's nothing to lose by dismissing
// on an outside click. Progress modals (marked modal-no-dismiss) represent
// an in-flight file write with no cancel affordance, so they're excluded —
// they close themselves when the operation finishes.
for (const overlay of ROOT.querySelectorAll('.modal-overlay:not(.modal-no-dismiss)')) {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
}

// --- Help ---
el.btnOpenHelp.addEventListener('click', () => el.helpModal.classList.remove('hidden'));
el.btnHelpClose.addEventListener('click', () => el.helpModal.classList.add('hidden'));

// --- Settings ---
el.btnOpenSettings.addEventListener('click', () => {
  el.settingsPhotographer.value = state.settings.photographer;
  el.settingsOrg.value = state.settings.orgName;
  el.settingsDarkMode.checked = state.settings.darkMode;
  el.settingsModal.classList.remove('hidden');
});
el.btnSettingsClose.addEventListener('click', () => el.settingsModal.classList.add('hidden'));
el.settingsPhotographer.addEventListener('input', () => { state.settings.photographer = el.settingsPhotographer.value; });
el.settingsOrg.addEventListener('input', () => { state.settings.orgName = el.settingsOrg.value; });
el.settingsPhotographer.addEventListener('change', persistSettings);
el.settingsOrg.addEventListener('change', persistSettings);
el.settingsDarkMode.addEventListener('change', () => {
  state.settings.darkMode = el.settingsDarkMode.checked;
  applyTheme();
  persistSettings();
});

el.btnManageRoster.addEventListener('click', () => {
  renderRosterSelects();
  renderRosterModalList();
  el.rosterNameEditSection.classList.add('hidden');
  activateRosterTab(el.addIndividualSection);
  el.csvImportText.value = '';
  el.csvImportStatus.textContent = '';
  el.websiteImportUrl.value = '';
  el.websiteImportStatus.textContent = '';
  el.rosterIoStatus.textContent = '';
  el.rosterModal.classList.remove('hidden');
});
el.btnRosterClose.addEventListener('click', () => el.rosterModal.classList.add('hidden'));

el.btnRosterAdd.addEventListener('click', () => {
  const roster = activeRoster();
  if (!roster) return;
  const name = el.rosterNameInput.value.trim();
  if (!name) return;
  const number = el.rosterNumberInput.value.trim();
  roster.members.push({ id: crypto.randomUUID(), name, number });
  persistRosters();
  el.rosterNameInput.value = '';
  el.rosterNumberInput.value = '';
  el.rosterNameInput.focus();
  renderRosterModalList();
  renderRosterPanel();
});

// --- Roster switching / creating / renaming / deleting ---
el.rosterSelect.addEventListener('change', () => setActiveRoster(el.rosterSelect.value));
el.rosterSelectModal.addEventListener('change', () => setActiveRoster(el.rosterSelectModal.value));

let rosterNameEditMode = 'new';

function openRosterNameEdit(mode) {
  rosterNameEditMode = mode;
  el.rosterNameEditInput.value = mode === 'rename' ? (activeRoster()?.name || '') : '';
  el.rosterNameEditSection.classList.remove('hidden');
  el.rosterNameEditInput.focus();
  el.rosterNameEditInput.select();
}

el.btnRosterNew.addEventListener('click', () => openRosterNameEdit('new'));
el.btnRosterRename.addEventListener('click', () => openRosterNameEdit('rename'));
el.btnRosterNameEditCancel.addEventListener('click', () => el.rosterNameEditSection.classList.add('hidden'));

el.btnRosterNameEditSave.addEventListener('click', () => {
  const name = el.rosterNameEditInput.value.trim();
  if (!name) return;
  if (rosterNameEditMode === 'new') {
    const roster = { id: crypto.randomUUID(), name, members: [] };
    state.rosters.push(roster);
    state.activeRosterId = roster.id;
  } else {
    const roster = activeRoster();
    if (roster) roster.name = name;
  }
  persistRosters();
  el.rosterNameEditSection.classList.add('hidden');
  renderRosterSelects();
  renderRosterModalList();
  renderRosterPanel();
});

el.rosterNameEditInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); el.btnRosterNameEditSave.click(); }
  else if (e.key === 'Escape') el.rosterNameEditSection.classList.add('hidden');
});

el.btnRosterDelete.addEventListener('click', () => {
  if (state.rosters.length <= 1) { alert('You need at least one roster.'); return; }
  const roster = activeRoster();
  if (!roster) return;
  if (!confirm(`Delete roster "${roster.name}"? This can't be undone.`)) return;
  state.rosters = state.rosters.filter(r => r.id !== roster.id);
  state.activeRosterId = state.rosters[0].id;
  persistRosters();
  renderRosterSelects();
  renderRosterModalList();
  renderRosterPanel();
});

el.btnRosterClear.addEventListener('click', () => {
  const roster = activeRoster();
  if (!roster || roster.members.length === 0) return;
  if (!confirm(`Remove all ${roster.members.length} member(s) from "${roster.name}"? This can't be undone.`)) return;
  roster.members = [];
  persistRosters();
  renderRosterModalList();
  renderRosterPanel();
});

// --- CSV import ---
// Splits one line on a single delimiter, honoring double-quoted fields.
function splitCsvLine(line, delimiter) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// Pasting from a spreadsheet produces tab-delimited rows, which can contain
// literal, unquoted commas inside a name (e.g. "Doe, Jr") — so the whole
// paste is sniffed for a single delimiter up front rather than treating
// commas and tabs as interchangeable within a line.
function detectCsvDelimiter(text) {
  return text.includes('\t') ? '\t' : ',';
}

// Each line is "Number,Name" or, with no number, just "Name".
function parseRosterCsv(text) {
  const delimiter = detectCsvDelimiter(text);
  const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
  const rows = lines.map(l => splitCsvLine(l, delimiter));
  if (rows.length) {
    const first = rows[0].map(c => c.trim());
    const isHeader = first.length >= 2
      ? /^(#|no\.?|number)$/i.test(first[0])
      : /^name$/i.test(first[0]);
    if (isHeader) rows.shift();
  }
  return rows
    .map(cols => cols.length >= 2
      ? { number: (cols[0] || '').trim(), name: (cols[1] || '').trim() }
      : { number: '', name: (cols[0] || '').trim() })
    .filter(row => row.name);
}

// Shared by the CSV and website importers: adds { name, number } rows to a
// roster, skipping names already present (case-insensitive). Persists and
// re-renders on any change; callers just report the resulting counts.
function addRowsToRoster(roster, rows) {
  const seen = rosterNameSet();
  let added = 0, skipped = 0;
  for (const { name, number } of rows) {
    const key = name.toLowerCase();
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    roster.members.push({ id: crypto.randomUUID(), name, number });
    added++;
  }
  if (added) {
    persistRosters();
    renderRosterModalList();
    renderRosterPanel();
  }
  return { added, skipped };
}

function importStatusText({ added, skipped }) {
  return `Added ${added}${skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}.`;
}

// The four tabs in the roster modal (manual entry, CSV/TSV paste,
// Presto/Sidearm team-website fetch, whole-roster JSON export/import) work
// like folder tabs — exactly one panel is visible at a time, and clicking a
// tab switches to it.
const ROSTER_TABS = [
  { tab: el.btnToggleAddIndividual, panel: el.addIndividualSection, focus: el.rosterNameInput },
  { tab: el.btnToggleCsvImport, panel: el.csvImportSection, focus: el.csvImportText },
  { tab: el.btnToggleWebsiteImport, panel: el.websiteImportSection, focus: el.websiteImportUrl },
  { tab: el.btnToggleJsonImport, panel: el.jsonImportSection, focus: null },
];

function activateRosterTab(panel) {
  for (const entry of ROSTER_TABS) {
    const active = entry.panel === panel;
    entry.panel.classList.toggle('hidden', !active);
    entry.tab.classList.toggle('active', active);
    entry.tab.setAttribute('aria-selected', String(active));
  }
}

for (const entry of ROSTER_TABS) {
  entry.tab.addEventListener('click', () => {
    activateRosterTab(entry.panel);
    entry.focus?.focus();
  });
}

el.btnCsvImport.addEventListener('click', () => {
  const roster = activeRoster();
  if (!roster) return;
  const rows = parseRosterCsv(el.csvImportText.value);
  if (!rows.length) {
    el.csvImportStatus.textContent = 'No rows found.';
    return;
  }
  const result = addRowsToRoster(roster, rows);
  el.csvImportText.value = '';
  el.csvImportStatus.textContent = importStatusText(result);
});

// --- Roster import from a Presto Sports team-website roster page ---
//
// Only works when this app is running embedded on the same site as the
// roster page (see embed.js) — a same-origin fetch() is required, since
// there's no backend here to proxy around CORS. Presto's roster table has
// one <tr> per player: the jersey number, when the sport has one, is in a
// cell with class "jersey-number" — sports without jersey numbers (e.g.
// triathlon) omit that cell entirely rather than leaving it empty, so it
// must NOT be assumed to be the row's first cell (that's the name cell on
// those rosters, and the wrong guess previously leaked the mangled name
// text into the number field). The player's name is the first non-empty
// <a> inside the row's <th> (the <th> also contains duplicate
// hidden/responsive copies of that link for other breakpoints, so a plain
// textContent read isn't reliable).
function parsePrestoRosterHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return [];
  const rows = [...table.querySelectorAll('tbody tr')];
  return rows
    .map(row => {
      const numberCell = row.querySelector('.jersey-number');
      const number = numberCell?.textContent.trim() || '';
      const nameCell = row.querySelector('th') || row.children[1];
      const nameLink = nameCell
        ? [...nameCell.querySelectorAll('a')].find(a => a.textContent.trim())
        : null;
      const name = (nameLink || nameCell)?.textContent.trim().replace(/\s+/g, ' ') || '';
      return { number, name };
    })
    .filter(row => row.name);
}

// Resolves what the user typed/pasted (a full URL or a bare path) to a
// same-origin path suitable for fetch(), or null if it points elsewhere.
function resolveSameOriginPath(input) {
  const value = input.trim();
  if (!value) return null;
  if (value.startsWith('/')) return value;
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

el.btnWebsiteImport.addEventListener('click', async () => {
  const roster = activeRoster();
  if (!roster) return;
  const path = resolveSameOriginPath(el.websiteImportUrl.value);
  if (!path) {
    el.websiteImportStatus.textContent =
      "This only works for pages on the current site — open the embedded app from your athletics site and paste a roster page from the same site.";
    return;
  }
  el.websiteImportStatus.textContent = 'Fetching…';
  let html;
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch {
    el.websiteImportStatus.textContent =
      "Couldn't fetch that page — make sure you're using the embedded version on your athletics site, and that the URL is on the same site.";
    return;
  }
  const rows = parsePrestoRosterHtml(html);
  if (!rows.length) {
    el.websiteImportStatus.textContent = "Couldn't find a roster table on that page.";
    return;
  }
  const result = addRowsToRoster(roster, rows);
  el.websiteImportUrl.value = '';
  el.websiteImportStatus.textContent = importStatusText(result);
});

// --- Roster export / import (JSON, all rosters) ---
el.btnRosterExport.addEventListener('click', () => {
  const payload = {
    app: 'tagmyphoto-express',
    type: 'rosters',
    version: 1,
    exportedAt: new Date().toISOString(),
    rosters: state.rosters.map(r => ({
      name: r.name,
      members: r.members.map(m => ({ name: m.name, number: m.number || '' })),
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rosters-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  el.rosterIoStatus.textContent = `Exported ${state.rosters.length} roster(s).`;
});

el.btnRosterImport.addEventListener('click', () => el.rosterImportFile.click());

el.rosterImportFile.addEventListener('change', async () => {
  const file = el.rosterImportFile.files[0];
  el.rosterImportFile.value = '';
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    el.rosterIoStatus.textContent = 'Invalid JSON file.';
    return;
  }
  const importedRosters = Array.isArray(data?.rosters) ? data.rosters : null;
  if (!importedRosters) {
    el.rosterIoStatus.textContent = "File doesn't look like a roster export.";
    return;
  }

  let rostersAdded = 0, rostersMerged = 0, membersAdded = 0;
  for (const r of importedRosters) {
    const name = String(r?.name || '').trim();
    if (!name) continue;
    let roster = state.rosters.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (roster) {
      rostersMerged++;
    } else {
      roster = { id: crypto.randomUUID(), name, members: [] };
      state.rosters.push(roster);
      rostersAdded++;
    }
    const seen = new Set(roster.members.map(m => m.name.toLowerCase()));
    const members = Array.isArray(r?.members) ? r.members : [];
    for (const m of members) {
      const mName = String(m?.name || '').trim();
      if (!mName) continue;
      const key = mName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      roster.members.push({ id: crypto.randomUUID(), name: mName, number: String(m?.number || '').trim() });
      membersAdded++;
    }
  }

  if (!rostersAdded && !rostersMerged) {
    el.rosterIoStatus.textContent = 'No rosters found in file.';
    return;
  }

  persistRosters();
  renderRosterSelects();
  renderRosterModalList();
  renderRosterPanel();
  el.rosterIoStatus.textContent =
    `Imported ${rostersAdded} new roster${rostersAdded === 1 ? '' : 's'}` +
    `${rostersMerged ? `, merged into ${rostersMerged} existing` : ''}` +
    `, added ${membersAdded} member${membersAdded === 1 ? '' : 's'}.`;
});

// --- Metadata Templates ---
function persistTemplates() {
  return Promise.all([
    kvSet('metadataTemplates', state.metadataTemplates),
    kvSet('activeTemplateId', state.activeTemplateId),
  ]);
}

// Populated when the Apply-Template form opens; discarded when it closes.
// photographer/orgName default from the persisted Settings (state.settings)
// but only live here while editing — a per-apply override doesn't write
// back to Settings. Custom vars are always per-session only. Date vars come
// from each photo's own EXIF capture date instead (see
// computeDateVarsFromExif), not from here.
let templateApplyDraft = null; // { templateId, photographer, orgName, customVars: {} }

// Interpolates one template's fields against the given fill-ins (plus
// per-photo 'persons') and writes them into the photo's file. Keywords
// routes through writeTagsToFile so template-driven and manual tag edits
// never diverge; the remaining fields go through one additional
// read-modify-write pass. Keywords defaults to the photo's current tag
// list when the template doesn't define it; PersonInImage defaults to the
// roster-sourced subset (see writeTagsToFile) unless the template sets it
// explicitly, in which case that value locks the field going forward.
async function applyTemplateToPhoto(photo, template, fillIns) {
  const exiv2 = await getExiv2();
  let dateVars = computeDateVars('');
  try {
    const initialBuf = new Uint8Array(await (await photo.fileHandle.getFile()).arrayBuffer());
    dateVars = computeDateVarsFromExif(exiv2.read(initialBuf)?.exif);
  } catch (err) {
    console.warn(`Could not read capture date for ${photo.name}:`, err);
  }
  const vars = { ...fillIns, ...dateVars, persons: photo.personTags.join(', ') };
  const values = {};
  for (const [key, raw] of Object.entries(template.fields)) {
    if (raw && raw.trim()) values[key] = interpolateTemplate(raw, vars);
  }
  if (values.Keywords === undefined) values.Keywords = photo.tags.join(', ');
  // A template that explicitly sets PersonInImage wins from here on — lock
  // it so roster tag edits (see writeTagsToFile) stop overwriting it.
  // Otherwise default it to the roster-sourced tags, same as normal syncing.
  if (values.PersonInImage !== undefined) {
    photo.personInImageLocked = true;
  } else {
    values.PersonInImage = photo.personTags.join(', ');
  }

  const keywords = [...new Set(splitKeywords(values.Keywords))];
  await writeTagsToFile(photo, keywords);
  photo.tags = keywords;

  let buf = new Uint8Array(await (await photo.fileHandle.getFile()).arrayBuffer());
  let changed = false;
  for (const config of TEMPLATE_FIELD_MAP) {
    if (config.key === 'Keywords') continue;
    const value = values[config.key];
    if (value === undefined) continue;
    try {
      buf = writeTemplateField(exiv2, buf, config, value);
      changed = true;
    } catch (err) {
      console.warn(`Skipping ${config.key} for ${photo.name}:`, err);
    }
  }
  if (changed) {
    const writable = await photo.fileHandle.createWritable();
    await writable.write(buf);
    await writable.close();
  }
}

// Sequential, not parallel — mirrors clearAllKeywords: accurate progress and
// avoids many concurrent open file writes. No close/cancel control while
// running, for the same reason clearAllKeywords has none.
async function applyTemplateToAllPhotos(template, fillIns) {
  const jpegPhotos = state.photos.filter(p => p.isJpeg && p.fileHandle);
  if (!jpegPhotos.length) { alert('No JPEG photos in this folder to apply the template to.'); return; }
  if (!confirm(`Apply template "${template.name}" to ${jpegPhotos.length} photo(s)? This can't be undone.`)) return;

  el.applyTemplateProgressFill.style.width = '0%';
  el.applyTemplateProgressText.textContent = `0 / ${jpegPhotos.length}`;
  el.applyTemplateModal.classList.remove('hidden');
  let done = 0;
  const failures = [];
  for (const photo of jpegPhotos) {
    try { await applyTemplateToPhoto(photo, template, fillIns); }
    catch (err) { console.error('Failed to apply template to', photo.name, err); failures.push(photo.name); }
    done++;
    el.applyTemplateProgressFill.style.width = `${Math.round((done / jpegPhotos.length) * 100)}%`;
    el.applyTemplateProgressText.textContent = `${done} / ${jpegPhotos.length}`;
  }
  el.applyTemplateModal.classList.add('hidden');
  render();
  if (failures.length) alert(`Applied to ${jpegPhotos.length - failures.length}, failed on ${failures.length}: ${failures.join(', ')}`);
}

function renderApplyTemplateButtonState() {
  el.btnApplyTemplate.disabled = state.metadataTemplates.length === 0;
  el.btnApplyTemplate.title = state.metadataTemplates.length === 0
    ? 'Create a template first (Manage → + New)'
    : '';
}

function renderTemplateSelects() {
  for (const sel of [el.templateSelectModal, el.templateApplySelect]) {
    sel.innerHTML = '';
    for (const template of state.metadataTemplates) {
      const opt = document.createElement('option');
      opt.value = template.id;
      opt.textContent = template.name;
      sel.appendChild(opt);
    }
  }
  el.templateSelectModal.value = state.activeTemplateId || '';
  if (templateApplyDraft) el.templateApplySelect.value = templateApplyDraft.templateId || '';
}

function setActiveTemplate(id) {
  state.activeTemplateId = id;
  persistTemplates();
  renderTemplateSelects();
  renderTemplateFieldsStructure();
  renderTemplatePreview();
  renderTemplateCustomVarsSection();
}

function templateFieldId(key) {
  return `template-field-${key.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

// Sample values used only to preview interpolation inside the editor —
// never written anywhere.
function buildPreviewVars(template) {
  const vars = {
    photographer: 'Jane Photographer',
    org_name: 'Sample Org',
    persons: 'Alex Kim, Sam Lee',
    ...computeDateVars(new Date().toISOString().slice(0, 10)),
  };
  for (const key of detectFillIns(template.fields)) vars[key] = `[${key}]`;
  return vars;
}

// The variable-chip row inserts at the cursor of whichever field textarea
// was last focused, so it's tracked as it changes rather than re-derived.
let lastFocusedTemplateField = null;

function renderTemplateVarsRow() {
  el.templateVarsRow.innerHTML = '';
  const chips = [...BUILTIN_VARS, { key: 'persons', label: "This photo's tagged names" }];
  for (const v of chips) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = `{${v.key}}`;
    chip.title = v.label;
    chip.addEventListener('click', () => insertVarIntoField(v.key));
    el.templateVarsRow.appendChild(chip);
  }
}

function insertVarIntoField(key) {
  const target = lastFocusedTemplateField;
  if (!target) return;
  const insertion = `{${key}}`;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  target.value = target.value.slice(0, start) + insertion + target.value.slice(end);
  target.selectionStart = target.selectionEnd = start + insertion.length;
  target.dispatchEvent(new Event('input'));
  target.focus();
  persistTemplates();
}

// Rebuilds the field textareas from scratch — only called when the active
// template or its identity changes (opening the modal, switching/creating/
// deleting a template), never on every keystroke, so typing doesn't fight
// cursor position against a re-render.
function renderTemplateFieldsStructure() {
  const template = activeTemplate();
  el.templateFields.innerHTML = '';
  if (!template) return;
  for (const group of TEMPLATE_FIELD_GROUPS) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'template-field-group';
    const legend = document.createElement('legend');
    legend.textContent = group;
    fieldset.appendChild(legend);
    for (const config of TEMPLATE_FIELD_MAP.filter(f => f.group === group)) {
      const row = document.createElement('div');
      row.className = 'template-field-row';
      const label = document.createElement('label');
      label.textContent = config.key;
      label.htmlFor = templateFieldId(config.key);
      const textarea = document.createElement('textarea');
      textarea.id = templateFieldId(config.key);
      textarea.rows = 1;
      textarea.value = template.fields[config.key] || '';
      textarea.addEventListener('focus', () => { lastFocusedTemplateField = textarea; });
      textarea.addEventListener('input', () => {
        template.fields[config.key] = textarea.value;
        renderTemplatePreview();
        renderTemplateCustomVarsSection();
      });
      textarea.addEventListener('change', () => persistTemplates());
      row.appendChild(label);
      row.appendChild(textarea);
      fieldset.appendChild(row);
    }
    el.templateFields.appendChild(fieldset);
  }
}

function renderTemplateCustomVarsSection() {
  const template = activeTemplate();
  const vars = template ? detectFillIns(template.fields) : [];
  el.templateCustomVarsSection.classList.toggle('hidden', vars.length === 0);
  el.templateCustomVars.innerHTML = '';
  for (const v of vars) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `{${v}}`;
    el.templateCustomVars.appendChild(chip);
  }
}

function renderTemplatePreview() {
  const template = activeTemplate();
  el.templatePreview.innerHTML = '';
  if (!template) return;
  const vars = buildPreviewVars(template);
  for (const config of TEMPLATE_FIELD_MAP) {
    const raw = template.fields[config.key];
    if (!raw || !raw.trim()) continue;
    const row = document.createElement('div');
    row.className = 'template-preview-row';
    const label = document.createElement('span');
    label.className = 'template-preview-label';
    label.textContent = `${config.key}: `;
    row.appendChild(label);
    row.appendChild(document.createTextNode(interpolateTemplate(raw, vars)));
    el.templatePreview.appendChild(row);
  }
  if (!el.templatePreview.children.length) {
    el.templatePreview.innerHTML = '<span class="no-tags">No fields filled in yet.</span>';
  }
}

el.btnManageTemplates.addEventListener('click', () => {
  if (state.metadataTemplates.length === 0) {
    const template = { id: crypto.randomUUID(), name: 'My Template', fields: {} };
    state.metadataTemplates.push(template);
    state.activeTemplateId = template.id;
    persistTemplates();
    renderApplyTemplateButtonState();
  }
  renderTemplateSelects();
  renderTemplateVarsRow();
  renderTemplateFieldsStructure();
  renderTemplatePreview();
  renderTemplateCustomVarsSection();
  el.templateNameEditSection.classList.add('hidden');
  el.templateIoStatus.textContent = '';
  el.templateModal.classList.remove('hidden');
});
el.btnTemplateClose.addEventListener('click', () => el.templateModal.classList.add('hidden'));
el.templateSelectModal.addEventListener('change', () => setActiveTemplate(el.templateSelectModal.value));

let templateNameEditMode = 'new';

function openTemplateNameEdit(mode) {
  templateNameEditMode = mode;
  el.templateNameEditInput.value = mode === 'rename' ? (activeTemplate()?.name || '') : '';
  el.templateNameEditSection.classList.remove('hidden');
  el.templateNameEditInput.focus();
  el.templateNameEditInput.select();
}

el.btnTemplateNew.addEventListener('click', () => openTemplateNameEdit('new'));
el.btnTemplateRename.addEventListener('click', () => openTemplateNameEdit('rename'));
el.btnTemplateNameEditCancel.addEventListener('click', () => el.templateNameEditSection.classList.add('hidden'));

el.btnTemplateNameEditSave.addEventListener('click', () => {
  const name = el.templateNameEditInput.value.trim();
  if (!name) return;
  if (templateNameEditMode === 'new') {
    const template = { id: crypto.randomUUID(), name, fields: {} };
    state.metadataTemplates.push(template);
    state.activeTemplateId = template.id;
  } else {
    const template = activeTemplate();
    if (template) template.name = name;
  }
  persistTemplates();
  el.templateNameEditSection.classList.add('hidden');
  renderTemplateSelects();
  renderTemplateVarsRow();
  renderTemplateFieldsStructure();
  renderTemplatePreview();
  renderTemplateCustomVarsSection();
  renderApplyTemplateButtonState();
});

el.templateNameEditInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); el.btnTemplateNameEditSave.click(); }
  else if (e.key === 'Escape') el.templateNameEditSection.classList.add('hidden');
});

el.btnTemplateDuplicate.addEventListener('click', () => {
  const template = activeTemplate();
  if (!template) return;
  const copy = { id: crypto.randomUUID(), name: `${template.name} copy`, fields: { ...template.fields } };
  state.metadataTemplates.push(copy);
  state.activeTemplateId = copy.id;
  persistTemplates();
  renderTemplateSelects();
  renderTemplateFieldsStructure();
  renderTemplatePreview();
  renderTemplateCustomVarsSection();
});

el.btnTemplateDelete.addEventListener('click', () => {
  const template = activeTemplate();
  if (!template) return;
  if (!confirm(`Delete template "${template.name}"? This can't be undone.`)) return;
  state.metadataTemplates = state.metadataTemplates.filter(t => t.id !== template.id);
  state.activeTemplateId = state.metadataTemplates[0]?.id || null;
  persistTemplates();
  renderTemplateSelects();
  renderTemplateFieldsStructure();
  renderTemplatePreview();
  renderTemplateCustomVarsSection();
  renderApplyTemplateButtonState();
});

// --- Template export / import (JSON, one template per file) ---
el.btnTemplateExport.addEventListener('click', () => {
  const template = activeTemplate();
  if (!template) return;
  const payload = { name: template.name, fields: template.fields };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const slug = template.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  a.download = `${slug || 'template'}.json`;
  a.click();
  URL.revokeObjectURL(url);
  el.templateIoStatus.textContent = `Exported "${template.name}".`;
});

el.btnTemplateImport.addEventListener('click', () => el.templateImportFile.click());

el.templateImportFile.addEventListener('change', async () => {
  const file = el.templateImportFile.files[0];
  el.templateImportFile.value = '';
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    el.templateIoStatus.textContent = 'Invalid JSON file.';
    return;
  }
  const name = String(data?.name || '').trim();
  if (!name || typeof data.fields !== 'object' || data.fields === null) {
    el.templateIoStatus.textContent = "File doesn't look like a template export.";
    return;
  }

  // Always creates a new template rather than merging by name — merging two
  // full field-maps by name would silently overwrite one preset's values
  // with another's, which is much more surprising than merging flat name
  // lists the way roster import does.
  const fields = {};
  for (const config of TEMPLATE_FIELD_MAP) {
    if (typeof data.fields[config.key] === 'string') fields[config.key] = data.fields[config.key];
  }
  const template = { id: crypto.randomUUID(), name, fields };
  state.metadataTemplates.push(template);
  state.activeTemplateId = template.id;
  persistTemplates();
  renderTemplateSelects();
  renderTemplateVarsRow();
  renderTemplateFieldsStructure();
  renderTemplatePreview();
  renderTemplateCustomVarsSection();
  renderApplyTemplateButtonState();
  el.templateIoStatus.textContent = `Imported "${name}" as a new template.`;
});

// --- Apply-Template flow ---
el.btnApplyTemplate.addEventListener('click', () => {
  if (state.metadataTemplates.length === 0) return;
  if (!templateApplyDraft) {
    templateApplyDraft = {
      templateId: (activeTemplate() || state.metadataTemplates[0]).id,
      photographer: state.settings.photographer,
      orgName: state.settings.orgName,
      customVars: {},
    };
  }
  renderTemplateSelects();
  renderTemplateApplyForm();
  el.templateApplyModal.classList.remove('hidden');
});

el.btnTemplateApplyCancel.addEventListener('click', () => el.templateApplyModal.classList.add('hidden'));

el.templateApplySelect.addEventListener('change', () => {
  templateApplyDraft.templateId = el.templateApplySelect.value;
  renderTemplateApplyForm();
});

function renderTemplateApplyForm() {
  if (!templateApplyDraft) return;
  el.templateApplySelect.value = templateApplyDraft.templateId;
  el.templateApplyPhotographer.value = templateApplyDraft.photographer;
  el.templateApplyOrg.value = templateApplyDraft.orgName;

  const template = state.metadataTemplates.find(t => t.id === templateApplyDraft.templateId);
  const customKeys = template ? detectFillIns(template.fields) : [];
  el.templateApplyCustomVarsSection.classList.toggle('hidden', customKeys.length === 0);
  el.templateApplyCustomVars.innerHTML = '';
  for (const key of customKeys) {
    const row = document.createElement('div');
    row.className = 'template-apply-row';
    const label = document.createElement('label');
    label.textContent = key;
    label.htmlFor = `template-apply-var-${slugForId(key)}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `template-apply-var-${slugForId(key)}`;
    input.value = templateApplyDraft.customVars[key] || '';
    input.addEventListener('input', () => { templateApplyDraft.customVars[key] = input.value; });
    row.appendChild(label);
    row.appendChild(input);
    el.templateApplyCustomVars.appendChild(row);
  }
}

el.templateApplyPhotographer.addEventListener('input', () => { templateApplyDraft.photographer = el.templateApplyPhotographer.value; });
el.templateApplyOrg.addEventListener('input', () => { templateApplyDraft.orgName = el.templateApplyOrg.value; });

el.btnTemplateApplyConfirm.addEventListener('click', async () => {
  const template = state.metadataTemplates.find(t => t.id === templateApplyDraft.templateId);
  if (!template) return;
  const fillIns = {
    photographer: templateApplyDraft.photographer,
    org_name: templateApplyDraft.orgName,
    ...templateApplyDraft.customVars,
  };
  el.templateApplyModal.classList.add('hidden');
  await applyTemplateToAllPhotos(template, fillIns);
});

// --- File Renaming ---
function persistRenameTemplates() {
  return Promise.all([
    kvSet('renameTemplates', state.renameTemplates),
    kvSet('activeRenameTemplateId', state.activeRenameTemplateId),
  ]);
}

// Same never-persisted-across-sessions rationale as templateApplyDraft.
let renameApplyDraft = null; // { templateId, customVars: {} }

// Renames one photo's underlying file. Prefers FileSystemFileHandle.move()
// (renames in place, no dedicated Chrome version check needed — just
// feature-detect) and falls back to copy-then-delete via the parent
// directory handle for browsers where it isn't available.
async function renamePhotoFile(photo, newName) {
  if (typeof photo.fileHandle.move === 'function') {
    await photo.fileHandle.move(newName);
  } else {
    const file = await photo.fileHandle.getFile();
    const newHandle = await state.dirHandle.getFileHandle(newName, { create: true });
    const writable = await newHandle.createWritable();
    await writable.write(file);
    await writable.close();
    await state.dirHandle.removeEntry(photo.name);
    photo.fileHandle = newHandle;
  }
  photo.name = newName;
}

// Per-photo variables for a rename pattern: EXIF capture date (JPEG only,
// same lookup as applyTemplateToPhoto), the roster/tag-derived vars, the
// original base filename, and this photo's 1-based position in the batch.
// pattern is scanned for {SEQ:...} tokens so each one gets a value computed
// from its own start/padding spec at this photo's position.
async function computeRenameVars(photo, index, fillIns, pattern) {
  let dateVars = computeDateVars('');
  if (photo.isJpeg) {
    try {
      const exiv2 = await getExiv2();
      const buf = new Uint8Array(await (await photo.fileHandle.getFile()).arrayBuffer());
      dateVars = computeDateVarsFromExif(exiv2.read(buf)?.exif);
    } catch (err) {
      console.warn(`Could not read capture date for ${photo.name}:`, err);
    }
  }
  const dot = photo.name.lastIndexOf('.');
  const vars = {
    ...fillIns,
    ...dateVars,
    persons: photo.personTags.join(', '),
    keywords: photo.tags.join(', '),
    filename: dot > 0 ? photo.name.slice(0, dot) : photo.name,
  };
  for (const [, spec] of pattern.matchAll(/\{SEQ:(\d+)\}/gi)) vars[`SEQ:${spec}`] = seqValueForIndex(spec, index);
  return vars;
}

// Renames targetPhotos per the pattern. Plans every new name up front (a
// dry run — no disk writes yet) so a pattern that collides with another
// file, in or out of the batch, is caught and reported before anything is
// touched, rather than partway through with some files already renamed.
// Runs sequentially and blocks the UI while renaming, same rationale as
// clearAllKeywords/applyTemplateToAllPhotos.
async function renamePhotos(targetPhotos, pattern, fillIns) {
  if (!targetPhotos.length) { alert('No photos to rename.'); return; }

  const outsideNames = new Set(
    state.photos.filter(p => !targetPhotos.includes(p)).map(p => p.name.toLowerCase())
  );

  const plan = [];
  for (let i = 0; i < targetPhotos.length; i++) {
    const photo = targetPhotos[i];
    const vars = await computeRenameVars(photo, i + 1, fillIns, pattern);
    const newName = buildNewFilename(interpolateTemplate(pattern, vars), photo.name);
    plan.push({ photo, newName });
  }

  const claimed = new Map(); // lowercased newName -> photo.id that claimed it
  for (const { photo, newName } of plan) {
    const key = newName.toLowerCase();
    if (key !== photo.name.toLowerCase() && outsideNames.has(key)) {
      alert(`Can't rename "${photo.name}" to "${newName}" — a file with that name already exists in the folder.`);
      return;
    }
    if (claimed.has(key) && claimed.get(key) !== photo.id) {
      alert(`The rename pattern produces the same filename "${newName}" for multiple photos. Add {SEQ:001} (or another unique variable) to the pattern and try again.`);
      return;
    }
    claimed.set(key, photo.id);
  }

  if (!confirm(`Rename ${plan.length} file${plan.length === 1 ? '' : 's'}? This can't be undone.`)) return;

  el.renameProgressFill.style.width = '0%';
  el.renameProgressText.textContent = `0 / ${plan.length}`;
  el.renameProgressModal.classList.remove('hidden');

  let done = 0;
  const failures = [];
  for (const { photo, newName } of plan) {
    try {
      if (newName !== photo.name) await renamePhotoFile(photo, newName);
    } catch (err) {
      console.error('Failed to rename', photo.name, err);
      failures.push(photo.name);
    }
    done++;
    el.renameProgressFill.style.width = `${Math.round((done / plan.length) * 100)}%`;
    el.renameProgressText.textContent = `${done} / ${plan.length}`;
  }

  el.renameProgressModal.classList.add('hidden');
  render();
  if (failures.length) {
    alert(`Renamed ${plan.length - failures.length}, failed on ${failures.length}: ${failures.join(', ')}`);
  }
}

function renderApplyRenameButtonState() {
  el.btnApplyRename.disabled = state.renameTemplates.length === 0;
  el.btnApplyRename.title = state.renameTemplates.length === 0
    ? 'Create a rename template first (Manage → + New)'
    : '';
}

function renderRenameSelects() {
  for (const sel of [el.renameSelectModal, el.renameApplySelect]) {
    sel.innerHTML = '';
    for (const template of state.renameTemplates) {
      const opt = document.createElement('option');
      opt.value = template.id;
      opt.textContent = template.name;
      sel.appendChild(opt);
    }
  }
  el.renameSelectModal.value = state.activeRenameTemplateId || '';
  if (renameApplyDraft) el.renameApplySelect.value = renameApplyDraft.templateId || '';
}

function setActiveRenameTemplate(id) {
  state.activeRenameTemplateId = id;
  persistRenameTemplates();
  renderRenameSelects();
  renderRenamePatternField();
  renderRenamePreview();
  renderRenameCustomVarsSection();
}

function renderRenameVarsRow() {
  el.renameVarsRow.innerHTML = '';
  for (const v of RENAME_BUILTIN_VARS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = `{${v.key}}`;
    chip.title = v.label;
    chip.addEventListener('click', () => insertVarIntoRenamePattern(v.key));
    el.renameVarsRow.appendChild(chip);
  }
}

function insertVarIntoRenamePattern(key) {
  const target = el.renamePatternInput;
  const insertion = `{${key}}`;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  target.value = target.value.slice(0, start) + insertion + target.value.slice(end);
  target.selectionStart = target.selectionEnd = start + insertion.length;
  target.dispatchEvent(new Event('input'));
  target.focus();
  persistRenameTemplates();
}

function renderRenamePatternField() {
  const template = activeRenameTemplate();
  el.renamePatternInput.value = template ? (template.pattern || '') : '';
}

function renderRenameCustomVarsSection() {
  const template = activeRenameTemplate();
  const vars = template ? detectRenameFillIns(template.pattern || '') : [];
  el.renameCustomVarsSection.classList.toggle('hidden', vars.length === 0);
  el.renameCustomVars.innerHTML = '';
  for (const v of vars) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `{${v}}`;
    el.renameCustomVars.appendChild(chip);
  }
}

// Sample values used only to preview interpolation inside the editor —
// never written anywhere.
function buildRenamePreviewVars(pattern) {
  const vars = {
    persons: 'Alex Kim, Sam Lee',
    keywords: 'beach, sunset',
    filename: 'IMG_1234',
    ...computeDateVars(new Date().toISOString().slice(0, 10)),
  };
  for (const key of detectRenameFillIns(pattern)) vars[key] = `[${key}]`;
  for (const [, spec] of pattern.matchAll(/\{SEQ:(\d+)\}/gi)) vars[`SEQ:${spec}`] = seqValueForIndex(spec, 1);
  return vars;
}

function renderRenamePreview() {
  const template = activeRenameTemplate();
  const pattern = template?.pattern || '';
  el.renameSeqWarning.classList.toggle('hidden', !pattern.trim() || patternHasSeq(pattern));
  el.renamePreview.innerHTML = '';
  if (!pattern.trim()) {
    el.renamePreview.innerHTML = '<span class="no-tags">No pattern yet.</span>';
    return;
  }
  const vars = buildRenamePreviewVars(pattern);
  const example = buildNewFilename(interpolateTemplate(pattern, vars), 'IMG_1234.jpg');
  const row = document.createElement('div');
  row.className = 'template-preview-row';
  row.textContent = example;
  el.renamePreview.appendChild(row);
}

el.btnManageRename.addEventListener('click', () => {
  if (state.renameTemplates.length === 0) {
    const template = { id: crypto.randomUUID(), name: 'My Rename Pattern', pattern: '{SEQ:001}' };
    state.renameTemplates.push(template);
    state.activeRenameTemplateId = template.id;
    persistRenameTemplates();
    renderApplyRenameButtonState();
  }
  renderRenameSelects();
  renderRenameVarsRow();
  renderRenamePatternField();
  renderRenamePreview();
  renderRenameCustomVarsSection();
  el.renameNameEditSection.classList.add('hidden');
  el.renameModal.classList.remove('hidden');
});
el.btnRenameClose.addEventListener('click', () => el.renameModal.classList.add('hidden'));
el.renameSelectModal.addEventListener('change', () => setActiveRenameTemplate(el.renameSelectModal.value));

el.renamePatternInput.addEventListener('input', () => {
  const template = activeRenameTemplate();
  if (!template) return;
  template.pattern = el.renamePatternInput.value;
  renderRenamePreview();
  renderRenameCustomVarsSection();
});
el.renamePatternInput.addEventListener('change', () => persistRenameTemplates());

let renameNameEditMode = 'new';

function openRenameNameEdit(mode) {
  renameNameEditMode = mode;
  el.renameNameEditInput.value = mode === 'rename' ? (activeRenameTemplate()?.name || '') : '';
  el.renameNameEditSection.classList.remove('hidden');
  el.renameNameEditInput.focus();
  el.renameNameEditInput.select();
}

el.btnRenameNew.addEventListener('click', () => openRenameNameEdit('new'));
el.btnRenameRename.addEventListener('click', () => openRenameNameEdit('rename'));
el.btnRenameNameEditCancel.addEventListener('click', () => el.renameNameEditSection.classList.add('hidden'));

el.btnRenameNameEditSave.addEventListener('click', () => {
  const name = el.renameNameEditInput.value.trim();
  if (!name) return;
  if (renameNameEditMode === 'new') {
    const template = { id: crypto.randomUUID(), name, pattern: '{SEQ:001}' };
    state.renameTemplates.push(template);
    state.activeRenameTemplateId = template.id;
  } else {
    const template = activeRenameTemplate();
    if (template) template.name = name;
  }
  persistRenameTemplates();
  el.renameNameEditSection.classList.add('hidden');
  renderRenameSelects();
  renderRenamePatternField();
  renderRenamePreview();
  renderRenameCustomVarsSection();
  renderApplyRenameButtonState();
});

el.renameNameEditInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); el.btnRenameNameEditSave.click(); }
  else if (e.key === 'Escape') el.renameNameEditSection.classList.add('hidden');
});

el.btnRenameDuplicate.addEventListener('click', () => {
  const template = activeRenameTemplate();
  if (!template) return;
  const copy = { id: crypto.randomUUID(), name: `${template.name} copy`, pattern: template.pattern };
  state.renameTemplates.push(copy);
  state.activeRenameTemplateId = copy.id;
  persistRenameTemplates();
  renderRenameSelects();
  renderRenamePatternField();
  renderRenamePreview();
  renderRenameCustomVarsSection();
});

el.btnRenameDelete.addEventListener('click', () => {
  const template = activeRenameTemplate();
  if (!template) return;
  if (!confirm(`Delete rename template "${template.name}"? This can't be undone.`)) return;
  state.renameTemplates = state.renameTemplates.filter(t => t.id !== template.id);
  state.activeRenameTemplateId = state.renameTemplates[0]?.id || null;
  persistRenameTemplates();
  renderRenameSelects();
  renderRenamePatternField();
  renderRenamePreview();
  renderRenameCustomVarsSection();
  renderApplyRenameButtonState();
});

// --- Apply-Rename flow ---
el.btnApplyRename.addEventListener('click', () => {
  if (state.renameTemplates.length === 0) return;
  if (!renameApplyDraft) {
    renameApplyDraft = {
      templateId: (activeRenameTemplate() || state.renameTemplates[0]).id,
      customVars: {},
    };
  }
  renderRenameSelects();
  renderRenameApplyForm();
  el.renameApplyModal.classList.remove('hidden');
});

el.btnRenameApplyCancel.addEventListener('click', () => el.renameApplyModal.classList.add('hidden'));

el.renameApplySelect.addEventListener('change', () => {
  renameApplyDraft.templateId = el.renameApplySelect.value;
  renderRenameApplyForm();
});

function renderRenameApplyForm() {
  if (!renameApplyDraft) return;
  el.renameApplySelect.value = renameApplyDraft.templateId;

  const template = state.renameTemplates.find(t => t.id === renameApplyDraft.templateId);
  const customKeys = template ? detectRenameFillIns(template.pattern || '') : [];
  el.renameApplyCustomVarsSection.classList.toggle('hidden', customKeys.length === 0);
  el.renameApplyCustomVars.innerHTML = '';
  for (const key of customKeys) {
    const row = document.createElement('div');
    row.className = 'template-apply-row';
    const label = document.createElement('label');
    label.textContent = key;
    label.htmlFor = `rename-apply-var-${slugForId(key)}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `rename-apply-var-${slugForId(key)}`;
    input.value = renameApplyDraft.customVars[key] || '';
    input.addEventListener('input', () => { renameApplyDraft.customVars[key] = input.value; });
    row.appendChild(label);
    row.appendChild(input);
    el.renameApplyCustomVars.appendChild(row);
  }

  const targets = renameTargets();
  el.renameApplyScope.textContent = state.checkedIds.size > 0
    ? `Will rename ${targets.length} checked photo${targets.length === 1 ? '' : 's'}.`
    : `Will rename all ${targets.length} photo${targets.length === 1 ? '' : 's'} in this folder (nothing checked).`;
}

el.btnRenameApplyConfirm.addEventListener('click', async () => {
  const template = state.renameTemplates.find(t => t.id === renameApplyDraft.templateId);
  if (!template) return;
  if (!template.pattern || !template.pattern.trim()) {
    alert('This rename template has no pattern set — add one in Manage first.');
    return;
  }
  if (!patternHasSeq(template.pattern)) {
    alert('This rename template has no {SEQ:...} variable — add one (e.g. {SEQ:001}) in Manage so every photo gets a unique filename.');
    return;
  }
  const fillIns = { ...renameApplyDraft.customVars };
  const targets = renameTargets();
  el.renameApplyModal.classList.add('hidden');
  await renamePhotos(targets, template.pattern, fillIns);
});

// --- Folder loading ---
async function loadFolder(dirHandle) {
  for (const photo of state.photos) URL.revokeObjectURL(photo.url);
  state.photos = [];
  state.selectedPhotoId = null;
  state.checkedIds.clear();
  state.dirHandle = dirHandle;

  const entries = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && IMAGE_EXT_RE.test(entry.name)) entries.push(entry);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const rNames = rosterNameSet();
  for (const fileHandle of entries) {
    const file = await fileHandle.getFile();
    const tags = await readTagsFromFile(file);
    state.photos.push({
      id: crypto.randomUUID(),
      name: file.name,
      fileHandle,
      url: URL.createObjectURL(file),
      isJpeg: isJpegFile(file),
      tags,
      // Which tags count as "from the roster" for PersonInImage syncing
      // (see addTag). We don't track this across sessions, so on load we
      // approximate it by matching existing tags against the active
      // roster's current member names.
      personTags: tags.filter(t => rNames.has(t.toLowerCase())),
      personInImageLocked: false,
    });
  }

  if (state.photos.length > 0) state.selectedPhotoId = state.photos[0].id;
  el.emptyState.classList.toggle('hidden', state.photos.length > 0);
  el.emptyState.textContent = state.photos.length === 0
    ? 'No supported image files (jpg, png, gif, webp, bmp, tiff) were found in that folder.'
    : '';
  el.workspace.classList.toggle('hidden', state.photos.length === 0);
  render();
}

// --- Recent folders ---
const MAX_RECENT_FOLDERS = 8;

async function loadRecentFolders() {
  const list = await kvGet('recentFolders');
  return Array.isArray(list) ? list : [];
}

// Adds (or moves to the front of) the recent-folders list, deduping by
// identity rather than name since two different folders can share a name.
async function addRecentFolder(dirHandle) {
  const existing = await loadRecentFolders();
  const kept = [];
  for (const entry of existing) {
    try {
      if (await entry.handle.isSameEntry(dirHandle)) continue;
    } catch {
      continue; // stale handle from a folder that no longer exists
    }
    kept.push(entry);
  }
  kept.unshift({ id: crypto.randomUUID(), name: dirHandle.name, handle: dirHandle });
  const trimmed = kept.slice(0, MAX_RECENT_FOLDERS);
  await kvSet('recentFolders', trimmed);
  return trimmed;
}

async function renderRecentFoldersSelect() {
  const list = await loadRecentFolders();
  el.recentFoldersSelect.innerHTML = '<option value="">Reopen recent…</option>';
  for (const entry of list) {
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = entry.name;
    el.recentFoldersSelect.appendChild(opt);
  }
  el.recentFoldersSelect.classList.toggle('hidden', list.length === 0);
}

async function reopenRecentFolder(id) {
  const list = await loadRecentFolders();
  const entry = list.find(e => e.id === id);
  if (!entry) return;
  try {
    let permission = await entry.handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') permission = await entry.handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') { alert('Permission to the folder was not granted.'); return; }
    await loadFolder(entry.handle);
    await addRecentFolder(entry.handle);
    await renderRecentFoldersSelect();
  } catch (err) {
    console.error(err);
    alert(`Could not reopen that folder: ${err.message}`);
  }
}

async function pickFolder() {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await addRecentFolder(dirHandle);
    await renderRecentFoldersSelect();
    await loadFolder(dirHandle);
  } catch (err) {
    if (err.name === 'AbortError') return; // user cancelled the picker, not an error
    console.error(err);
    alert(`Could not open that folder: ${err.name || 'Error'} — ${err.message}`);
  }
}

el.btnPickFolder.addEventListener('click', pickFolder);
el.recentFoldersSelect.addEventListener('change', () => {
  const id = el.recentFoldersSelect.value;
  el.recentFoldersSelect.value = '';
  if (id) reopenRecentFolder(id);
});

// --- Init ---
async function init() {
  if (!window.showDirectoryPicker) {
    el.unsupported.classList.remove('hidden');
    return;
  }
  el.app.classList.remove('hidden');

  const savedSettings = await kvGet('settings');
  if (savedSettings && typeof savedSettings === 'object') {
    state.settings = {
      photographer: savedSettings.photographer || '',
      orgName: savedSettings.orgName || '',
      darkMode: !!savedSettings.darkMode,
    };
  }
  applyTheme();

  const savedRosters = await kvGet('rosters');
  if (Array.isArray(savedRosters) && savedRosters.length > 0) {
    state.rosters = savedRosters;
  } else {
    // Migrate the old single-roster format (a flat member array under the
    // 'roster' key) into a default roster the first time this runs.
    const legacyMembers = await kvGet('roster');
    state.rosters = [{
      id: crypto.randomUUID(),
      name: 'My Roster',
      members: Array.isArray(legacyMembers) ? legacyMembers : [],
    }];
  }
  const savedActiveId = await kvGet('activeRosterId');
  state.activeRosterId = state.rosters.some(r => r.id === savedActiveId)
    ? savedActiveId
    : state.rosters[0].id;
  await persistRosters();

  const savedTemplates = await kvGet('metadataTemplates');
  state.metadataTemplates = Array.isArray(savedTemplates) ? savedTemplates : [];
  const savedActiveTemplateId = await kvGet('activeTemplateId');
  state.activeTemplateId = state.metadataTemplates.some(t => t.id === savedActiveTemplateId)
    ? savedActiveTemplateId
    : (state.metadataTemplates[0]?.id || null);

  const savedRenameTemplates = await kvGet('renameTemplates');
  state.renameTemplates = Array.isArray(savedRenameTemplates) ? savedRenameTemplates : [];
  const savedActiveRenameTemplateId = await kvGet('activeRenameTemplateId');
  state.activeRenameTemplateId = state.renameTemplates.some(t => t.id === savedActiveRenameTemplateId)
    ? savedActiveRenameTemplateId
    : (state.renameTemplates[0]?.id || null);

  // Migrate the old single-folder format (a lone handle under the
  // 'dirHandle' key) into the recent-folders list the first time this runs.
  if (!Array.isArray(await kvGet('recentFolders'))) {
    const legacyHandle = await kvGet('dirHandle');
    if (legacyHandle) await addRecentFolder(legacyHandle);
  }
  await renderRecentFoldersSelect();

  renderRosterSelects();
  renderTemplateSelects();
  renderApplyTemplateButtonState();
  renderRenameSelects();
  renderApplyRenameButtonState();
  render();
}

init();
