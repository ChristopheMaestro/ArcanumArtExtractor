// .DLG dialogue explorer.

import { DLG_FIELDS, cachedLines } from '../explorer/file-search.js';
import { mountFolderTree } from '../explorer/folder-tree.js';
import { manifestFiles, manifestSubfolders } from '../core/manifest.js';
import { createIndexLoader } from '../core/file-index.js';

import { backButton } from '../explorer/nav-history.js';

import { DATA_ROOT } from '../core/config.js';

import { fetchText, errText } from '../core/text-io.js';

import { breadcrumbEl, gridEl, paginationEl, viewerEl } from '../core/dom.js';

import { encPath, escapeHtml, createEl as dlgCreateEl } from '../core/util.js';

import { beginDataExplorer, renderDataFolderGrid, showExplorerError } from '../explorer/data-explorer.js';

import { saveDataExplorerState } from '../explorer/state-store.js';

import { loadDynamicTables, resolveDynamic } from './dlg-dynamic.js';

import { explainActions, explainConditions, loadCodeTables } from './dlg-codes.js';

import { dlgTriggers, openTrigger, triggerLabel } from '../scr/scr-dlg-triggers.js';

// Listed from data/ (dlg, the mods, the modules): the paths are under data/ (toolbox/file_index.py)
let dlgCurrentPath = '';
let dlgCurrentFolderName = 'data';
let dlgCurrentManifest = null;
let dlgFiles = [];
let dlgOpenData = null;
let dlgCurrentNode = 1;
let dlgHistory = [];
let dlgFemaleMode = false;
let dlgShowInternals = false;
let dlgFocusNum = null; // the line a search result pointed at, highlighted in the stage
let dlgTriggerMap = null; // dialogue line -> script lines that show it (scr-dlg-triggers.js)

let dlgTree = null;
const loadDlgManifest = createIndexLoader('dlg');

function dlgFileUrl(relativePath, filename) {
  return `${DATA_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}${encPath(filename)}`;
}
const fetchDlgText = (relativePath, filename) => fetchText(dlgFileUrl(relativePath, filename));
// Search results, one per dialogue line (file-search.js): NPC lines carry their female text too.
const dlgSearchLines = (relativePath, filename) => cachedLines(dlgFileUrl(relativePath, filename), text =>
  dlgParseFields(text).map(e => ({ num: e.num, tag: e.iq ? 'PC' : 'NPC', text: e.text, alt: e.iq ? '' : e.gender })));
