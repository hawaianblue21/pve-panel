---
title: Linux and Windows templates
sidebar_position: 1
---

**Linux templates (cloud-init):** a cloud-init drive and a cloud image that runs
cloud-init (for example the official Debian or Ubuntu cloud images). Install
`qemu-guest-agent` if customers should see IP addresses. In the admin interface,
set the template's setup to "Cloud-init (Linux)".

**Windows templates (guest agent, no cloud-init needed):**

The template must boot straight to the login screen after cloning, without any
setup questions. That's what the sysprep answer file does; the project ships one
in [`docs/windows/unattend.xml`](https://github.com/hawaianblue21/pve-panel/blob/main/docs/windows/unattend.xml) that answers every
welcome (OOBE) screen: license terms, product key, region and keyboard, and the
Administrator password.

1. Install Windows, the VirtIO drivers and the QEMU guest agent (both on the
   virtio-win ISO). Enable **Options → QEMU Guest Agent** on the VM.
2. Configure what every customer should get (updates, time zone, software).
   Set the network adapter to **DHCP** (no static IP, gateway or DNS). Windows
   ties IP settings to the adapter's PCI slot, not its MAC address, so clones
   would otherwise inherit the template's static settings. The panel switches
   adapters to DHCP anyway, but a clean template avoids surprises.
3. Copy `docs/windows/unattend.xml` into the VM and edit the lines marked
   `CHANGE`:
   - **Product key:** the key for your licensing. For KMS, Microsoft publishes
     the client setup keys (GVLK) per edition ("KMS client activation and
     product keys"); for SPLA or MAK, use the key from your agreement. This line
     answers the "enter product key" screen; if the image already has a key,
     the line can go.
   - **Language, keyboard, time zone:** `UILanguage` must be a language that's
     installed in the image.
   - **Temporary Administrator password:** only used until the panel sets the
     customer's password.
4. Run sysprep with it:
   ```
   copy unattend.xml C:\Windows\System32\Sysprep\unattend.xml
   C:\Windows\System32\Sysprep\sysprep.exe /generalize /oobe /shutdown /unattend:C:\Windows\System32\Sysprep\unattend.xml
   ```
5. When the VM has shut down, convert it to a template **without booting it
   again**. Booting it would run the welcome screens and use up the sysprep.

**Test the template before offering it:** clone it by hand, start the clone and
watch the console. It must end at the login screen without asking anything.

**Fixing a template that stops at the welcome screens:** a sysprep'd template
can't be edited in place. Make a full clone, start it, click through the welcome
screens once, put the corrected `unattend.xml` in place, run step 4 again, and
make that VM your new template (then point the panel's template list at it).

In the admin interface set the template's setup to "Guest agent (Windows)".
After cloning, the panel starts the VM, waits until Windows reports its setup as
complete (registry `ImageState`), sets the Administrator password, renames the
computer to the customer's hostname and reboots. The password is verified inside
Windows after setting it and again after the reboot; if the guest agent's
password call didn't take effect, the panel sets it a second way (`Set-LocalUser`).
A server is never marked ready while the template's temporary password still works. Expect 10–20 minutes. Customers
must use a password Windows accepts (three of: lowercase, uppercase, numbers,
symbols); the panel checks this before starting.

With customer networks enabled, the panel then switches every network adapter
to DHCP (removing static addresses, gateways and DNS servers left over from the
template) and waits until Windows has an address in the customer's subnet. If
none arrives within 3 minutes, creation fails with the addresses it found,
which usually points to DHCP being blocked (see the host firewall rules).

If Windows still stops at a welcome screen, the panel notices: after 15 minutes
at those screens (`WINDOWS_OOBE_TIMEOUT_MINUTES`) creation fails with a message
saying so, instead of the customer waiting for the full 45 minutes. A server
that's already waiting there can be rescued by finishing the screens in its
console; the panel then carries on by itself.

The guest agent lets the panel run commands as SYSTEM inside customer VMs, which
is why `VM.GuestAgent.Unrestricted` is needed. Keep the API token secret.

Keep template disks small; customers choose the final size and the panel grows
the disk after cloning. Servers are full clones on the template's node.

For TLS, either give Proxmox a trusted certificate or copy `/etc/pve/pve-root-ca.pem`
to the panel host and set `PVE_CA_FILE`. Avoid `PVE_VERIFY_TLS=false` outside development.
