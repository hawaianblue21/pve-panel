# UI/UX design reference

Design screens for the next versions of PVE Panel: the admin portal, the customer portal and the support
flow. They are the reference for what gets built; not every screen is implemented yet (see the status
column).

The files are canvas sources (`.dc.html`: HTML with template placeholders such as `{{…}}`, `<sc-for>`,
`<sc-if>` and a small logic class per screen, laid out by `canvas.json`). They need the design canvas
runtime to render and are not standalone pages; read them as annotated mockups. Names, domains and
figures in them are examples.

Visual language (implemented in `web/shared/styles.css`): midnight navy (`#0A101C` page, `#101828` cards,
`#0D1424` sidebar), signal blue `#4C9AFF`, status green `#3DD68C` / amber `#F5B94C` / red `#FF8A8A`, IBM Plex Sans,
Space Grotesk for headings and figures, JetBrains Mono for labels; grouped sidebars as in `Sidebar.dc.html`.
Dark is the panel's default mode; the light variant keeps the navy sidebar.

Status: ✅ implemented · 🟡 partly (what is missing is listed) · ⬜ design only

## Admin portal

| Screen | File | Status |
|---|---|---|
| Multi-host dashboard | `Main.dc.html` | ✅ Overview tab: KPIs per permission, nodes with load, alerts, latest activity (all clusters; trends and plan suspensions missing) |
| Guests (all hosts) | `Admin-Guests.dc.html` | ✅ Servers tab: filters (node, status, customer, type), grouping by node, size, bulk power, assign (adopting existing guests) and unassign (plan and billing columns, paging missing) |
| Plans | `Admin-Plans.dc.html` | ✅ sizes with prices, GPU plans, retire, plans-only mode (plan bundles for object storage and IPs missing) |
| Networking & IPAM | `Admin-IPAM.dc.html` | ✅ customer networks (SDN), public IPv4 pools, addresses, reservations, cool-down, reverse DNS, optional IPv6 (/64 per address, global switch) (floating IPs missing) |
| Billing overview, invoice detail | `Admin-Billing.dc.html`, `Admin-Invoice.dc.html` | ✅ KPIs, filters, confirm transfer, cancel, wallet adjustment, fixed price, **dunning pipeline** (invoice D−7, reminders, wallet charge on the due date, stop D+3, pause, reminder by hand, timeline per invoice), refunds to the wallet or recorded outside the panel (late fees and refunds through the gateway API missing) |
| Hosts & onboarding (owner only) | `Admin-Hosts.dc.html` | ✅ clusters (connect with test, TLS pin, conflicts, disable, remove), nodes, version, load, maintenance; existing guests are adopted in bulk from Servers (filter Not assigned, select, Assign) |
| OS templates (owner only) | `Admin-Templates.dc.html` | 🟡 offering templates, owner-only changes, import wizard for qcow2/img, OVA and ISO from a URL (checksum, Windows with VirtIO drivers, UEFI and TPM, install in the Proxmox console, test boot on a linked clone, one copy per cluster, Jobs with retry); VMDK upload and telemetry missing |
| Provisioning jobs | `Admin-Jobs.dc.html` | ✅ Jobs tab: servers being set up, reinstalled, deleted or failed, update runs, rollouts, finished work of 7 days (retry for failed deletions, update runs, automatic snapshots and backups; step list missing) |
| In-browser console | `Admin-Console.dc.html` | ✅ |
| Access & roles (RBAC) | `Admin-Access.dc.html` | ✅ |
| Resource allocation pools | `Admin-Pools.dc.html` | ✅ |
| Object storage (SeaweedFS) | `Admin-Storage.dc.html` | ✅ |
| GPU compute | `Admin-GPU.dc.html` | ✅ |
| Customers & behaviour | `Admin-Customers.dc.html` | 🟡 customer list and limits; behaviour profile and signals missing |
| Activity log | `Admin-Activity.dc.html` | ✅ filters by actor, kind and text, event details, paging (diff view missing) |
| Ticket desk (Zammad) | `Admin-Support.dc.html` | ✅ queues, notes, customer context, KB suggestions, optional Zammad sync (AI triage missing) |
| Knowledge base editor | `Admin-KB.dc.html` | ✅ drafts from tickets, visibility, searches without results (AI drafts missing) |
| AI assistant | `Admin-AI.dc.html` | ✅ provider settings, usage, conversations with tool calls (behaviour presets and knowledge-gap view missing) |
| API tokens & integrations (owner only) | `Admin-Integrations.dc.html` | ✅ API tokens (customer and admin, scopes, read-only, expiry, last use; owners see all), Zammad, AI provider, Xendit and Midtrans in Settings (webhooks out missing) |
| Settings & white label (owner only) | `Admin-Settings.dc.html` | ✅ branding, single sign-on, appearance, updates, email, expiry; Proxmox clusters live under Hosts, Proxmox Backup Servers under Backups |
| Patch management | `Admin-Updates.dc.html` | ✅ fleet view (last run, never, older than 30 days, failed), rollouts in rings with failure limit, pause/resume/cancel, customer emails, pending-update counts (Check now), maintenance windows |
| Backups (Proxmox Backup Server) | `Admin-Backups.dc.html` | ✅ Backups tab: Overview (coverage, last 24 hours, needs attention, datastores with dedup / GC / verify, settings), Runs, Servers (own policy, back up now, exclude), Restores, Policies (per plan, add-on price), Backup servers for owners (test, certificate pin, datastore, clusters). Differs from the design: the connect wizard is one form; backups of deleted servers are kept 14 days (1 to 3650, set here), then removed |
| Server lifecycle (expiry) | `Admin-Lifecycle.dc.html` | ✅ rules, reminders, stop, grace, deletion, pause; queue view (Server lifecycle tab: stage, next step, sent notices, extend, remove date, Check now, pause) |

