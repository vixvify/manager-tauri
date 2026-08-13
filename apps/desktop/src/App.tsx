import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { HealthResponse, Project, ProjectInput, ProjectRuntimeState, Service, ServiceRuntimeState, ServiceStatus } from "@devdeck/shared";

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://127.0.0.1:4317";

type ConnectionState = "checking" | "online" | "offline";
type ModalMode = "create" | "edit" | null;
type ProjectForm = Omit<ProjectInput, "services"> & { services: Service[] };
type ProcessAction = "start" | "stop" | "restart";

function createId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function createEmptyForm(): ProjectForm {
  return { name: "", path: "", services: [] };
}

function createFormFromProject(project: Project): ProjectForm {
  return {
    name: project.name,
    path: project.path,
    services: project.services.map((service) => ({ ...service, cwd: service.cwd ?? "" }))
  };
}

async function apiRequest<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${serverUrl}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init
  });
  const rawBody = await response.text();
  let body: unknown = null;

  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
  }

  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return body as T;
}

function StatusDot({ state }: { state: ConnectionState | ServiceStatus }) {
  return <span className={`status-dot status-dot--${state}`} aria-hidden="true" />;
}

function statusLabel(status: ServiceStatus) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("checking");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [runtime, setRuntime] = useState<ProjectRuntimeState[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isProjectsLoading, setIsProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [form, setForm] = useState<ProjectForm>(createEmptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [processAction, setProcessAction] = useState<string | null>(null);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedRuntime = runtime.find((state) => state.projectId === selectedProjectId);

  const checkConnection = useCallback(async () => {
    setConnectionState("checking");

    try {
      const payload = await apiRequest<HealthResponse>("/api/health");
      setHealth(payload);
      setConnectionState("online");
    } catch {
      setHealth(null);
      setConnectionState("offline");
    }
  }, []);

  const loadProjects = useCallback(async () => {
    setIsProjectsLoading(true);
    setProjectsError(null);

    try {
      const loadedProjects = await apiRequest<Project[]>("/api/projects");
      setProjects(loadedProjects);
      setSelectedProjectId((currentId) => currentId && loadedProjects.some((project) => project.id === currentId)
        ? currentId
        : loadedProjects[0]?.id ?? null);
    } catch (error) {
      setProjectsError(error instanceof Error ? error.message : "Unable to load projects.");
    } finally {
      setIsProjectsLoading(false);
    }
  }, []);

  const loadRuntime = useCallback(async () => {
    try {
      setRuntime(await apiRequest<ProjectRuntimeState[]>("/api/runtime"));
    } catch {
      // The connection indicator and project load surface the backend error.
    }
  }, []);

  useEffect(() => {
    void checkConnection();
    void loadProjects();
    void loadRuntime();
    const interval = window.setInterval(() => {
      void checkConnection();
      void loadRuntime();
    }, 2000);

    return () => window.clearInterval(interval);
  }, [checkConnection, loadProjects, loadRuntime]);

  function openCreateModal() {
    setForm(createEmptyForm());
    setFormError(null);
    setModalMode("create");
  }

  function openEditModal(project: Project) {
    setForm(createFormFromProject(project));
    setFormError(null);
    setModalMode("edit");
  }

  function closeModal() {
    if (!isSaving) {
      setModalMode(null);
    }
  }

  function updateService(index: number, changes: Partial<Service>) {
    setForm((current) => ({
      ...current,
      services: current.services.map((service, serviceIndex) => serviceIndex === index ? { ...service, ...changes } : service)
    }));
  }

  function addService() {
    setForm((current) => ({
      ...current,
      services: [...current.services, { id: createId(), name: "", command: "", cwd: "" }]
    }));
  }

  function removeService(index: number) {
    setForm((current) => ({ ...current, services: current.services.filter((_service, serviceIndex) => serviceIndex !== index) }));
  }

  async function chooseProjectFolder() {
    try {
      const selectedPath = await open({ directory: true, multiple: false, title: "Select a project folder" });

      if (typeof selectedPath === "string") {
        setForm((current) => ({ ...current, path: selectedPath }));
      }
    } catch {
      setFormError("The native folder picker is unavailable. Enter the path manually.");
    }
  }

  async function saveProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setFormError(null);

    const payload: ProjectInput = {
      name: form.name,
      path: form.path,
      services: form.services.map((service) => ({
        id: modalMode === "edit" ? service.id : undefined,
        name: service.name,
        command: service.command,
        cwd: service.cwd?.trim() || undefined,
        port: service.port
      }))
    };

    try {
      const savedProject = modalMode === "edit" && selectedProject
        ? await apiRequest<Project>(`/api/projects/${selectedProject.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : await apiRequest<Project>("/api/projects", { method: "POST", body: JSON.stringify(payload) });

      setProjects((current) => modalMode === "edit"
        ? current.map((project) => project.id === savedProject.id ? savedProject : project)
        : [...current, savedProject]);
      setSelectedProjectId(savedProject.id);
      setModalMode(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to save project.");
    } finally {
      setIsSaving(false);
    }
  }

  async function removeProject(project: Project) {
    if (!window.confirm(`Remove ${project.name} from DevDeck? The local folder will not be deleted.`)) {
      return;
    }

    setDeletingProjectId(project.id);

    try {
      await apiRequest<void>(`/api/projects/${project.id}`, { method: "DELETE" });
      const remainingProjects = projects.filter((candidate) => candidate.id !== project.id);
      setProjects(remainingProjects);
      setSelectedProjectId((currentId) => currentId === project.id ? remainingProjects[0]?.id ?? null : currentId);
    } catch (error) {
      setProjectsError(error instanceof Error ? error.message : "Unable to remove project.");
    } finally {
      setDeletingProjectId(null);
    }
  }

  function getServiceRuntime(serviceId: string): ServiceRuntimeState {
    return selectedRuntime?.services[serviceId] ?? { serviceId, status: "stopped" };
  }

  async function runServiceAction(projectId: string, serviceId: string, action: ProcessAction) {
    const actionKey = `${projectId}:${serviceId}`;
    setProcessAction(actionKey);

    try {
      await apiRequest<ServiceRuntimeState>(`/api/projects/${projectId}/services/${serviceId}/${action}`, { method: "POST" });
      await loadRuntime();
    } catch (error) {
      setProjectsError(error instanceof Error ? error.message : `Unable to ${action} service.`);
      await loadRuntime();
    } finally {
      setProcessAction(null);
    }
  }

  async function runProjectAction(projectId: string, action: "start" | "stop") {
    setProcessAction(`${projectId}:all`);

    try {
      await apiRequest<ProjectRuntimeState>(`/api/projects/${projectId}/${action}`, { method: "POST" });
      await loadRuntime();
    } catch (error) {
      setProjectsError(error instanceof Error ? error.message : `Unable to ${action} project.`);
      await loadRuntime();
    } finally {
      setProcessAction(null);
    }
  }

  const connectionLabel = {
    checking: "Checking backend",
    online: "Backend connected",
    offline: "Backend unavailable"
  }[connectionState];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <p className="brand-name">DevDeck</p>
            <p className="brand-caption">Local development cockpit</p>
          </div>
        </div>

        <nav className="side-nav" aria-label="Primary navigation">
          <a className="side-nav__item side-nav__item--active" href="#projects">
            <span className="nav-icon" aria-hidden="true">[]</span>
            Projects
            <span className="nav-count">{projects.length}</span>
          </a>
          <a className="side-nav__item side-nav__item--muted" href="#activity">
            <span className="nav-icon" aria-hidden="true">o</span>
            Activity
            <span className="coming-soon">Soon</span>
          </a>
        </nav>

        <div className="sidebar-footer">
          <div className="connection-pill"><StatusDot state={connectionState} /><span>{connectionLabel}</span></div>
          <p className="version-label">DEVDECK / PHASE 2</p>
        </div>
      </aside>

      <section className="content-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>Projects</h1>
          </div>
          <button className="primary-button" type="button" onClick={openCreateModal}>
            <span aria-hidden="true">+</span>
            Add project
          </button>
        </header>

        {projectsError && <div className="inline-error" role="alert">{projectsError}</div>}

        <div className="workspace-layout" id="projects">
          <section className="project-list-panel" aria-label="Registered projects">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Registered workspace</p>
                <h3>{projects.length === 0 ? "No projects" : `${projects.length} project${projects.length === 1 ? "" : "s"}`}</h3>
              </div>
              <span className="panel-kicker">LOCAL</span>
            </div>

            {isProjectsLoading ? (
              <div className="list-placeholder">Loading projects...</div>
            ) : projects.length === 0 ? (
              <div className="list-placeholder list-placeholder--empty">
                <span className="empty-list-icon" aria-hidden="true">+</span>
                <p>Your project registry is empty.</p>
                <button className="text-button" type="button" onClick={openCreateModal}>Register a project</button>
              </div>
            ) : (
              <div className="project-list">
                {projects.map((project) => (
                  <article
                    className={`project-row ${project.id === selectedProjectId ? "project-row--selected" : ""}`}
                    key={project.id}
                    onClick={() => setSelectedProjectId(project.id)}
                  >
                    <div className="project-row__topline">
                      <h4>{project.name}</h4>
                      <span className="registered-badge">Registered</span>
                    </div>
                    <p className="project-row__path" title={project.path}>{project.path}</p>
                    <div className="project-row__meta">
                      <span>{project.services.length} service{project.services.length === 1 ? "" : "s"}</span>
                      {project.services.some((service) => service.port) && <span>Ports configured</span>}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="project-detail-panel" aria-label="Project details">
            {selectedProject ? (
              <>
                <header className="detail-heading">
                  <div>
                    <p className="eyebrow">Project detail</p>
                    <h2>{selectedProject.name}</h2>
                    <code className="detail-path" title={selectedProject.path}>{selectedProject.path}</code>
                  </div>
                  <div className="detail-actions">
                    <button className="ghost-button" type="button" onClick={() => openEditModal(selectedProject)}>Edit</button>
                    <button className="danger-button" type="button" disabled={deletingProjectId === selectedProject.id} onClick={() => void removeProject(selectedProject)}>
                      {deletingProjectId === selectedProject.id ? "Removing..." : "Remove"}
                    </button>
                  </div>
                </header>

                <div className="detail-section-heading">
                  <div>
                    <p className="eyebrow">Services</p>
                    <h3>{selectedProject.services.length === 0 ? "No services yet" : "Registered services"}</h3>
                  </div>
                  <button className="text-button" type="button" onClick={() => openEditModal(selectedProject)}>Edit services</button>
                </div>

                {selectedProject.services.length === 0 ? (
                  <div className="service-empty">
                    <p>Define the commands DevDeck will manage for this project.</p>
                    <button className="secondary-button" type="button" onClick={() => openEditModal(selectedProject)}>Add a service</button>
                  </div>
                ) : (
                  <div className="service-list">
                    {selectedProject.services.map((service) => (
                      <article className="service-row" key={service.id}>
                        <div className="service-row__status"><StatusDot state="offline" /><span>Stopped</span></div>
                        <div className="service-row__main">
                          <h4>{service.name}</h4>
                          <code>{service.command}</code>
                          {service.cwd && <span className="service-cwd">cwd {service.cwd}</span>}
                        </div>
                        {service.port && <span className="service-port">:{service.port}</span>}
                      </article>
                    ))}
                  </div>
                )}

                <div className="detail-note">
                  <span className="detail-note__icon" aria-hidden="true">i</span>
                  <p>Service controls and live logs will be connected in the next phase.</p>
                </div>
              </>
            ) : (
              <div className="detail-empty">
                <div className="empty-state__icon" aria-hidden="true">[]</div>
                <p className="eyebrow">No project selected</p>
                <h3>Register your first local project.</h3>
                <p>DevDeck stores only the project path and service configuration.</p>
                <button className="primary-button" type="button" onClick={openCreateModal}>Add project</button>
              </div>
            )}
          </section>
        </div>

        <section className="bridge-status" id="activity">
          <div><StatusDot state={connectionState} /><span>{connectionLabel}</span></div>
          <span>Last heartbeat {health ? new Date(health.timestamp).toLocaleTimeString() : "-"}</span>
          <button className="text-button" type="button" onClick={() => void checkConnection()}>Refresh</button>
        </section>

        <footer className="content-footer">
          <span>DevDeck is local-first.</span>
          <span>Nothing leaves this machine.</span>
        </footer>
      </section>

      {modalMode && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeModal}>
          <section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="project-modal-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-heading">
              <div>
                <p className="eyebrow">Project registry</p>
                <h2 id="project-modal-title">{modalMode === "create" ? "Add project" : "Edit project"}</h2>
              </div>
              <button className="modal-close" type="button" aria-label="Close" onClick={closeModal}>x</button>
            </header>

            <form onSubmit={(event) => void saveProject(event)}>
              <div className="form-grid">
                <label>
                  <span>Project name</span>
                  <input autoFocus required value={form.name} placeholder="ACS Portal" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
                </label>
                <label className="path-field">
                  <span>Project directory</span>
                  <div className="path-input-wrap">
                    <input required value={form.path} placeholder="C:/code/acs/acs-portal" onChange={(event) => setForm((current) => ({ ...current, path: event.target.value }))} />
                    <button className="browse-button" type="button" onClick={() => void chooseProjectFolder()}>Browse</button>
                  </div>
                </label>
              </div>

              <div className="service-editor-heading">
                <div>
                  <p className="eyebrow">Optional</p>
                  <h3>Services</h3>
                </div>
                <button className="text-button" type="button" onClick={addService}>+ Add service</button>
              </div>

              {form.services.length === 0 ? (
                <div className="service-editor-empty">No services configured. You can add them now or later.</div>
              ) : (
                <div className="service-editor-list">
                  {form.services.map((service, index) => (
                    <div className="service-editor-row" key={service.id}>
                      <div className="service-editor-row__heading"><span>Service {index + 1}</span><button className="remove-service" type="button" onClick={() => removeService(index)}>Remove</button></div>
                      <div className="service-editor-fields">
                        <label><span>Name</span><input required value={service.name} placeholder="Frontend" onChange={(event) => updateService(index, { name: event.target.value })} /></label>
                        <label><span>Command</span><input required value={service.command} placeholder="npm run dev" onChange={(event) => updateService(index, { command: event.target.value })} /></label>
                        <label><span>cwd <small>optional</small></span><input value={service.cwd ?? ""} placeholder="./frontend" onChange={(event) => updateService(index, { cwd: event.target.value })} /></label>
                        <label><span>Port <small>optional</small></span><input type="number" min="1" max="65535" value={service.port ?? ""} placeholder="3000" onChange={(event) => updateService(index, { port: event.target.value ? Number(event.target.value) : undefined })} /></label>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {formError && <div className="form-error" role="alert">{formError}</div>}
              <footer className="modal-footer">
                <button className="ghost-button" type="button" onClick={closeModal}>Cancel</button>
                <button className="primary-button" type="submit" disabled={isSaving}>{isSaving ? "Saving..." : "Save project"}</button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
