// .MES text-table explorer.

import { MES_FIELDS, cachedLines } from '../explorer/file-search.js';
import { mountFolderTree } from '../explorer/folder-tree.js';
import { createManifestLoader, joinPath, manifestFiles, manifestSubfolders } from '../core/manifest.js';

import { backButton } from '../explorer/nav-history.js';

import { DATA_ROOT } from '../core/config.js';

import { fetchText, errText } from '../core/text-io.js';

import { breadcrumbEl, gridEl, paginationEl, viewerEl } from '../core/dom.js';
import { encPath, escapeHtml } from '../core/util.js';

import { beginDataExplorer, renderDataFolderGrid, showExplorerError } from '../explorer/data-explorer.js';

import { saveDataExplorerState } from '../explorer/state-store.js';

// MES files are distributed throughout the entire data tree, not under one
// dedicated /data/mes/ directory. The root data_manifest.json is therefore
// the starting point; every descendant manifest is recursively inspected,
// and only branches containing at least one .mes file are exposed.
const MES_ROOT = DATA_ROOT;
const MES_DATA_MANIFEST_URL = `${DATA_ROOT}data_manifest.json`;
const mesFolderContentCache = new Map();
let mesCurrentPath = '';
let mesCurrentFolderName = 'data';
let mesCurrentManifest = null;
let mesFiles = [];
let mesOpenData = null;
let mesSearchQuery = '';
let mesShowComments = true;

let mesTree = null;
const loadMesManifest = createManifestLoader({ root: DATA_ROOT, rootName: 'data', label: 'data' });
const mesSubfolders = manifest => manifestSubfolders(manifest).filter(sf => sf.relative_path);

async function mesFolderHasContent(relativePath, folderName) {
  const key = `${relativePath}|${folderName}`;
  if (mesFolderContentCache.has(key)) return mesFolderContentCache.get(key);
  const promise = (async () => {
    try {
      const manifest = await loadMesManifest(relativePath, folderName);
      if (manifestFiles(manifest, 'mes').length) return true;
      // sub-folders all at once: online each manifest is a round trip
      const found = await Promise.all(mesSubfolders(manifest).map(sf => mesFolderHasContent(joinPath(relativePath, sf.relative_path), sf.folder_name)));
      if (found.some(Boolean)) return true;
    } catch (_) {}
    return false;
  })();
  mesFolderContentCache.set(key, promise);
  return promise;
}
async function mesVisibleSubfolders(manifest, relativePath) {
  const subs = mesSubfolders(manifest);
  const keep = await Promise.all(subs.map(sf => mesFolderHasContent(joinPath(relativePath, sf.relative_path), sf.folder_name)));
  return subs.filter((_, i) => keep[i]);
}
function mesFileUrl(relativePath, filename) {
  return `${MES_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}${encPath(filename)}`;
}
const fetchMesText = (relativePath, filename) => fetchText(mesFileUrl(relativePath, filename));
// Search results, one per entry (file-search.js).
const mesSearchLines = (relativePath, filename) => cachedLines(mesFileUrl(relativePath, filename), text =>
  mesParseText(text).entries.map(e => ({ num: e.key, tag: '', text: e.value })));

function mesParseText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const entries = [];
  const comments = [];
  let pendingComments = [];
  let field = null;
  let fields = [];
  let fieldStartLine = 0;
  let braceDepth = 0;
  const flushComment = (lineNo, raw) => {
    const value = raw.replace(/^\s*\/\/\s?/, '').trim();
    if (value) pendingComments.push({ line: lineNo, text: value });
  };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li], lineNo = li + 1, trimmed = line.trim();
    if (field === null && fields.length === 0 && /^\/\//.test(trimmed)) { flushComment(lineNo, line); continue; }
    if (field === null && fields.length === 0 && !trimmed) continue;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '{' && field === null) {
        field = ''; braceDepth = 1; fieldStartLine ||= lineNo; continue;
      }
      if (ch === '}' && field !== null) {
        fields.push(field); field = null; braceDepth = 0; continue;
      }
      if (field !== null) field += ch;
    }
    if (field === null && fields.length >= 2) {
      const rawKey = fields[0].trim();
      if (/^[-+]?\d+$/.test(rawKey)) {
        entries.push({ key: Number(rawKey), value: fields[1], line: fieldStartLine || lineNo, comments: pendingComments });
        pendingComments = [];
      }
      fields = []; fieldStartLine = 0;
    }
  }
  return { entries, trailingComments: pendingComments };
}