## Customer portal

| Screen | File | Status |
|---|---|---|
| My servers, server detail, create server | `Customer-Servers.dc.html`, `Customer-Server.dc.html`, `Customer-Create.dc.html` | ✅ incl. plans, paying in advance and moving to a larger plan |
| OS updates (Windows + Linux) | `Customer-Updates.dc.html` | ✅ weekly automatic window missing |
| Renewals & expiry | `Customer-Expiry.dc.html` | ✅ expiry banner, free extension, paid renewal and auto-renew |
| Appearance & sign-in methods | `Customer-Preferences.dc.html` | ✅ density, language and time zone missing |
| Sign in with single sign-on | `Customer-SignIn.dc.html` | ✅ company-domain enforcement missing |
| Network & VPN | `Customer-Network.dc.html` | ✅ |
| Security & 2FA | `Customer-Security.dc.html` | ✅ |
| Billing & wallet, invoice & pay | `Customer-Billing.dc.html`, `Customer-Invoice.dc.html` | ✅ wallet, top-up, renewals, invoices (print/PDF), Xendit, Midtrans, bank transfer |
| Server backups & restore | `Customer-Backups.dc.html` | ✅ Backups tab of a server: plan, window, encryption, back up now (per day limit), restore points, protect up to 3, browse files and download a file or a folder (zip), restore as a new server or over the server, longer retention as an add-on. Differs from the design: a tab of the server, not a sidebar item; file download per file or folder instead of a multi-select zip; the new server keeps the original's plan and only its system disk; restoring over the server needs it shut down and without block storage volumes; no type-the-name confirmation (a confirm dialog) |
| Block storage | `Customer-Block.dc.html` | ✅ tiers, create, attach/detach/move, enlarge, delete (snapshots: server-level incl. attached volumes, automatic daily/weekly; IOPS figures missing) |
| Object storage | `Customer-Object.dc.html` | ✅ buckets, quota, usage, access key shown once, AWS CLI / rclone / restic snippets, read-only buckets |
| Support tickets | `Customer-Tickets.dc.html` | ✅ |
| Knowledge base (help center) | `Customer-KB.dc.html` | ✅ |
| AI assistant | `Customer-Assistant.dc.html` | ✅ answers with sources, ratings, handover to a ticket |

## Shared

| | File |
|---|---|
| Sidebar component (both portals) | `Sidebar.dc.html` |
| Support flow: knowledge base → AI assistant → ticket → helpdesk → knowledge base | `Admin-SupportFlow.dc.html` |
| Canvas layout | `canvas.json` |
