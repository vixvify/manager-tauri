import { useCallback, useEffect, useState } from "react";
import type { HealthResponse } from "@devdeck/shared";

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://127.0.0.1:4317";

type ConnectionState = "checking" | "online" | "offline";

function StatusDot({ state }: { state: ConnectionState }) {
  return <span className={`status-dot status-dot--${state}`} aria-hidden="true" />;
}

export function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("checking");
  const [health, setHealth] = useState<HealthResponse | null>(null);

  const checkConnection = useCallback(async () => {
    setConnectionState("checking");

    try {
      const response = await fetch(`${serverUrl}/api/health`);

      if (!response.ok) {
        throw new Error(`Health check failed with status ${response.status}`);
      }

      const payload = (await response.json()) as HealthResponse;
      setHealth(payload);
      setConnectionState("online");
    } catch {
      setHealth(null);
      setConnectionState("offline");
    }
  }, []);

  useEffect(() => {
    void checkConnection();
    const interval = window.setInterval(() => void checkConnection(), 5000);

    return () => window.clearInterval(interval);
  }, [checkConnection]);

  const connectionLabel = {
    checking: "Checking backend",
    online: "Backend connected",
    offline: "Backend unavailable"
  }[connectionState];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="brand-name">DevDeck</p>
            <p className="brand-caption">Local development cockpit</p>
          </div>
        </div>

        <nav className="side-nav" aria-label="Primary navigation">
          <a className="side-nav__item side-nav__item--active" href="#projects">
            <span className="nav-icon" aria-hidden="true">▦</span>
            Projects
            <span className="nav-count">0</span>
          </a>
          <a className="side-nav__item side-nav__item--muted" href="#activity">
            <span className="nav-icon" aria-hidden="true">◌</span>
            Activity
            <span className="coming-soon">Soon</span>
          </a>
        </nav>

        <div className="sidebar-footer">
          <div className="connection-pill">
            <StatusDot state={connectionState} />
            <span>{connectionLabel}</span>
          </div>
          <p className="version-label">DEVDECK / PHASE 1</p>
        </div>
      </aside>

      <section className="content-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>Projects</h1>
          </div>
          <button className="ghost-button" type="button" onClick={() => void checkConnection()}>
            <span aria-hidden="true">↻</span>
            Check connection
          </button>
        </header>

        <div className="content-grid" id="projects">
          <section className="welcome-card">
            <div className="welcome-card__glow" aria-hidden="true" />
            <div className="welcome-card__content">
              <p className="eyebrow eyebrow--accent">Ready when you are</p>
              <h2>Your local projects,<br /><em>one calm surface.</em></h2>
              <p className="welcome-copy">
                DevDeck will keep your projects, services, and terminal output within reach.
                Add your first project in the next phase.
              </p>
              <div className="phase-progress" aria-label="Phase 1 foundation complete">
                <span className="phase-progress__bar"><span /></span>
                <span>Foundation connected</span>
              </div>
            </div>
            <div className="terminal-sample" aria-hidden="true">
              <div className="terminal-sample__bar"><span /><span /><span /> <small>devdeck — status</small></div>
              <p><b className="terminal-green">●</b> express server <strong>online</strong></p>
              <p><b className="terminal-green">●</b> desktop shell <strong>ready</strong></p>
              <p><b className="terminal-dim">›</b> waiting for projects...</p>
            </div>
          </section>

          <section className="status-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">System status</p>
                <h3>Local bridge</h3>
              </div>
              <StatusDot state={connectionState} />
            </div>
            <div className="status-card__body">
              <div className="status-line">
                <span className="status-line__label">Express API</span>
                <span className={`status-value status-value--${connectionState}`}>
                  {connectionState === "online" ? "Connected" : connectionState === "checking" ? "Checking" : "Offline"}
                </span>
              </div>
              <div className="status-line">
                <span className="status-line__label">Endpoint</span>
                <code>127.0.0.1:4317</code>
              </div>
              <div className="status-line">
                <span className="status-line__label">Last heartbeat</span>
                <span className="status-line__value">{health ? new Date(health.timestamp).toLocaleTimeString() : "—"}</span>
              </div>
            </div>
            <p className="status-card__hint">
              {connectionState === "online"
                ? "The desktop shell can reach your local backend."
                : "Start the local backend to enable the workspace."}
            </p>
          </section>
        </div>

        <section className="empty-state" id="activity">
          <div className="empty-state__icon" aria-hidden="true">⌘</div>
          <div>
            <p className="eyebrow">No projects yet</p>
            <h3>Your workspace is clear.</h3>
            <p>Project registration, service controls, and live logs are coming in the next phases.</p>
          </div>
        </section>

        <footer className="content-footer">
          <span>DevDeck is local-first.</span>
          <span>Nothing leaves this machine.</span>
        </footer>
      </section>
    </main>
  );
}
