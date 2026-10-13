// Drag-and-drop / file-picker wiring.

import { handleFiles } from './file-group.js';
import { handlePackerFiles } from './packer-ui.js';
import { dropzone, fileInput, packerDropzoneEl, packerFileInputEl } from '../core/dom.js';

function wireDropzone(zoneEl, inputEl, onFiles) {
  zoneEl.addEventListener('click', () => inputEl.click());
  zoneEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputEl.click();
    }
  });
  inputEl.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) onFiles(e.target.files);
    inputEl.value = '';
  });

  ['dragenter', 'dragover'].forEach(evt =>
    zoneEl.addEventListener(evt, (e) => {
      e.preventDefault();
      zoneEl.classList.add('dragging');
    })
  );
  ['dragleave', 'drop'].forEach(evt =>
    zoneEl.addEventListener(evt, (e) => {
      e.preventDefault();
      zoneEl.classList.remove('dragging');
    })
  );
  zoneEl.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      onFiles(e.dataTransfer.files);
    }
  });
}

if (dropzone && fileInput) wireDropzone(dropzone, fileInput, handleFiles);   // the page no longer has this zone
wireDropzone(packerDropzoneEl, packerFileInputEl, handlePackerFiles);
