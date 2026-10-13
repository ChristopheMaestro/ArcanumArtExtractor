// The sidebar folder tree, shared by every explorer category (ART, MOB, SEC,
// PRO, DLG, MES). It is built once when the explorer opens and then kept: the
// explorer only tells it which folder is current (`select`), so the user's
// expanded folders survive navigation.
//
//   - clicking a folder opens it in the main pane and expands/collapses it
//   - files of the category's extension are listed under their folder and open
//     through `openFile` (when given)
//   - the current folder is highlighted and its ancestors are expanded

import { joinPath, manifestFiles, manifestSubfolders } from '../core/manifest.js';
import { treeEl } from '../core/dom.js';
import { log } from '../core/log.js';
import { errText } from '../core/text-io.js';
import { registerSearchProvider } from './file-search.js';

// A folder can hold thousands of files; the main pane pages/filters those.
const MAX_FILE_LEAVES = 500;

export function mountFolderTree({
  rootName, loadManifest, openFolder, ext, fileIcon = '📄',
  openFile = null, fileFilter = null, folderFilter = null, searchFields = null,
  searchLines = null, openLine = null, lineLinks = null, searchCards = null,
}) {
  let nodes = new Map();        // path -> node
  let root = null;
  let currentPath = null;
  let clickedPath = null;       // path of a row the user just clicked (see select)

  const setActive = path => {
    treeEl.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
    nodes.get(path)?.row.classList.add('active');
  };

  function createNode(name, path, depth) {
    const li = document.createElement('li');
    li.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.relpath = path;
    row.style.paddingLeft = `${10 + depth * 16}px`;
    row.innerHTML = '<span class="tree-toggle">▶</span><span class="tree-icon">📁</span><span class="tree-name"></span>';
    row.querySelector('.tree-name').textContent = name;
    li.appendChild(row);
    const children = document.createElement('ul');
    children.className = 'tree-children';
    li.appendChild(children);
    const node = { name, path, depth, li, row, children, kids: [], loaded: null, expanded: false };
    nodes.set(path, node);
    // Keyboard roll / unroll (keyboard-nav.js): expand or collapse without opening the folder.
    row.addEventListener('tree-expand', () => { if (!node.expanded) expand(node); });
    row.addEventListener('tree-collapse', () => { if (node.expanded) collapse(node); });
    row.addEventListener('click', () => {
      clickedPath = path;
      currentPath = path;
      setActive(path);
      toggle(node);
      Promise.resolve(openFolder(path, name)).catch(err => log(`explorer: ${errText(err)}`, 'err'));
      clickedPath = null;
    });
    return node;
  }

  async function fill(node, manifest) {
    node.children.innerHTML = '';
    node.kids = [];
    for (const sf of manifestSubfolders(manifest)) {
      const fullPath = joinPath(node.path, sf.relative_path);
      if (folderFilter) {
        let keep = false;
        try { keep = await folderFilter(fullPath, sf.folder_name); } catch (_) { keep = false; }
        if (!keep) continue;
      }
      const kid = createNode(sf.folder_name, fullPath, node.depth + 1);
      node.kids.push(kid);
      node.children.appendChild(kid.li);
    }
    if (!openFile) return;
    const files = manifestFiles(manifest, ext);
    let shown = 0;
    for (const filename of files) {
      if (shown >= MAX_FILE_LEAVES) break;
      if (fileFilter) {
        let visible = true;
        try { visible = await fileFilter(filename, node.path); } catch (_) { visible = false; }
        if (!visible) continue;
      }
      const li = document.createElement('li');
      li.className = 'tree-node tree-file-node';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mob-file-row';
      row.style.paddingLeft = `${10 + (node.depth + 1) * 16}px`;
      row.innerHTML = `<span class="tree-icon">${fileIcon}</span><span class="tree-name"></span>`;
      row.querySelector('.tree-name').textContent = filename;
      row.addEventListener('click', () => openFile(filename, row, node.path));
      li.appendChild(row);
      node.children.appendChild(li);
      shown++;
    }
    if (files.length > shown && shown >= MAX_FILE_LEAVES) {
      const more = document.createElement('li');
      more.className = 'tree-node tree-file-node';
      more.innerHTML = '<span class="mob-file-row" style="opacity:.6;cursor:default"></span>';
      more.firstChild.textContent = `… ${files.length - shown} more files in this folder`;
      more.firstChild.style.paddingLeft = `${10 + (node.depth + 1) * 16}px`;
      node.children.appendChild(more);
    }
  }

  function ensureLoaded(node) {
    if (!node.loaded) {
      node.row.classList.add('loading');
      node.loaded = loadManifest(node.path, node.name)
        .then(manifest => fill(node, manifest))
        .catch(err => { node.loaded = null; throw err; })
        .finally(() => node.row.classList.remove('loading'));
    }
    return node.loaded;
  }

  async function expand(node) {
    try { await ensureLoaded(node); }
    catch (err) { log(`explorer: ${errText(err)}`, 'err'); return; }
    node.children.classList.add('open');
    node.row.querySelector('.tree-toggle').textContent = '▼';
    node.expanded = true;
  }

  function collapse(node) {
    node.children.classList.remove('open');
    node.row.querySelector('.tree-toggle').textContent = '▶';
    node.expanded = false;
  }

  const toggle = node => (node.expanded ? collapse(node) : expand(node));

  // Expand every ancestor of `path` (and the folder itself) so it is visible.
  async function reveal(path) {
    let node = root;
    while (node.path !== path) {
      await expand(node);
      let next = null;
      for (const kid of node.kids) {
        if ((path === kid.path || path.startsWith(`${kid.path}/`)) && (!next || kid.path.length > next.path.length)) next = kid;
      }
      if (!next) return;
      node = next;
    }
    await expand(node);
  }

  function build() {
    nodes = new Map();
    treeEl.innerHTML = '';
    const rootUl = document.createElement('ul');
    rootUl.className = 'tree-root';
    root = createNode(rootName, '', 0);
    rootUl.appendChild(root.li);
    treeEl.appendChild(rootUl);
  }

  build();
  expand(root);

  // The folder being browsed (a search is made from there, and clearing it comes back there).
  const where = () => ({ path: currentPath || '', name: nodes.get(currentPath || '')?.name || rootName });

  // The right side bar's search looks through this tree's manifests (see file-search.js).
  registerSearchProvider(openFile ? {
    rootName, loadManifest, ext, fileIcon, openFile, fields: searchFields, lines: searchLines, openLine, lineLinks, cards: searchCards,
    where,
    restore: () => { const { path, name } = where(); return openFolder(path, name); },
  } : null);

  return {
    // Mark `path` as the current folder. Explorers call this whenever they open
    // a folder; a click on the tree itself has already done the work.
    async select(path) {
      path = path || '';
      currentPath = path;
      if (path === clickedPath) return;
      await reveal(path);
      if (currentPath === path) setActive(path);
    },
    // Rebuild from the manifests (e.g. after the file filter changed), keeping
    // the current folder open.
    async refresh() {
      const path = currentPath || '';
      build();
      await expand(root);
      await this.select(path);
    },
  };
}
