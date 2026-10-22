# Luma — Display Brightness

Luma adds a compact display brightness control below the output and microphone sliders in GNOME 50 Quick Settings, before the Wi-Fi and Bluetooth tiles. Internal displays use GNOME's monitor backlight; external monitors use DDC/CI when available; monitors without a writable backlight can be dimmed in software.

The main slider is an independent overall level. Luma applies it through each display's selected brightness backend, while each display slider keeps its own saved level. The visible output combines the two levels, so an overall level of 50% and a display level of 80% produce about 40% brightness. The overall level is saved separately and also applies to newly connected displays.

Each brightness slider has a configurable nonzero minimum (2–20%, default 2%). The two independent levels combine multiplicatively; hardware writes retain at least one device step so a low setting does not switch the display off. Per-display percentages show that device's independent level; the current percentage can be shown or hidden in Luma's settings.

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
