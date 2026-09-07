import { installNetworkCapture } from './player-data';
import { isPremiumAccount } from './premium';
import { installUi } from './ui';

void isPremiumAccount().then((premium) => {
  if (premium) {
    console.info('[YT Local Downloader] Disabled because YouTube Premium is active.');
    return;
  }
  installNetworkCapture();
  installUi();
  window.postMessage({ type: 'ydown:enabled:v1' }, location.origin);
  console.info('[YT Local Downloader] Ready. Media stays in this browser tab.');
});
