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
};

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

// --- DOM refs ---
const $ = sel => document.querySelector(sel);
const el = {
  app: $('#app'),
  unsupported: $('#unsupported'),
  emptyState: $('#empty-state'),
  workspace: $('#workspace'),
  taggedCount: $('#tagged-count'),
  btnPickFolder: $('#btn-pick-folder'),
  recentFoldersSelect: $('#recent-folders-select'),
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
  rosterNameEditSection: $('#roster-name-edit-section'),
  rosterNameEditInput: $('#roster-name-edit-input'),
  btnRosterNameEditSave: $('#btn-roster-name-edit-save'),
  btnRosterNameEditCancel: $('#btn-roster-name-edit-cancel'),
  rosterNameInput: $('#roster-name-input'),
  rosterNumberInput: $('#roster-number-input'),
  btnRosterAdd: $('#btn-roster-add'),
  rosterList: $('#roster-list'),
  btnRosterClose: $('#btn-roster-close'),
  btnToggleCsvImport: $('#btn-toggle-csv-import'),
  csvImportSection: $('#csv-import-section'),
  csvImportText: $('#csv-import-text'),
  btnCsvImport: $('#btn-csv-import'),
  csvImportStatus: $('#csv-import-status'),
  lightbox: $('#lightbox'),
  lightboxImg: $('#lightbox-img'),
  btnLightboxClose: $('#btn-lightbox-close'),
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
    btn.className = 'chip';
    btn.textContent = (member.number ? `#${member.number} ` : '') + member.name;
    btn.disabled = !photo || taggedSet.has(member.name.toLowerCase());
    btn.addEventListener('click', () => addTag(member.name));
    el.rosterButtons.appendChild(btn);
  }

  const rNames = rosterNameSet();
  const extra = suggestedNames().filter(n => !rNames.has(n.toLowerCase()));
  el.extraNamesSection.classList.toggle('hidden', extra.length === 0);
  el.extraNameButtons.innerHTML = '';
  for (const name of extra) {
    const btn = document.createElement('button');
    btn.className = 'chip extra';
    btn.textContent = name;
    btn.disabled = !photo || taggedSet.has(name.toLowerCase());
    btn.addEventListener('click', () => addTag(name));
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
async function addTag(name) {
  name = name.trim();
  if (!name) return;
  const targets = state.checkedIds.size > 0 ? [...state.checkedIds] : [state.selectedPhotoId];
  const writes = [];
  for (const id of targets) {
    const photo = state.photos.find(p => p.id === id);
    if (!photo) continue;
    if (photo.tags.some(t => t.toLowerCase() === name.toLowerCase())) continue;
    photo.tags.push(name);
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
  addTag(name);
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
el.lightbox.addEventListener('click', e => { if (e.target === el.lightbox) el.lightbox.classList.add('hidden'); });

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

el.btnManageRoster.addEventListener('click', () => {
  renderRosterSelects();
  renderRosterModalList();
  el.rosterNameEditSection.classList.add('hidden');
  el.csvImportSection.classList.add('hidden');
  el.csvImportText.value = '';
  el.csvImportStatus.textContent = '';
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

el.btnToggleCsvImport.addEventListener('click', () => {
  el.csvImportSection.classList.toggle('hidden');
  if (!el.csvImportSection.classList.contains('hidden')) el.csvImportText.focus();
});

el.btnCsvImport.addEventListener('click', () => {
  const roster = activeRoster();
  if (!roster) return;
  const rows = parseRosterCsv(el.csvImportText.value);
  if (!rows.length) {
    el.csvImportStatus.textContent = 'No rows found.';
    return;
  }
  const seen = rosterNameSet();
  let added = 0, skipped = 0;
  for (const { name, number } of rows) {
    const key = name.toLowerCase();
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    roster.members.push({ id: crypto.randomUUID(), name, number });
    added++;
  }
  persistRosters();
  renderRosterModalList();
  renderRosterPanel();
  el.csvImportText.value = '';
  el.csvImportStatus.textContent =
    `Added ${added}${skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}.`;
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

  // Migrate the old single-folder format (a lone handle under the
  // 'dirHandle' key) into the recent-folders list the first time this runs.
  if (!Array.isArray(await kvGet('recentFolders'))) {
    const legacyHandle = await kvGet('dirHandle');
    if (legacyHandle) await addRecentFolder(legacyHandle);
  }
  await renderRecentFoldersSelect();

  renderRosterSelects();
  render();
}

init();