// Port of dialog_parse_field()/dialog_parse_entry() (game/dialog.c). Anything
// outside the braces is skipped (whitespace between fields is common, e.g.
// "{1}{text} {female text}{}{}{}{}"), and "//" comments outside braces run to
// the end of the line. An incomplete trailing entry ends the file, as in the
// engine, instead of failing the whole load.
export function dlgParseFields(text) {
  const out = [];
  const len = text.length;
  let i = 0, line = 1;
  // Next brace-delimited field, or null at end of file.
  const readField = () => {
    let prev = '';
    while (true) {
      if (i >= len) return null;
      const ch = text[i++];
      if (ch === '{') break;
      if (ch === '\n') { line++; continue; }
      if (ch === '/' && prev === '/') {
        while (i < len && text[i] !== '\n') i++;
        if (i >= len) return null;
        i++; line++; prev = '';
        continue;
      }
      if (ch !== '}') prev = ch;
    }
    let value = '';
    while (true) {
      if (i >= len) return null;
      const ch = text[i++];
      if (ch === '}') break;
      if (ch === '\n') line++;
      value += ch;
    }
    return value;
  };
  while (true) {
    const startLine = line, fields = [];
    for (let f = 0; f < 7; f++) {
      const v = readField();
      if (v === null) return finish(out);
      fields.push(v);
    }
    out.push({ line: startLine, num: Number.parseInt(fields[0], 10), text: fields[1], gender: fields[2], iq: Number.parseInt(fields[3], 10) || 0, conditions: fields[4], response: Number.parseInt(fields[5], 10) || 0, actions: fields[6] });
  }
}
function finish(out) {
  return out.filter(e => Number.isFinite(e.num)).sort((a, b) => a.num - b.num);
}
// The text a line shows: as written, or for a dynamic "x:" line what the engine replaces it
// with, plus a small caption saying which code it is and what it does (dlg-dynamic.js).
function dlgSpeechEl(cls, rawText, npc) {
  const wrap = dlgCreateEl('span', cls);
  const dyn = resolveDynamic(rawText, { npc, femalePc: dlgFemaleMode });
  if (!dyn) { wrap.textContent = rawText || ''; return wrap; }
  wrap.classList.add('is-dynamic');
  wrap.appendChild(dlgCreateEl('span', 'dlg-dynamic-text', dyn.text));
  const note = dlgCreateEl('span', 'dlg-dynamic-note', dyn.caption);
  wrap.appendChild(note);
  const others = dyn.variants.length > 1 ? `\n\nOther wordings (${dyn.source}):\n${dyn.variants.slice(1, 13).map(v => `• ${v}`).join('\n')}${dyn.variants.length > 13 ? '\n…' : ''}` : '';
  wrap.title = `Written in the .dlg as "${String(rawText).trim()}"${dyn.source ? `; the game picks a line from ${dyn.source}` : ''}${others}`;
  return wrap;
}
// Tests / effects one per line: the code as written, then what it means (dlg-codes.js).
function dlgExplainEl(groups) {
  const box = dlgCreateEl('span', 'dlg-explain');
  for (const [title, items] of groups) {
    if (!items.length) continue;
    box.appendChild(dlgCreateEl('span', 'dlg-explain-head', title));
    for (const it of items) {
      const row = dlgCreateEl('span', 'dlg-explain-row');
      row.append(dlgCreateEl('code', 'dlg-explain-code', it.raw), dlgCreateEl('span', 'dlg-explain-text', it.text));
      box.appendChild(row);
    }
  }
  return box;
}
// "Triggered by <script line>" links for a dialogue line, or null (scr-dlg-triggers.js).
// Spans rather than <a>: they also sit inside the option buttons.
function dlgTriggerEl(num) {
  const list = dlgTriggerMap?.get(num);
  if (!list?.length) return null;
  const box = dlgCreateEl('span', 'dlg-trigger');
  box.append('📜 Triggered by ');
  list.forEach((t, i) => {
    if (i) box.append(', ');
    const a = dlgCreateEl('span', 'dlg-trigger-link', triggerLabel(t));
    a.tabIndex = 0; a.setAttribute('role', 'link'); a.title = `Open ${t.scr} at line ${t.line}`;
    const go = ev => { ev.preventDefault(); ev.stopPropagation(); openTrigger(t); };
    a.addEventListener('click', go);
    a.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') go(ev); });
    box.appendChild(a);
  });
  return box;
}
const dlgPlainText = (rawText, npc) => resolveDynamic(rawText, { npc, femalePc: dlgFemaleMode })?.text ?? rawText;
function dlgBuildNodes(entries) {
  const byNum = new Map(entries.map(e => [e.num,e]));
  const nodes = new Map();
  for (let i=0;i<entries.length;i++) {
    const e=entries[i];
    if (e.iq !== 0) continue;
    const options=[];
    for (let j=i+1;j<entries.length;j++) {
      const o=entries[j];
      if (o.iq===0) break;
      options.push({...o});
    }
    nodes.set(e.num,{...e, femaleText:e.gender, options});
  }
  return { byNum, nodes };
}
function dlgDisplayNpcText(node) {
  return dlgFemaleMode && node.femaleText && node.femaleText.trim() ? node.femaleText : node.text;
}
function dlgTargetText(option) {
  if (option.response > 0) return `→ ${option.response}`;
  // sub_417590(): a negative response ends the dialog and runs the NPC's script
  // at line -N (dialog_ui_execute_script()).
  if (option.response < 0) return `Ends dialog, runs NPC script line ${-option.response}`;
  return 'Ends conversation';
}
function dlgRenderGameStage(stage, data) {
  stage.innerHTML='';
  const node=data.nodes.get(dlgCurrentNode);
  const title=dlgCreateEl('div','dlg-stage-title',`Line ${dlgCurrentNode}`); stage.appendChild(title);
  if(!node){
    const end=dlgCreateEl('div','dlg-terminal','No NPC speech node exists at this line.'); stage.appendChild(end); return;
  }
  const npc=dlgCreateEl('div','dlg-npc-bubble');
  if(node.num===dlgFocusNum) npc.classList.add('is-focus');
  npc.appendChild(dlgCreateEl('div','dlg-speaker','NPC'));
  const speech=dlgCreateEl('div','dlg-speech'); speech.appendChild(dlgSpeechEl('dlg-speech-text',dlgDisplayNpcText(node) || '',true)); npc.appendChild(speech);
  const trig=dlgTriggerEl(node.num); if(trig) npc.appendChild(trig);
  if(dlgShowInternals){
    // On an NPC line the test field is not a test: sub_416840() reads it as the voice-over number.
    if(node.conditions && node.conditions.trim()) npc.appendChild(dlgCreateEl('div','dlg-internal',`Voice-over: speech file ${Number.parseInt(node.conditions,10)||0}`));
    if(node.actions && node.actions.trim()) npc.appendChild(dlgExplainEl([['When this line is spoken', explainActions(node.actions)]]));
  }
  stage.appendChild(npc);
  const optionsWrap=dlgCreateEl('div','dlg-options');
  if(!node.options.length){ stage.appendChild(dlgCreateEl('div','dlg-terminal', /^e:\s*$/i.test(node.text)?'Dialogue end marker (E:)':'No following player options.')); return; }
  node.options.forEach((o,index)=>{
    const btn=document.createElement('button'); btn.type='button'; btn.className='dlg-option'; btn.dataset.num=String(o.num);
    if(o.num===dlgFocusNum) btn.classList.add('is-focus');
    btn.appendChild(dlgCreateEl('span','dlg-option-index',String(index+1)));
    btn.appendChild(dlgSpeechEl('dlg-option-text',o.text,false));
    const hasCond=!!(o.conditions && o.conditions.trim()), hasAct=!!(o.actions && o.actions.trim());
    if(dlgShowInternals){
      btn.appendChild(dlgCreateEl('span','dlg-option-meta',dlgTargetText(o)));
      const groups=[];
      if(hasCond) groups.push(['Requires (all of)', explainConditions(o.conditions)]);
      if(hasAct) groups.push(['Effects when chosen', explainActions(o.actions)]);
      if(groups.length){ const ex=dlgExplainEl(groups); ex.classList.add('dlg-option-meta'); btn.appendChild(ex); }
    } else {
      const meta=[];
      if(hasCond) meta.push(`Requires conditions (${o.conditions.trim()})`);
      meta.push(dlgTargetText(o));
      if(!hasCond && hasAct) meta.push(`Effects: ${o.actions.trim()}`);
      btn.appendChild(dlgCreateEl('span','dlg-option-meta',meta.join('  ·  ')));
    }
    const trig=dlgTriggerEl(o.num); if(trig){ trig.classList.add('dlg-option-meta'); btn.appendChild(trig); }
    btn.addEventListener('click',()=>{
      dlgHistory.push(dlgCurrentNode);
      if(o.response>0 && data.nodes.has(o.response)){ dlgCurrentNode=o.response; dlgRenderGameStage(stage,data); dlgRenderFlowMap(data); }
      else { dlgRenderTerminal(stage,o); }
    });
    optionsWrap.appendChild(btn);
  });
  stage.appendChild(optionsWrap);
  const nav=dlgCreateEl('div','dlg-stage-nav');
  const back=document.createElement('button'); back.type='button'; back.className='dlg-control'; back.textContent='← Previous'; back.disabled=!dlgHistory.length;
  back.addEventListener('click',()=>{if(!dlgHistory.length)return; dlgCurrentNode=dlgHistory.pop(); dlgRenderGameStage(stage,data); dlgRenderFlowMap(data);}); nav.appendChild(back);
  const reset=document.createElement('button'); reset.type='button'; reset.className='dlg-control'; reset.textContent='↺ Restart at line 1'; reset.addEventListener('click',()=>{dlgHistory=[];dlgCurrentNode=data.nodes.has(1)?1:(data.nodes.keys().next().value||1);dlgRenderGameStage(stage,data);dlgRenderFlowMap(data);}); nav.appendChild(reset);
  stage.appendChild(nav);
}
function dlgRenderTerminal(stage,o){
  stage.innerHTML=''; stage.appendChild(dlgCreateEl('div','dlg-stage-title','Conversation branch'));
  const p=dlgCreateEl('div','dlg-pc-bubble'); p.appendChild(dlgCreateEl('div','dlg-speaker','PLAYER')); const speech=dlgCreateEl('div','dlg-speech'); speech.appendChild(dlgSpeechEl('dlg-speech-text',o.text,false)); p.appendChild(speech); stage.appendChild(p);
  const end=dlgCreateEl('div','dlg-terminal',o.response===0?'This response ends the normal dialog.':`The dialog closes and the game runs the NPC's script at line ${-o.response}.`); stage.appendChild(end);
  if(o.actions && o.actions.trim()) stage.appendChild(dlgShowInternals ? dlgExplainEl([['Effects', explainActions(o.actions)]]) : dlgCreateEl('div','dlg-internal',`Effects: ${o.actions}`));
  const back=document.createElement('button'); back.type='button'; back.className='dlg-control'; back.textContent='← Back to NPC line'; back.addEventListener('click',()=>{dlgRenderGameStage(stage,dlgOpenData);}); stage.appendChild(back);
}
function dlgRenderFlowMap(data){
  const map=document.getElementById('dlgFlowMap'); if(!map)return; map.innerHTML='';
  const heading=dlgCreateEl('div','dlg-map-heading','Dialogue flow'); map.appendChild(heading);
  const nodes=[...data.nodes.values()];
  for(const n of nodes){
    const card=dlgCreateEl('button','dlg-map-node'); card.type='button'; if(n.num===dlgCurrentNode)card.classList.add('is-current');
    card.appendChild(dlgCreateEl('span','dlg-map-num',`#${n.num}`));
    card.appendChild(dlgCreateEl('span','dlg-map-text',dlgPlainText(n.text,true)||'(empty)'));
    const targets=n.options.filter(o=>o.response>0).map(o=>o.response);
    const targetLine=targets.length?`Choices → ${[...new Set(targets)].join(', ')}`:'No normal next line';
    card.appendChild(dlgCreateEl('span','dlg-map-target',targetLine));
    const trig=dlgTriggerMap?.get(n.num);
    if(trig?.length) card.appendChild(dlgCreateEl('span','dlg-map-trigger',`📜 from ${trig[0].scr} line ${trig[0].line}${trig.length>1?` (+${trig.length-1})`:''}`));
    card.addEventListener('click',()=>{dlgCurrentNode=n.num;dlgHistory=[];const stage=document.getElementById('dlgStage');dlgRenderGameStage(stage,data);dlgRenderFlowMap(data);});
    map.appendChild(card);
  }
}
// The NPC line a dialogue line belongs to: itself, or for a PC option the NPC line above it.
function dlgNodeFor(entries, num){
  let npc=null;
  for(const e of entries){ if(e.iq===0) npc=e.num; if(e.num===num) return npc; }
  return null;
}
// Returns the promise of the page being built, so a caller can wait for it.
function dlgOpenViewer(filename, relativePath, focusNum=null){
  return Promise.all([fetchDlgText(relativePath,filename), loadDynamicTables(), loadCodeTables(), dlgTriggers(filename)]).then(([text,,,triggers])=>{
    dlgTriggerMap=triggers;
    const entries=dlgParseFields(text); const data=dlgBuildNodes(entries); dlgOpenData=data;
    dlgCurrentNode=data.nodes.has(1)?1:(data.nodes.keys().next().value||1); dlgHistory=[]; dlgFemaleMode=false; dlgShowInternals=false;
    dlgFocusNum=focusNum;
    const focusNode=focusNum===null?null:dlgNodeFor(entries,focusNum);
    if(focusNode!==null && data.nodes.has(focusNode)) dlgCurrentNode=focusNode;
    saveDataExplorerState('dlg',relativePath,dlgCurrentFolderName,filename);
    gridEl.hidden=true; paginationEl.hidden=true; viewerEl.hidden=false; viewerEl.classList.add('revealed'); viewerEl.innerHTML='';
    const wrap=dlgCreateEl('article','dlg-viewer');
    const bar=dlgCreateEl('div','dlg-viewer-head');
    bar.appendChild(backButton());
    const h=dlgCreateEl('div','dlg-file-title'); h.appendChild(dlgCreateEl('strong',null,filename)); h.appendChild(dlgCreateEl('span',null,`/data/${relativePath}`)); bar.appendChild(h);
    const controls=dlgCreateEl('div','dlg-controls');
    const gender=document.createElement('button'); gender.type='button'; gender.className='dlg-control'; gender.textContent='Female text'; gender.addEventListener('click',()=>{dlgFemaleMode=!dlgFemaleMode;gender.classList.toggle('active',dlgFemaleMode);dlgRenderGameStage(document.getElementById('dlgStage'),data);}); controls.appendChild(gender);
    const internals=document.createElement('button'); internals.type='button'; internals.className='dlg-control'; internals.textContent='Explain conditions/effects'; internals.addEventListener('click',()=>{dlgShowInternals=!dlgShowInternals;internals.classList.toggle('active',dlgShowInternals);dlgRenderGameStage(document.getElementById('dlgStage'),data);}); controls.appendChild(internals);
    bar.appendChild(controls); wrap.appendChild(bar);
    const summary=dlgCreateEl('div','dlg-summary',`${entries.length} records · ${data.nodes.size} NPC speech nodes · dynamic lines (a:, b:, g:, q:…) show a typical wording from the game's generic dialogue files, with what they do in small text below; hover for the other wordings. The engine shows at most 5 options per line, filtered by IQ (negative = at most), gender and conditions.`); wrap.appendChild(summary);
    const workspace=dlgCreateEl('div','dlg-workspace');
    const stage=dlgCreateEl('section','dlg-stage'); stage.id='dlgStage';
    const map=dlgCreateEl('aside','dlg-flow-map'); map.id='dlgFlowMap';
    workspace.append(stage,map); wrap.appendChild(workspace); viewerEl.appendChild(wrap);
    dlgRenderGameStage(stage,data); dlgRenderFlowMap(data);
    const focused=stage.querySelector('.is-focus');
    if(focused){ focused.scrollIntoView({behavior:'smooth',block:'center'}); document.querySelector('#dlgFlowMap .is-current')?.scrollIntoView({block:'nearest'}); }
    else viewerEl.scrollIntoView({behavior:'smooth',block:'start'});
  }).catch(err=>{viewerEl.hidden=false;viewerEl.innerHTML=`<div class="dlg-error">Couldn't read ${escapeHtml(filename)}: ${escapeHtml(errText(err))}</div>`;});
}
async function openDlgFolder(relativePath, folderName){
  if(dlgTree) dlgTree.select(relativePath);
  dlgCurrentPath=relativePath; dlgCurrentFolderName=folderName; dlgCurrentManifest=await loadDlgManifest(relativePath); dlgFiles=manifestFiles(dlgCurrentManifest, 'dlg');
  saveDataExplorerState('dlg',relativePath,folderName,null);
  breadcrumbEl.textContent=`/data/${relativePath ? relativePath+'/' : ''}`;
  gridEl.hidden=false; viewerEl.hidden=true; viewerEl.innerHTML='';
  renderDataFolderGrid({subfolders:manifestSubfolders(dlgCurrentManifest),files:dlgFiles,relativePath,openFolderFn:openDlgFolder,openFileFn:(fn, card, _fullPath)=>dlgOpenViewer(fn, relativePath),fileIcon:'💬'});
}
// Open a .dlg (top-level file name) in the dialogue explorer.
export async function openDlgFile(file, focusNum = null) {
  saveDataExplorerState('dlg', '', 'dlg', file);
  await enterDlgExplorer(true, focusNum);
}

// focusNum: a dialogue line to show (an NPC line, or a player option on the NPC line above it).
export async function enterDlgExplorer(restoreState = false, focusNum = null) {
  const { path, name, file } = beginDataExplorer('dlg', { rootName: 'data', restoreState });
  dlgTree = mountFolderTree({
    rootName: 'data', loadManifest: loadDlgManifest, openFolder: openDlgFolder, ext: 'dlg', fileIcon: '💬', searchFields: DLG_FIELDS,
    searchLines: dlgSearchLines, openLine: (filename, parent, num) => dlgOpenViewer(filename, parent, num),
    lineLinks: async (_parent, filename) => new Map([...await dlgTriggers(filename)].map(([num, list]) =>
      [num, list.map(t => ({ prefix: '📜 Triggered by ', text: triggerLabel(t), title: `Open ${t.scr} at line ${t.line}`, open: () => openTrigger(t) }))])),
    openFile: (filename, _row, parent) => dlgOpenViewer(filename, parent),
  });
  try {
    await openDlgFolder(path, name);
    if (file && dlgFiles.includes(file)) await dlgOpenViewer(file, path, focusNum);
  } catch (err) { showExplorerError(err); }
}
