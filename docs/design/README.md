# UI/UX design reference

Design screens for the next versions of PVE Panel: the admin portal, the customer portal and the support
flow. They are the reference for what gets built; not every screen is implemented yet (see the status
column).

The files are canvas sources (`.dc.html`: HTML with template placeholders such as `{{…}}`, `<sc-for>`,
`<sc-if>` and a small logic class per screen, laid out by `canvas.json`). They need the design canvas
runtime to render and are not standalone pages; read them as annotated mockups. Names, domains and
figures in them are examples.

Status: ✅ implemented · 🟡 partly (what is missing is listed) · ⬜ design only

## Admin portal

| Screen | File | Status |
|---|---|---|
| Multi-host dashboard | `Main.dc.html` | ✅ Overview tab: KPIs per permission, nodes with load, alerts, latest activity (all clusters; trends and plan suspensions missing) |
| Guests (all hosts) | `Admin-Guests.dc.html` | 🟡 Servers tab; host grouping and bulk actions missing |
| Plans | `Admin-Plans.dc.html` | ✅ sizes with prices, GPU plans, retire, plans-only mode (plan bundles for object storage and IPs missing) |
| Networking & IPAM | `Admin-IPAM.dc.html` | ✅ customer networks (SDN), public IPv4 pools, addresses, reservations, cool-down, reverse DNS, optional IPv6 (/64 per address, global switch) (floating IPs missing) |
| Billing overview, invoice detail | `Admin-Billing.dc.html`, `Admin-Invoice.dc.html` | ✅ KPIs, filters, confirm transfer, cancel, wallet adjustment, fixed price (refunds to card and dunning steps missing) |
| Hosts & onboarding (owner only) | `Admin-Hosts.dc.html` | ✅ clusters (connect with test, TLS pin, conflicts, disable, remove), nodes, version, load, maintenance; existing guests are adopted by assigning them in Servers (bulk import wizard missing) |
| OS templates (owner only) | `Admin-Templates.dc.html` | 🟡 offering templates, owner-only changes; import wizard (qcow2, vmdk, ova, iso) and telemetry missing |
| Provisioning jobs | `Admin-Jobs.dc.html` | ✅ Jobs tab: servers being set up, reinstalled, deleted or failed, update runs, rollouts, finished work of 7 days (retry for failed deletions, update runs and automatic snapshots; step list missing) |
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
| Settings & white label (owner only) | `Admin-Settings.dc.html` | 🟡 branding, single sign-on, appearance, updates, email, expiry; Proxmox clusters, Proxmox Backup Server missing |
| Patch management | `Admin-Updates.dc.html` | ✅ fleet view (last run, never, older than 30 days, failed), rollouts in rings with failure limit, pause/resume/cancel, customer emails, pending-update counts (Check now), maintenance windows |
| Server lifecycle (expiry) | `Admin-Lifecycle.dc.html` | 🟡 rules, reminders, stop, grace, deletion, pause; queue view missing |

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
