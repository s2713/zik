# Target 2 — Chromebook

Primary device: **HP Chromebook x360 12b-ca0010nf** (Gemini Lake N4020, 2019).
The image is built for x86_64 and targets the MrChromebox coreboot/UEFI family;
it should run on other Gemini Lake Chromebooks with minor adjustments.

---

## ⚠ DISCLAIMER — READ BEFORE TOUCHING ANY SCREW OR RUNNING ANY COMMAND

**This procedure involves opening the device, removing a write-protect screw or
disconnecting the battery, and permanently replacing the factory firmware with
third-party firmware.**

*Permanently* means the original Google firmware is gone from flash. You can
restore it from the backup you are instructed to make below, but only if you
still have that backup file, another working machine, and the courage to repeat
the procedure in reverse. If you lose the backup, or if something goes wrong
mid-flash, **your Chromebook may be rendered permanently unbootable.** Repair
is non-trivial and may require specialised hardware.

The authors of this software **accept absolutely no responsibility whatsoever**
for any damage, data loss, bricking, voided warranty, fire, flood, quantum
fluctuation, personal injury, emotional distress, or any other consequence,
direct or indirect, real, imagined, past, present, future, or existing in
parallel universes, that may arise from following — or misreading — these
instructions.

**By proceeding you acknowledge that you are acting entirely at your own risk.**

When you open a device and flash its firmware, you own the outcome.

---

## Overview

Installing Zik on a Chromebook requires four stages:

1. **Safety net** — create a ChromeOS recovery USB and back up the stock firmware.
2. **Firmware** — disable write protection, replace factory firmware with
   MrChromebox coreboot/UEFI.
3. **Image** — build (or download) the Zik disk image and flash it to a USB key.
4. **Install** — boot from USB and write the image to the internal SSD.

Stages 1–2 and 4 happen on the Chromebook itself. Stage 3 uses a second Linux
machine (your build host).

---

## Prerequisites

### On the Chromebook

- A charged battery.
- An internet connection (for the MrChromebox firmware utility).
- A Phillips-head screwdriver (PH0 or PH00).

### On the build host (Linux)

- `sudo` access.
- The packages listed in `build-deps` installed (run `../../install-build-deps.sh`).
- A USB drive ≥ 8 GB to receive the Zik image.
- A second USB drive ≥ 4 GB for the ChromeOS recovery image (optional but
  strongly recommended).

---

## Stage 1 — Safety net

### 1.1 Create a ChromeOS recovery USB

If anything goes wrong you can restore ChromeOS from a recovery image.

1. On any machine, go to <https://google.com/chromeos/recovery> (or search
   "Chromebook Recovery Utility").
2. Install the Chromebook Recovery Utility Chrome extension.
3. Follow the prompts; select your exact model (HP Chromebook x360 12b-ca0010nf).
4. Flash the recovery image to the spare USB drive.
5. Label it and keep it safe.

### 1.2 Enable Developer Mode on the Chromebook

> **Developer Mode wipes all local user data.** Back up anything you care about.

1. Power off the Chromebook.
2. Hold **Esc + Refresh (↻) + Power** simultaneously.
3. The machine enters Recovery Mode ("ChromeOS is missing or damaged…").
4. Press **Ctrl + D**, then confirm with **Enter** when prompted.
5. The device reboots and wipes itself (takes 5–10 minutes).
6. On the "OS verification is off" screen, press **Ctrl + D** to boot each time
   (or wait 30 seconds).

### 1.3 Open a root shell

1. At the ChromeOS login screen, press **Ctrl + Alt + T** to open the crosh
   terminal, or press **Ctrl + Alt + F2** (→) to get a VT.
2. In crosh, type `shell` and press Enter.
3. Become root: `sudo bash`

### 1.4 Back up the stock firmware

```bash
# Install flashrom if absent (Developer Mode ships it)
flashrom --programmer internal -r /mnt/stateful_partition/firmware-backup.bin
```

Copy the backup off the device **before** continuing:

```bash
# On your build host (replace chromebook-ip with the device's IP):
scp chronos@chromebook-ip:/mnt/stateful_partition/firmware-backup.bin ./
```

> If you cannot reach the device over SSH, copy to a USB drive:
> `cp /mnt/stateful_partition/firmware-backup.bin /media/removable/<drive>/`

Keep `firmware-backup.bin` somewhere safe. You will need it if you ever want
to restore the factory firmware.

---

## Stage 2 — Firmware replacement

### 2.1 Disable write protection

The HP Chromebook x360 12b uses a **write-protect screw** on the main board
that must be removed before the firmware can be reflashed.

> **Verify the screw location for your exact board revision** using the
> MrChromebox wiki at <https://wiki.mrchromebox.tech/Firmware_Write_Protect>
> and the iFixit teardown for your model. The screw is typically silver, near
> the SSD or battery connector.

Steps:

1. Power off completely and unplug all cables.
2. Remove the bottom cover (10 Phillips-head screws on the x360 12b;
   the display hinge area may require gentle prying).
