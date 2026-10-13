// Shared viewer panel (back bar, share button) and sidebar launch buttons.

import { updatePaginationBar } from '../art/art-explorer.js';
import { closeGifBuilder } from '../art/gif-builder.js';
import { clearShareUrl, copyShareLink, updateUrlForItem } from '../art/share-links.js';
import { gridEl, packerLaunchBtn, paginationEl, viewerEl } from '../core/dom.js';
import { explorerMode, openGroup, setOpenGroup } from '../core/state.js';
import { backButton } from './nav-history.js';

export function showViewer(article, shareInfo) {
  gridEl.hidden = true;
  paginationEl.hidden = true;
  viewerEl.innerHTML = '';

  const backBar = document.createElement('div');
  backBar.className = 'viewer-backbar';
  backBar.appendChild(backButton());

  if (shareInfo) {
    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'btn-share';
    shareBtn.textContent = '🔗 Share';
    shareBtn.addEventListener('click', () => {
      copyShareLink(shareInfo.folder, shareInfo.folderName, shareInfo.file, shareBtn);
    });
    backBar.appendChild(shareBtn);
    updateUrlForItem(shareInfo.folder, shareInfo.folderName, shareInfo.file);
  }

  viewerEl.appendChild(backBar);
  viewerEl.appendChild(article);
  viewerEl.hidden = false;
  viewerEl.classList.add('revealed');
}

// Hides the viewer and shows the grid again (the .ART explorer starting a folder or a search).
export function showBrowser() {
  if (openGroup) closeGifBuilder();
  setOpenGroup(null);
  viewerEl.hidden = true;
  viewerEl.innerHTML = '';
  gridEl.hidden = false;
  updatePaginationBar();
  clearShareUrl();
  gridEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// The packer is only for .ART work.
export function syncSidebarLaunchButtons() {
  if (packerLaunchBtn) packerLaunchBtn.hidden = explorerMode !== 'art';
}
