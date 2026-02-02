import { renderIcons } from './icons';
import { initRemote } from './atv_remote';
import { initIPC, init } from './web_remote';

document.addEventListener('DOMContentLoaded', function () {
  renderIcons();
  initIPC();
  initRemote();
  init().then(() => {
    console.log('init complete');
  });
});