3. Locate and remove the **write-protect screw** (one small silver screw).
   Keep it; you will need it if you want to revert.
4. Optionally disconnect the battery connector for extra safety during the
   firmware flash.
5. Reassemble the bottom cover (you can leave it loose for now).
6. Power on and re-enter Developer Mode root shell (see §1.3).

### 2.2 Run the MrChromebox firmware utility

```bash
cd /tmp
curl -LO mrchromebox.tech/firmware-util.sh
sudo bash firmware-util.sh
```

1. Select **"Install/Update UEFI (Full ROM) Firmware"**.
2. The script will offer to save a firmware backup — **accept**.
3. Confirm the flash. The utility downloads and writes the coreboot/UEFI ROM.
4. Reboot when prompted.

After reboot you will see a standard UEFI boot screen instead of the Google
firmware screen. The Chromebook can now boot from a standard USB drive.

---

## Stage 3 — Build and flash the Zik image

### 3.1 Build the image (on the build host)

```bash
cd targets/chromebook
sudo ./build-image.sh --version 1.0
# Output: work/zik-chromebook-1.0.img.zst
```

The build takes 10–20 minutes (mostly debootstrap). Pass `--mirror
http://ftp.fr.debian.org/debian` (or your nearest mirror) to speed up the
debootstrap step.

If the backend and frontend are already built:

```bash
sudo ./build-image.sh --version 1.0 --no-build
```

### 3.2 (Optional) Apply configuration

Create a `config.yaml` next to the image before flashing to pre-configure
users, Wi-Fi, timezone, and language:

```yaml
admin_password: "changeme"
language: "en"
timezone: "Europe/Paris"
wifi:
  - ssid: "MyNetwork"
    psk:  "wpa-passphrase"
users:
  - name: alice
    password: "alice-password"
```

```bash
sudo ./configure-image.sh \
    --image work/zik-chromebook-1.0.img.zst \
    --config config.yaml
```

If you skip this step, a first-boot wizard will ask for the admin password on
first login.

### 3.3 Flash to USB

```bash
# Identify your USB drive first — triple-check the device node!
lsblk

# Decompress and flash (replace /dev/sdX with your USB drive):
zstd -d work/zik-chromebook-1.0.img.zst --stdout | sudo dd of=/dev/sdX bs=4M status=progress conv=fsync
sync
```

> **Do not flash to your build host's internal drive.** `lsblk` before and
> after inserting the USB key to confirm the correct device node.

---

## Stage 4 — Boot and install

### 4.1 Boot from USB

1. Plug the Zik USB drive into the Chromebook.
2. Power on; the UEFI boot manager should appear.
3. Select the USB drive (may appear as "USB HDD" or the drive manufacturer's
   name).
4. Zik boots to a login screen.

### 4.2 Install to the internal SSD (optional but recommended)

> This overwrites the internal SSD entirely. **ChromeOS will be gone.**
> Keep the ChromeOS recovery USB from stage 1 if you want to be able to
> revert.

SSH into the running Zik system (admin user, if configured) or use the
maintenance shell (CTRL+ALT+F2 at the login screen):

```bash
# On the build host, copy the image to the running Zik USB system, then on
# the device:
sudo dd if=/path/to/zik-chromebook-1.0.img of=/dev/mmcblk0 bs=4M status=progress conv=fsync
sync
sudo reboot
```

The internal SSD on most Chromebooks is `/dev/mmcblk0`; confirm with `lsblk`
before running `dd`.

### 4.3 First boot

If no `config.yaml` was applied, the first-boot wizard runs at login and asks
for the admin password. Once set, the admin account is unlocked and the wizard
will not run again.

---

## Reverting to ChromeOS

### Option A — ChromeOS recovery USB

1. Plug in the ChromeOS recovery USB created in §1.1.
2. Power on; hold **Esc + Refresh + Power** to enter recovery mode.
3. Follow the on-screen prompts — ChromeOS is restored.

> This restores the OS but **not** the factory firmware. The coreboot/UEFI ROM
> from MrChromebox remains in flash. ChromeOS will run fine under it for most
> models, but some hardware-specific features may differ.

### Option B — Restore the factory firmware

If you want to fully revert to the factory Google firmware:

1. **Leave the write-protect screw out** (or re-remove it if you already
   reinstalled it). The SPI flash is write-protected when the screw is in
   place — `flashrom` will refuse to write.
2. Boot any Linux live USB.
3. Use `flashrom` to write back the backup:

```bash
sudo flashrom --programmer internal -w firmware-backup.bin
```

4. Reinstall the write-protect screw.
5. Reboot. The factory firmware is restored.

> This requires the `firmware-backup.bin` file from §1.4. Without it, you
> cannot restore the factory firmware without specialised hardware
> (SPI programmer + SOIC clip).

---

## Build dependencies

See `build-deps` in this directory and `../../install-build-deps.sh` at the
repo root.
