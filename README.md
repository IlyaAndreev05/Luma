# Luma — Display Brightness

Luma adds a compact display brightness control below the output and microphone sliders in GNOME 50 Quick Settings, before the Wi-Fi and Bluetooth tiles. Internal displays use GNOME's monitor backlight; external monitors use DDC/CI when available; monitors without a writable backlight can be dimmed in software.

The brightness slider maps its left edge to a configurable safe floor (2–20%, default 2%) instead of turning the image fully black. Display percentages continue to match device readings. The current percentage can be shown or hidden in Luma's settings.

## Install

Install `ddcutil` from Ubuntu's repository for external monitor controls. Enable DDC/CI in the monitor's on-screen menu. The current user needs read/write access to the monitor's `/dev/i2c-*` device; on Ubuntu, install the distribution's I²C udev/group rules and sign out and back in after changing group membership. Do not run GNOME Shell as root. Software dimming remains available when DDC/CI cannot be used.

Build and install from this directory:

```sh
make pack
gnome-extensions install --force dist/luma@ilyaandreev05.github.io.shell-extension.zip
```

Log out and back in if the extension is not loaded, then enable **Luma — Display Brightness** in Extensions. Open its settings from Extensions or run `gnome-extensions prefs luma@ilyaandreev05.github.io`.

DDC/CI button synchronization depends on the display returning VCP feature `0x10`. Some docks and monitors do not report changes or do not permit writes. Luma reports software dimming explicitly; it cannot change a physical backlight without a hardware control path.

## Development

The extension targets GNOME Shell 50 and uses its Quick Settings and monitor backlight APIs. Run `make check` to validate JavaScript syntax, model tests, schemas, Russian translations, and the extension bundle.
