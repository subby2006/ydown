# ydown

ydown is a chrome extension that downloads youtube videos **in the browser**. no external server required

we hook into youtube's native download button and turn it into something actually useful instead of having it be a yt premium upsell. the extension can download up to 4k (or whatever quality youtube exposes)

## features

- everything done in-browser. downloading and muxing. nothing leaves your computer
- MP4/H.264-or-AV1 with AAC and WebM/VP9 with Opus.
- all video qualities and encodes exposed, including those not actively used by the player
- native youtube-looking ui 
- audio-only downloads for music (videos)
- thumbnails embedded in your download
- video codec blocks enforced by enhanced-h264ify respected
- hide the download window while one transfer continues across youtube navigation
- download complete notifications
- update notifications

the replacement Downloads page is still a work in progress. multi-download support is disabled while we isolate it from youtube playback.

only download videos you're authorized or otherwise have permission to save

## building

requirements: node.js, npm, and two braincells

```powershell
npm install
npm run check
npm test
npm run build
```

`npm run build` builds the primary extension artifact in
`../../outputs/youtube-local-downloader-extension`.

To compile a diagnostic build that bypasses the save picker and writes completed
files to origin-private browser storage, run:

```powershell
npm run build:extension:diagnostic
```

It writes `../../outputs/youtube-local-downloader-extension-diagnostic`. This is
a build-time variant: normal builds contain only the save-picker path, while
diagnostic builds contain only the browser-storage path.

For telemetry-enabled local builds, copy `.env.example` to `.env.local` and set
`SENTRY_DSN`. Release builds expect a GitHub Actions secret with the same name.

## installing

1. download the built extension zip from releases and extract to a directory of your choice
2. Open `chrome://extensions` (or the equivalent for your chromium browser)
3. enable **Developer mode**.
4. select **Load unpacked**.
5. select the folder you extracted the extension to
6. enjoy!

on a regular youtube watch page, start playback briefly and select the **Download** button from the video controls or **More actions** menu.
choose a format and destination, and keep the tab open while the video's downloaded

## tempermonky build

> **Experimental:** the Tampermonkey version is not the primary or recommended
> distribution. MV3-era Tampermonkey execution-world and injection limitations
> make the early main-world player hooks required by `ydown` less reliable than
> the dedicated extension. It may fail to capture a usable playback session even
> when the MV3 extension works correctly.

The userscript is intentionally excluded from the default build. Build it only
with the explicit experimental command:

```powershell
npm run build:userscript
```

That command supplies the required `--experimental-userscript` build flag and
writes `../../outputs/youtube-browser-downloader.user.js`. Running
`scripts/build.mjs` without the flag fails rather than silently producing the
experimental artifact.

## limitations

- need a modern-ish chromium with support for the File System Access API, origin-private
  file storage and WebCodecs.
- no firefox support (youtube genuinely sucks on firefox. you won this time google.)
- live streams, rentals, primetime, youtube movies, shorts (in shorts view), and anything without the native 
  Download button are not supported.
- sometimes ydown might not work if you leave the video tab open for too long. if such a problem occurs simply reload the page, play the video briefly and retry
- sometimes (vary rarely) the player might get stuck on an endless reload loop, again refresh the page to fix it

## special thanks

- [GoogleVideo](https://github.com/LuanRT/GoogleVideo) by
  [LuanRT](https://github.com/LuanRT) for figuring out youtube's propreitary streaming fuckery that makes  downloads possible.
- [MediaBunny](https://github.com/Vanilagy/mediabunny) by
  [Vanilagy](https://github.com/Vanilagy) for parsing and muxing MP4/WebM media
  entirely inside the browser. seriously ydown would not be possible without this project.
- [Codex](https://openai.com/codex) ima kiss you altman for making such a powerful tool
