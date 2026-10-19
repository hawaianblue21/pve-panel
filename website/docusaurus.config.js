// Documentation website for PVE Panel, published on GitHub Pages:
// https://hawaianblue21.github.io/pve-panel/
import { themes as prismThemes } from 'prism-react-renderer';

const repo = 'https://github.com/hawaianblue21/pve-panel';

/** @type {import('@docusaurus/types').Config} */
export default {
  title: 'PVE Panel',
  tagline: 'A modern self-service portal for Proxmox VE',
  favicon: 'img/favicon.svg',

  url: 'https://hawaianblue21.github.io',
  baseUrl: '/pve-panel/',
  organizationName: 'hawaianblue21',
  projectName: 'pve-panel',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'warn',

  // .md = plain Markdown (text like <host-ip> or {…} is fine); .mdx = MDX
  markdown: {
    format: 'detect',
    hooks: { onBrokenMarkdownLinks: 'throw' },
  },

  // Screenshots live once, in the repository's docs/screenshots folder
  staticDirectories: ['static', '../docs/screenshots'],

  i18n: { defaultLocale: 'en', locales: ['en'] },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: './sidebars.js',
          editUrl: `${repo}/edit/main/website/`,
          // Page dates come from Git history; the GitHub workflow has it (CI=true)
          showLastUpdateTime: !!process.env.CI,
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      }),
    ],
  ],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      { hashed: true, indexBlog: false, docsRouteBasePath: '/docs', highlightSearchTermsOnTargetPage: true },
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: { respectPrefersColorScheme: true },
      navbar: {
        title: 'PVE Panel',
        logo: { alt: 'PVE Panel', src: 'img/logo.svg' },
        items: [
          { type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Documentation' },
          { to: '/docs/getting-started/quick-start', label: 'Quick start', position: 'left' },
          { href: `${repo}/releases`, label: 'Releases', position: 'right' },
          { href: repo, label: 'GitHub', position: 'right' },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Documentation',
            items: [
              { label: 'Introduction', to: '/docs/intro' },
              { label: 'Quick start', to: '/docs/getting-started/quick-start' },
              { label: 'Security model', to: '/docs/security/security-model' },
            ],
          },
          {
            title: 'Project',
            items: [
              { label: 'GitHub', href: repo },
              { label: 'Releases', href: `${repo}/releases` },
              { label: 'Container image', href: `${repo}/pkgs/container/pve-panel` },
              { label: 'Issues', href: `${repo}/issues` },
            ],
          },
          {
            title: 'About',
            items: [{ label: 'AI-assisted development', to: '/docs/about/ai-assisted-development' }],
          },
        ],
        copyright: `PVE Panel · Built with Docusaurus`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['bash', 'powershell', 'nginx', 'yaml', 'ini', 'json', 'batch'],
      },
    }),
};
