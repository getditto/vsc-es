// webview-ui/welcome/welcome-element.ts
//
// First-run onboarding for the Ditto Edge Studio extension. Walks the
// user through what Ditto is, what the extension does, and how to get
// their portal credentials so the Register Database flow doesn't drop
// them in front of an empty form with no idea what to type.
//
// External anchor hrefs are clicked through VS Code's default browser
// handler — the webview's CSP allows `https:` connect-src by default
// for navigation. We don't need `command:` URIs here.

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

type Msg = { type: 'welcome.init'; hasExistingDatabases: boolean };

interface Feature {
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    title: 'Multiple connections',
    body:
      'Register every Ditto app you work with — dev, staging, prod — and switch between them with one click.',
  },
  {
    title: 'DQL Query Editor',
    body:
      'Run Ditto Query Language statements with autocomplete, history, favourites, and EXPLAIN plans. ' +
      'Page through 21k-row result sets without locking up the UI.',
  },
  {
    title: 'Subscriptions',
    body:
      "Manage the queries that keep data flowing to this device. Import existing subscriptions from any peer that's already configured.",
  },
  {
    title: 'Presence Graph',
    body:
      'Visualise the live mesh in real time: every connected peer, the transports they’re using ' +
      '(LAN, Bluetooth, AWDL, WebSocket), and how data is routing through them.',
  },
  {
    title: 'Query & Database Metrics',
    body:
      'Per-DB dashboards that surface query execution plans, recent run history, and storage breakdown by collection — ' +
      'handy for diagnosing slow queries or runaway disk usage.',
  },
  {
    title: 'Import & Export',
    body:
      'Move JSON datasets between collections, peers, or environments. Export the entire result of a query (not just the ' +
      'visible page) to a portable JSON file, then re-import it anywhere.',
  },
  {
    title: 'Attachments',
    body:
      'Add, fetch, preview, and save binary attachments (images, audio, video, PDFs) right from the query results.',
  },
  {
    title: 'Inspector',
    body:
      "A side panel that follows your cursor: per-row JSON, per-query metrics, per-database storage details. " +
      "Survives view switches so you don't lose context.",
  },
];

@customElement('ditto-welcome')
export class WelcomeElement extends LitElement {
  /** Drives the heading tone. True when the user re-opened Welcome
   *  with a connection already configured — we soften "Get started"
   *  to "Reference" in that mode. */
  @state() private hasExistingDatabases = false;

