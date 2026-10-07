# TidaLuna-Plugins

**HQPlayer Plugin for TidaLuna** - Streams TIDAL playback to HQPlayer using UPnP AVTransport protocol.

Built and auto-released to the TidaLuna Plugin Store on every push to `main`.

## Features

- Streams TIDAL HiFi/FLAC audio to HQPlayer
- UPnP AVTransport control (play/stop)
- Full buffering for reliable playback
- OLD_AES decryption for encrypted TIDAL streams
- Quality selection (HI_RES_LOSSLESS, LOSSLESS, HIGH, LOW)
- Optional TIDAL output muting

## Requirements

- TIDAL HiFi (FLAC) subscription
- HQPlayer Desktop or Embedded with UPnP control enabled
- TidaLuna installed in TIDAL desktop app

## Install

1. Open TIDAL with TidaLuna installed
2. Luna Settings (top right) → **Plugin Store** → paste into "Install from URL":
   ```
   https://github.com/angelosdog/tl-plugins/releases/download/latest/store.json
   ```
3. Go to the **Plugins** tab and enable the HQPlayer plugin
4. Configure settings:
   - **HQPlayer host**: IP/hostname of HQPlayer (default: `localhost`)
   - **UPnP device URL**: HQPlayer's UPnP endpoint (default: `http://localhost:8019`)
   - **Quality**: Select desired audio quality
   - **Mute TIDAL output**: Enable to silence TIDAL's own audio output

## Build from source

```bash
pnpm install
pnpm run build
# or for development:
pnpm run watch
```

Then open TidaLuna → Plugin Store tab → install the `[Dev]` plugin.

## How it works

1. Plugin intercepts TIDAL playback and fetches the audio stream
2. Entire track is buffered to a temporary file (ensures reliable streaming)
3. Encrypted streams (OLD_AES) are decrypted
4. Track URL and metadata sent to HQPlayer via UPnP AVTransport
5. HQPlayer fetches audio from plugin's HTTP server
6. Transport state (play/stop) mirrored from TIDAL to HQPlayer

## Limitations

- **No seek support**: Seeking within tracks is not implemented. Issues with tracking what a seek means in Tidal
- **UPnP only**: Attempted direct streaming and OpenHome renderers but couldn't solve stuttering
- **No pause and resume**: TODO
- **Gapless playback**: TODO

## Troubleshooting

- **Connection fails**: Verify HQPlayer is running and UPnP control is enabled
- **No audio**: Check that UPnP device URL is correct (I worked out the URL using BubbleUPnP to see the renderer address)
- **Playback stops**: Check HQPlayer logs for errors; ensure network connectivity between TIDAL and HQPlayer

## License

MIT