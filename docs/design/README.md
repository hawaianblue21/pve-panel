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
| Multi-host dashboard | `Main.dc.html` | ⬜ (today: the Servers tab) |
| Guests (all hosts) | `Admin-Guests.dc.html` | 🟡 Servers tab; host grouping and bulk actions missing |
| Plans | `Admin-Plans.dc.html` | ⬜ |
| Networking & IPAM | `Admin-IPAM.dc.html` | 🟡 customer networks (SDN); IP address management missing |
| Billing overview, invoice detail | `Admin-Billing.dc.html`, `Admin-Invoice.dc.html` | ⬜ |
| Hosts & onboarding (owner only) | `Admin-Hosts.dc.html` | ⬜ |
| OS templates (owner only) | `Admin-Templates.dc.html` | 🟡 offering templates, owner-only changes; import wizard (qcow2, vmdk, ova, iso) and telemetry missing |
| Provisioning jobs | `Admin-Jobs.dc.html` | 🟡 progress per server; job list missing |
| In-browser console | `Admin-Console.dc.html` | ✅ |
| Access & roles (RBAC) | `Admin-Access.dc.html` | ✅ |
| Resource allocation pools | `Admin-Pools.dc.html` | ✅ |
| Object storage (SeaweedFS) | `Admin-Storage.dc.html` | ✅ |
| GPU compute | `Admin-GPU.dc.html` | ✅ |
| Customers & behaviour | `Admin-Customers.dc.html` | 🟡 customer list and limits; behaviour profile and signals missing |
| Activity log | `Admin-Activity.dc.html` | ✅ filters by actor, kind and text, event details, paging (diff view missing) |
| Ticket desk (Zammad), AI assistant, knowledge base editor | `Admin-Support.dc.html`, `Admin-AI.dc.html`, `Admin-KB.dc.html` | ⬜ |
| API tokens & integrations (owner only) | `Admin-Integrations.dc.html` | ⬜ |
| Settings & white label (owner only) | `Admin-Settings.dc.html` | 🟡 branding, single sign-on, appearance, updates, email, expiry; Proxmox clusters, Proxmox Backup Server missing |
| Patch management | `Admin-Updates.dc.html` | 🟡 Windows/Linux switches, per-server runs and log; fleet view and rollout rings missing |
| Server lifecycle (expiry) | `Admin-Lifecycle.dc.html` | 🟡 rules, reminders, stop, grace, deletion, pause; queue view missing |

## Customer portal

| Screen | File | Status |
|---|---|---|
| My servers, server detail, create server | `Customer-Servers.dc.html`, `Customer-Server.dc.html`, `Customer-Create.dc.html` | ✅ |
| OS updates (Windows + Linux) | `Customer-Updates.dc.html` | ✅ weekly automatic window missing |
| Renewals & expiry | `Customer-Expiry.dc.html` | 🟡 expiry banner and one free extension; paid renewal and auto-renew need billing |
| Appearance & sign-in methods | `Customer-Preferences.dc.html` | ✅ density, language and time zone missing |
| Sign in with single sign-on | `Customer-SignIn.dc.html` | ✅ company-domain enforcement missing |
| Network & VPN | `Customer-Network.dc.html` | ✅ |
| Security & 2FA | `Customer-Security.dc.html` | ✅ |
| Billing & wallet, invoice & pay | `Customer-Billing.dc.html`, `Customer-Invoice.dc.html` | ⬜ |
| Block storage | `Customer-Block.dc.html` | ⬜ |
| Object storage | `Customer-Object.dc.html` | 🟡 API (`/api/storage`); customer screen missing |
| Support tickets, AI assistant, knowledge base | `Customer-Tickets.dc.html`, `Customer-Assistant.dc.html`, `Customer-KB.dc.html` | ⬜ |

## Shared

| | File |
|---|---|
| Sidebar component (both portals) | `Sidebar.dc.html` |
| Support flow: knowledge base → AI assistant → ticket → helpdesk → knowledge base | `Admin-SupportFlow.dc.html` |
| Canvas layout | `canvas.json` |