  static styles = css`
    :host {
      display: block;
      max-width: 880px;
      margin: 0 auto;
      padding: 32px 40px 48px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      line-height: 1.55;
      font-size: 14px;
    }

    /* ─── Hero ─────────────────────────────────────────────── */
    .hero {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 28px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .hero-icon {
      width: 56px;
      height: 56px;
      flex: 0 0 56px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 12px;
      font-size: 28px;
      font-weight: 700;
    }
    .hero-text { min-width: 0; }
    .hero-title {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
      line-height: 1.2;
    }
    .hero-subtitle {
      margin: 4px 0 0;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }

    /* ─── Sections ─────────────────────────────────────────── */
    section { margin: 28px 0; }
    section > h2 {
      margin: 0 0 10px;
      font-size: 16px;
      font-weight: 600;
      letter-spacing: 0.01em;
    }
    section > p {
      margin: 0 0 12px;
      max-width: 70ch;
    }

    /* Feature grid — two columns on wider panels, one column on narrow. */
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    @media (max-width: 720px) {
      .feature-grid { grid-template-columns: 1fr; }
    }
    .feature {
      padding: 12px 14px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border);
    }
    .feature-title {
      font-weight: 600;
      font-size: 13px;
      margin: 0 0 4px;
      color: var(--vscode-foreground);
    }
    .feature-body {
      margin: 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    /* Step-by-step "Get Started" list. */
    .steps {
      list-style: none;
      margin: 0;
      padding: 0;
      counter-reset: step;
    }
    .step {
      display: flex;
      gap: 14px;
      padding: 14px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .step:last-child { border-bottom: none; }
    .step::before {
      counter-increment: step;
      content: counter(step);
      flex: 0 0 28px;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 50%;
      font-weight: 600;
      font-size: 13px;
    }
    .step-body { flex: 1; min-width: 0; }
    .step-title {
      margin: 0 0 4px;
      font-size: 14px;
      font-weight: 600;
    }
    .step-text {
      margin: 0 0 8px;
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
    }
    .step-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .step-link:hover { text-decoration: underline; }
    .step-link::after { content: '↗'; font-size: 11px; opacity: 0.7; }

    /* CTA cluster at the bottom of "Get Started". */
    .cta {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .cta button {
      padding: 8px 18px;
      cursor: pointer;
      border: none;
      border-radius: 3px;
      font: inherit;
      font-weight: 500;
    }
    .cta button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .cta button.primary:hover { background: var(--vscode-button-hoverBackground); }
    .cta button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    /* Inline links inside paragraphs. */
    a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }

    /* "What is Ditto" pull-quote-ish block. */
    .quote {
      padding: 14px 16px;
      border-left: 3px solid var(--vscode-button-background);
      background: var(--vscode-textCodeBlock-background);
      border-radius: 0 6px 6px 0;
      color: var(--vscode-foreground);
      font-size: 13px;
    }

    /* Footer / Learn-more strip. */
    .learn-more {
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .learn-more a { font-size: 12px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<Msg>((msg) => {
      if (msg.type === 'welcome.init') {
        this.hasExistingDatabases = msg.hasExistingDatabases;
      }
    });
  }

  private registerDatabase = (): void => {
    postToHost({ type: 'welcome.registerDatabase' });
  };

  private close = (): void => {
    postToHost({ type: 'welcome.close' });
  };

  render(): TemplateResult {
    return html`
      ${this.renderHero()}
      ${this.renderWhatIsDitto()}
      ${this.renderFeatures()}
      ${this.renderGetStarted()}
      ${this.renderLearnMore()}
    `;
  }

  private renderHero(): TemplateResult {
    return html`
      <div class="hero">
        <div class="hero-icon" aria-hidden="true">⌁</div>
        <div class="hero-text">
          <h1 class="hero-title">Welcome to Ditto Edge Studio</h1>
          <p class="hero-subtitle">
            ${this.hasExistingDatabases
              ? 'A quick reference for the Ditto extension and how to add another connection.'
              : 'A quick tour of what this extension does and how to connect your first Ditto app.'}
          </p>
        </div>
      </div>
    `;
  }

  private renderWhatIsDitto(): TemplateResult {
    return html`
      <section>
        <h2>What is Ditto?</h2>
        <p>
          Ditto is a peer-to-peer, offline-first database. Apps that embed the
          Ditto SDK sync data directly with each other over Bluetooth LE,
          peer-to-peer Wi-Fi, and local LAN — no internet required. When a
          network is available, devices can also sync to the Ditto cloud
          (the "Big Peer") for durability and global reach.
        </p>
        <div class="quote">
          The mesh keeps working when Wi-Fi goes down, devices roam in and out
          of range, or the cloud is unreachable. Every device holds a full
          replica of the data it cares about, and conflicts are resolved
          automatically using CRDTs — no merge UI, no lost writes.
        </div>
        <p style="margin-top: 12px;">
          Read the full primer:
          <a href="https://docs.ditto.live/home/about-ditto" target="_blank" rel="noopener">About Ditto ↗</a>
        </p>
      </section>
    `;
  }

  private renderFeatures(): TemplateResult {
    return html`
      <section>
        <h2>What this extension does</h2>
        <p>
          Ditto Edge Studio is a control panel for your Ditto apps — manage
          one or many database connections, inspect their live state, and
          move data in and out without ever leaving VS Code.
        </p>
        <div class="feature-grid">
          ${FEATURES.map(f => html`
            <div class="feature">
              <p class="feature-title">${f.title}</p>
              <p class="feature-body">${f.body}</p>
            </div>
          `)}
        </div>
      </section>
    `;
  }

  private renderGetStarted(): TemplateResult {
    return html`
      <section>
        <h2>${this.hasExistingDatabases ? 'Adding another connection' : 'Get started in three steps'}</h2>
        <ol class="steps">
          <li class="step">
            <div class="step-body">
              <p class="step-title">Sign up for the Ditto Portal</p>
              <p class="step-text">
                The Portal is where you create Ditto apps and generate the
                credentials this extension needs (a database ID, an auth
                URL, and an offline-license token).
              </p>
              <a
                class="step-link"
                href="https://docs.ditto.live/cloud/portal/creating-a-ditto-account"
                target="_blank" rel="noopener"
              >Create a Ditto Portal account</a>
            </div>
          </li>
          <li class="step">
            <div class="step-body">
              <p class="step-title">Create a new app</p>
              <p class="step-text">
                From the Portal, create an app. Its details page lists every
                value you'll paste into the Register dialog: the App ID
                (used as the Database ID), the Auth URL, the Websocket URL,
                the playground token, and the optional HTTP API key.
              </p>
              <a
                class="step-link"
                href="https://docs.ditto.live/cloud/portal/creating-a-new-app"
                target="_blank" rel="noopener"
              >Create a new app in the Portal</a>
            </div>
          </li>
          <li class="step">
            <div class="step-body">
              <p class="step-title">Register your first database in this extension</p>
              <p class="step-text">
                Click the button below. You'll get a form that asks for the
                values from step 2. The form has inline help for every
                field — and you can edit or delete the connection later
                from the Ditto tree view in the sidebar.
              </p>
              <div class="cta">
                <button class="primary" @click=${this.registerDatabase}>
                  Register Database…
                </button>
                <button class="secondary" @click=${this.close}>
                  ${this.hasExistingDatabases ? 'Close' : 'Maybe later'}
                </button>
              </div>
            </div>
          </li>
        </ol>
      </section>
    `;
  }

  private renderLearnMore(): TemplateResult {
    return html`
      <div class="learn-more">
        Want more depth? See the
        <a href="https://docs.ditto.live/home/about-ditto" target="_blank" rel="noopener">Ditto documentation</a>,
        the
        <a href="https://docs.ditto.live/dql/dql" target="_blank" rel="noopener">DQL reference</a>,
        and the
        <a href="https://docs.ditto.live/sdk/latest/sync/using-mesh-presence" target="_blank" rel="noopener">Mesh Presence guide</a>.
      </div>
    `;
  }
}