function mesMatches(entry, query) {
  if (!query) return true;
  const q=query.toLowerCase();
  return String(entry.key).includes(q) || String(entry.value).toLowerCase().includes(q) || entry.comments.some(c=>c.text.toLowerCase().includes(q));
}
function mesRenderViewer(filename, relativePath, parsed) {
  const wrap=mesCreateEl('article','mes-viewer');
  const bar=mesCreateEl('div','mes-viewer-head');
  bar.appendChild(backButton());
  const title=mesCreateEl('div','mes-file-title'); title.appendChild(mesCreateEl('strong',null,filename)); title.appendChild(mesCreateEl('span',null,`/${relativePath || 'data'}`)); bar.appendChild(title);
  const controls=mesCreateEl('div','mes-controls');
  const search=document.createElement('input'); search.type='search'; search.className='mes-search'; search.placeholder='Search key, text, or comment…'; search.value=mesSearchQuery;
  search.addEventListener('input',()=>{mesSearchQuery=search.value; mesRenderTable(table,parsed);}); controls.appendChild(search);
  const commentsToggle=document.createElement('button'); commentsToggle.type='button'; commentsToggle.className='mes-control active'; commentsToggle.textContent='Comments: on'; commentsToggle.addEventListener('click',()=>{mesShowComments=!mesShowComments;commentsToggle.classList.toggle('active',mesShowComments);commentsToggle.textContent=mesShowComments?'Comments: on':'Comments: off';mesRenderTable(table,parsed);}); controls.appendChild(commentsToggle);
  bar.appendChild(controls); wrap.appendChild(bar);
  const summary=mesCreateEl('div','mes-summary'); summary.innerHTML=`<span><b>${parsed.entries.length}</b> entries</span><span><b>${parsed.entries.reduce((n,e)=>n+e.comments.length,0)}</b> comments</span><span>Numeric key → text table</span>`; wrap.appendChild(summary);
  const tableWrap=mesCreateEl('div','mes-table-wrap'); const table=document.createElement('div'); table.className='mes-table'; mesRenderTable(table,parsed); tableWrap.appendChild(table); wrap.appendChild(tableWrap);
  if(parsed.trailingComments.length){ const tail=mesCreateEl('div','mes-trailing-comments'); tail.appendChild(mesCreateEl('strong',null,'Comments at end of file')); parsed.trailingComments.forEach(c=>tail.appendChild(mesCreateEl('div',null,`Line ${c.line}: ${c.text}`))); wrap.appendChild(tail); }
  return wrap;
}
function mesCreateEl(tag,cls,text){ const el=document.createElement(tag); if(cls)el.className=cls; if(text!==undefined)el.textContent=text; return el; }
function mesRenderTable(table,parsed){
  table.innerHTML='';
  const entries=parsed.entries.filter(e=>mesMatches(e,mesSearchQuery));
  const head=document.createElement('div'); head.className='mes-row mes-head'; ['Line','Key','Text / value'].forEach(x=>head.appendChild(mesCreateEl('div',null,x))); table.appendChild(head);
  if(!entries.length){table.appendChild(mesCreateEl('div','mes-empty','No entries match this search.'));return;}
  for(const e of entries){
    if(mesShowComments && e.comments.length){ const c=mesCreateEl('div','mes-comment-block'); c.appendChild(mesCreateEl('span','mes-comment-marker','//')); const lines=mesCreateEl('div','mes-comment-lines'); e.comments.forEach(x=>mesCommentLinesAppend(lines,x)); c.appendChild(lines); table.appendChild(c); }
    const row=mesCreateEl('div','mes-row'); row.dataset.key=String(e.key); row.appendChild(mesCreateEl('div','mes-line',String(e.line))); row.appendChild(mesCreateEl('div','mes-key',String(e.key))); row.appendChild(mesCreateEl('div','mes-value',e.value)); table.appendChild(row);
  }
}
function mesCommentLinesAppend(parent,c){ const d=mesCreateEl('div',null,c.text); d.dataset.line=c.line; parent.appendChild(d); }
// focusKey: the entry a search result pointed at, scrolled to and highlighted.
function mesOpenViewer(filename, relativePath, focusKey=null){
  fetchMesText(relativePath,filename).then(text=>{
    mesOpenData=mesParseText(text); mesSearchQuery=''; saveDataExplorerState('mes',relativePath,mesCurrentFolderName,filename);
    gridEl.hidden=true; paginationEl.hidden=true; viewerEl.hidden=false; viewerEl.classList.add('revealed'); viewerEl.innerHTML=''; viewerEl.appendChild(mesRenderViewer(filename,relativePath,mesOpenData));
    const row=focusKey===null?null:viewerEl.querySelector(`.mes-row[data-key="${focusKey}"]`);
    if(row){ row.classList.add('is-focus'); row.scrollIntoView({behavior:'smooth',block:'center'}); }
    else viewerEl.scrollIntoView({behavior:'smooth',block:'start'});
  }).catch(err=>{viewerEl.hidden=false;viewerEl.classList.add('revealed');viewerEl.innerHTML=`<div class="mes-error">Couldn't read ${escapeHtml(filename)}: ${escapeHtml(errText(err))}</div>`;});
}
async function openMesFolder(relativePath,folderName){
  if(mesTree) mesTree.select(relativePath);
  mesCurrentPath=relativePath; mesCurrentFolderName=folderName; mesCurrentManifest=await loadMesManifest(relativePath,folderName); mesFiles=manifestFiles(mesCurrentManifest, 'mes'); saveDataExplorerState('mes',relativePath,folderName,null);
  breadcrumbEl.textContent=`/data/${relativePath?relativePath+'/':''}`; gridEl.hidden=false; viewerEl.hidden=true; viewerEl.classList.remove('revealed'); viewerEl.innerHTML='';
  const visibleFolders=await mesVisibleSubfolders(mesCurrentManifest,relativePath);
  renderDataFolderGrid({subfolders:visibleFolders,files:mesFiles,relativePath,openFolderFn:openMesFolder,openFileFn:(fn,card,_fullPath)=>mesOpenViewer(fn,relativePath),fileIcon:'📜'});
}

export async function enterMesExplorer(restoreState = false) {
  const { path, name, file } = beginDataExplorer('mes', { rootName: 'data', restoreState });
  mesTree = mountFolderTree({
    rootName: 'data', loadManifest: loadMesManifest, openFolder: openMesFolder, folderFilter: mesFolderHasContent,
    ext: 'mes', fileIcon: '📜', searchFields: MES_FIELDS, openFile: (filename, _row, parent) => mesOpenViewer(filename, parent),
    searchLines: mesSearchLines, openLine: (filename, parent, key) => mesOpenViewer(filename, parent, key),
  });
  try {
    await openMesFolder(path, name);
    if (file && mesFiles.includes(file)) mesOpenViewer(file, path);
  } catch (err) { showExplorerError(err); }
}
