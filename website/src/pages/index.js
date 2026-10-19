import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const FEATURES = [
  ['Self-service, safely', 'Customers manage only their own VMs and containers: power, snapshots, console, usage graphs. The browser never sees Proxmox or its API token.'],
  ['Create, reinstall, resize', 'Linux (cloud-init) and Windows (guest agent) servers from your templates, within plans you set per customer.'],
  ['Isolated networks', 'A private SDN network per customer with DHCP and NAT, firewall isolation, and no way into your internal networks.'],
  ['Remote access', 'A central WireGuard gateway with per-customer access, or the customer’s own Tailscale tailnet.'],
  ['Modern sign-in', 'Passwords with TOTP 2FA and recovery codes, or OpenID Connect single sign-on with PKCE and PAR.'],
  ['Easy to run', 'One container for amd64 and arm64: Docker Compose, Portainer or a NAS. Releases and update checks built in.'],
];

export default function Home() {
  const shot = useBaseUrl('/customer-dashboard.png');
  return (
    <Layout title="Self-service portal for Proxmox VE" description="PVE Panel: a modern self-service portal for Proxmox VE">
      <header className={styles.hero}>
        <div className="container">
          <h1 className={styles.title}>PVE Panel</h1>
          <p className={styles.tagline}>
            A modern self-service portal for Proxmox VE. Give customers a clean, secure interface to
            manage <strong>only their own</strong> virtual machines and containers.
          </p>
          <div className={styles.buttons}>
            <Link className="button button--primary button--lg" to="/docs/getting-started/quick-start">Quick start</Link>
            <Link className="button button--secondary button--lg" to="/docs/intro">Documentation</Link>
            <Link className={`button button--outline button--lg ${styles.ghost}`} href="https://github.com/hawaianblue21/pve-panel">GitHub</Link>
          </div>
        </div>
      </header>
      <main>
        <section className="container">
          <div className={styles.grid}>
            {FEATURES.map(([title, text]) => (
              <div key={title} className={styles.card}>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
          <img className={`screenshot ${styles.shot}`} src={shot} alt="PVE Panel customer dashboard" />
          <p className={styles.note}>
            Built with substantial AI assistance — see <Link to="/docs/about/ai-assisted-development">AI-assisted development</Link>.
          </p>
        </section>
      </main>
    </Layout>
  );
}
