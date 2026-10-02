# TidaLuna-Plugins

TIDAL > HQPlayer: streams TIDAL playback to an HQPlayer instance over its XML network control protocol (requires a HiFi/FLAC TIDAL account).

Built and auto-released to the TidaLuna Plugin Store on every push to `main`.

## Install

1. Open TIDAL with TidaLuna installed.
2. Luna Settings (top right) → **Plugin Store** → paste into "Install from URL":
   `https://github.com/angelosdog/tl-plugins/releases/download/latest/store.json`
3. Go to the **Plugins** tab and enable **Enabled** in the HQPlayer settings.

## Build from source

```
pnpm install
pnpm run watch
```

Then open TidalLuna → Plugin Store tab → install the `[Dev]` plugin.

## Notes

- Package names are scoped to `@angelosdog/...`. If you fork this, rename them in `package.json` and `plugins/hqplayer/package.json` to your own GitHub username so the built artifacts get your plugin id.
- First playback requires HQPlayer reachable on port 4321; make sure `HQPlayer host` and `Stream host` (optional auto-detect) are correct in plugin settings.