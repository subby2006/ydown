import { installNetworkCapture } from './player-data';
import { installUi } from './ui';

installNetworkCapture();
installUi();
console.info('[YT Local Downloader] Ready. Media stays in this browser tab.');
