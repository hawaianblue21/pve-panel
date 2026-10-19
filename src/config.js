import 'dotenv/config';

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable ${key} (see example.env)`);
  return value;
}

export const config = {
  // Product name shown in both interfaces (sign-in, sidebar, page titles)
  brand: {
    name: (process.env.PANEL_NAME || 'PVE Panel').trim().slice(0, 40),
    // Optional own icon files (os-windows.svg, os-linux.png, …); see the documentation: https://hawaianblue21.github.io/pve-panel
    dir: process.env.BRANDING_DIR || null,
  },
  // Customer panel
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  // Admin interface: separate server, local-only by default
  adminPort: Number(process.env.ADMIN_PORT || 3001),
  adminHost: process.env.ADMIN_HOST || '127.0.0.1',
  jwtSecret: required('JWT_SECRET'),
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  dbPath: process.env.DB_PATH || './data/panel.db',
  pve: {
    url: required('PVE_URL').replace(/\/+$/, ''),
    tokenId: required('PVE_TOKEN_ID'),
    tokenSecret: required('PVE_TOKEN_SECRET'),
    verifyTls: process.env.PVE_VERIFY_TLS !== 'false',
    caFile: process.env.PVE_CA_FILE || null,
    // Pool that customer servers (including newly created ones) belong to
    pool: process.env.PVE_POOL || 'customers',
  },
  // Private network per customer (Proxmox SDN simple zone with SNAT + DHCP)
  network: {
    enabled: process.env.CUSTOMER_NETWORKS === 'true',
    zone: process.env.SDN_ZONE || 'panel',
    prefix: process.env.CUSTOMER_NET_PREFIX || '10.100', // customers get <prefix>.<n>.0/24
    dns: process.env.CUSTOMER_NET_DNS || '1.1.1.1',
    // Destinations customer servers may NOT reach (your LAN, management and other
    // internal networks). The public internet stays reachable.
    blockedNets: (process.env.CUSTOMER_BLOCKED_NETS
      || '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16')
      .split(',').map((c) => c.trim()).filter(Boolean),
  },
  // Central WireGuard gateway for customer VPN access
  vpn: {
    enabled: process.env.VPN_ENABLED === 'true',
    gatewayVmid: Number(process.env.VPN_GATEWAY_VMID || 0),
    endpoint: process.env.VPN_ENDPOINT || '',                // public host:port customers connect to
    prefix: process.env.VPN_NET_PREFIX || '10.101',          // customer N's devices: <prefix>.N.0/24
    maxDevices: Number(process.env.VPN_MAX_DEVICES || 10),   // per customer
  },
  // Sign-in methods. OIDC: Authorization Code flow + PKCE (S256), state, nonce,
  // PAR when the provider supports it; tokens validated by openid-client.
  auth: {
    password: {
      customer: process.env.PASSWORD_LOGIN_CUSTOMER !== 'false',
      admin: process.env.PASSWORD_LOGIN_ADMIN !== 'false',
    },
  },
  oidc: {
    enabled: process.env.OIDC_ENABLED === 'true',
    issuer: (process.env.OIDC_ISSUER || '').trim(),
    clientId: (process.env.OIDC_CLIENT_ID || '').trim(),
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    portals: (process.env.OIDC_PORTALS || 'customer,admin').split(',').map((p) => p.trim()).filter(Boolean),
    label: (process.env.OIDC_BUTTON_LABEL || 'Sign in with single sign-on').trim().slice(0, 60),
    scopes: (process.env.OIDC_SCOPES || 'openid email profile').trim(),
    publicUrl: {
      customer: (process.env.PANEL_PUBLIC_URL || '').replace(/\/+$/, ''),
      admin: (process.env.ADMIN_PUBLIC_URL || '').replace(/\/+$/, ''),
    },
    allowedDomains: (process.env.OIDC_ALLOWED_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    requireVerifiedEmail: process.env.OIDC_REQUIRE_VERIFIED_EMAIL !== 'false',
    autoCreate: process.env.OIDC_AUTO_CREATE === 'true',
    trustIdpMfa: process.env.OIDC_TRUST_IDP_MFA !== 'false',
    par: (process.env.OIDC_USE_PAR || 'auto').toLowerCase(),     // auto | always | never
    allowInsecureHttp: process.env.OIDC_ALLOW_INSECURE_HTTP === 'true', // testing only
  },
  // Passkeys (WebAuthn): sign-in with fingerprint, face, device PIN or security key
  passkeys: {
    enabled: process.env.PASSKEYS_ENABLED !== 'false',
  },
  // Show the panel version to signed-in customers (sidebar + Account page)
  showVersionToCustomers: process.env.SHOW_VERSION_TO_CUSTOMERS !== 'false',
  // Customers can connect servers to their own Tailscale account (guest agent)
  tailscale: {
    enabled: process.env.TAILSCALE_ENABLED === 'true',
  },
  windows: {
    // How long Windows may sit at its setup (OOBE) screens before creation fails
    oobeTimeoutMs: Number(process.env.WINDOWS_OOBE_TIMEOUT_MINUTES || 15) * 60_000,
  },
  limits: {
    maxSnapshots: Number(process.env.MAX_SNAPSHOTS || 3),
  },
};

if (!/^[a-z][a-z0-9]{0,7}$/.test(config.network.zone)) {
  throw new Error('SDN_ZONE must be 1-8 lowercase letters/digits, starting with a letter');
}
if (!/^\d{1,3}\.\d{1,3}$/.test(config.network.prefix)) {
  throw new Error('CUSTOMER_NET_PREFIX must look like 10.100 (the first two octets)');
}

if (config.vpn.enabled) {
  if (!config.network.enabled) throw new Error('VPN_ENABLED needs CUSTOMER_NETWORKS=true');
  if (!config.vpn.gatewayVmid) throw new Error('VPN_ENABLED needs VPN_GATEWAY_VMID (the VMID of the gateway VM)');
  if (!/^[^\s:]+:\d+$/.test(config.vpn.endpoint)) throw new Error('VPN_ENDPOINT must look like vpn.example.com:51820');
  if (!/^\d{1,3}\.\d{1,3}$/.test(config.vpn.prefix)) throw new Error('VPN_NET_PREFIX must look like 10.101');
}

for (const cidr of config.network.blockedNets) {
  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr)) {
    throw new Error(`CUSTOMER_BLOCKED_NETS: "${cidr}" is not an IPv4 CIDR like 192.168.0.0/16`);
  }
}

if (config.oidc.enabled) {
  const o = config.oidc;
  if (!o.issuer || !o.clientId) throw new Error('OIDC_ENABLED needs OIDC_ISSUER and OIDC_CLIENT_ID');
  if (!/^https:\/\//.test(o.issuer) && !o.allowInsecureHttp) throw new Error('OIDC_ISSUER must use https://');
  for (const portal of o.portals) {
    if (!['customer', 'admin'].includes(portal)) throw new Error(`OIDC_PORTALS: unknown portal "${portal}" (use customer, admin)`);
    if (!o.publicUrl[portal]) {
      throw new Error(`OIDC for the ${portal} portal needs ${portal === 'admin' ? 'ADMIN_PUBLIC_URL' : 'PANEL_PUBLIC_URL'} `
        + '(the address your browser uses, e.g. https://panel.example.com), to build the callback URL');
    }
  }
  if (!['auto', 'always', 'never'].includes(o.par)) throw new Error('OIDC_USE_PAR must be auto, always or never');
}
for (const portal of ['customer', 'admin']) {
  const oidcHere = config.oidc.enabled && config.oidc.portals.includes(portal);
  if (!config.auth.password[portal] && !oidcHere) {
    throw new Error(`Password sign-in is off for the ${portal} portal and OIDC isn't enabled there: nobody could sign in`);
  }
}
