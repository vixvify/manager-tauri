import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Project, ProjectInput, ProjectRuntimeState, Service, ServiceLogEntry, ServiceRuntimeState, ServiceStatus } from "@devdeck/shared";
import { getTauriErrorMessage } from "./lib/tauri/errors";
import { subscribeToDevDeckEvents } from "./lib/tauri/events";
import { getRuntime, getServiceLogs, restartService, startProject, startService, stopProject, stopService } from "./lib/tauri/processes";
import { addProject, getProjects, removeProject as removeRegisteredProject, reorderProjects, updateProject } from "./lib/tauri/projects";

type ConnectionState = "checking" | "online" | "offline";
type ModalMode = "create" | "edit" | null;
type ProjectForm = Omit<ProjectInput, "services"> & { services: Service[] };
type ProcessAction = "start" | "stop" | "restart";
type LogSocketState = "connecting" | "connected" | "disconnected";

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

const statusDotClasses: Record<ConnectionState | ServiceStatus, string> = {
  online: "bg-[#7ee2ae] shadow-[0_0_0_3px_rgba(126,226,174,0.1),0_0_12px_rgba(126,226,174,0.35)]",
  running: "bg-[#7ee2ae] shadow-[0_0_0_3px_rgba(126,226,174,0.1),0_0_12px_rgba(126,226,174,0.35)]",
  checking: "bg-[#d7b574]",
  starting: "bg-[#d7b574] shadow-[0_0_0_3px_rgba(215,181,116,0.1)]",
  offline: "bg-[#c87979]",
  error: "bg-[#c87979] shadow-[0_0_0_3px_rgba(200,121,121,0.1)]",
  stopping: "bg-[#c5a46c] shadow-[0_0_0_3px_rgba(197,164,108,0.1)]",
  stopped: "bg-[#687672]"
};

const runtimeBadgeClasses: Record<ServiceStatus, string> = {
  stopped: "text-[#718078]",
  starting: "text-[#d7b574]",
  running: "text-[#83d7a8]",
  stopping: "text-[#d7b574]",
  error: "text-[#d18484]"
};

const portClasses: Record<NonNullable<ServiceRuntimeState["portStatus"]>, string> = {
  unknown: "text-[#8bd4a8]",
  checking: "text-[#8bd4a8]",
  listening: "text-[#8bd4a8]",
  available: "text-[#d1a36f]",
  occupied: "text-[#d18484]"
};

const primaryButtonClass = "inline-flex min-h-[35px] items-center justify-center gap-2 rounded-md bg-[#8de1b8] px-[14px] text-[11px] font-semibold text-[#0c1611] shadow-[0_0_18px_rgba(141,225,184,0.08)] transition hover:bg-[#b0f0cd] disabled:cursor-wait disabled:opacity-55";
const secondaryButtonClass = "inline-flex min-h-[35px] items-center justify-center gap-2 rounded-md border border-[#365544] bg-[#17241f] px-[14px] text-[11px] font-semibold text-[#c9e3d1] transition hover:border-[#639176] hover:bg-[#1c3027] disabled:cursor-wait disabled:opacity-55";
const ghostButtonClass = "inline-flex min-h-[35px] items-center justify-center gap-2 rounded-md border border-[#2b3733] bg-[#111619] px-3 text-[11px] text-[#a1aea8] transition hover:border-[#527664] hover:bg-[#16221d] hover:text-[#dcebe2] disabled:cursor-wait disabled:opacity-55";
const dangerButtonClass = "inline-flex min-h-[35px] items-center justify-center gap-2 rounded-md border border-[#4b3032] bg-[#211719] px-[14px] text-[11px] font-semibold text-[#d89595] transition hover:border-[#75474a] hover:bg-[#2b1b1e] hover:text-[#f0b0b0] disabled:cursor-wait disabled:opacity-55";
const textButtonClass = "border-0 bg-transparent px-0 py-[3px] text-[11px] text-[#8bcaa4] transition hover:text-[#b9efd0]";
const eyebrowClass = "font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#687672]";

function StatusDot({ state }: { state: ConnectionState | ServiceStatus }) {
  return <span className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${statusDotClasses[state]}`} aria-hidden="true" />;
}

function statusLabel(status: ServiceStatus) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function portStatusLabel(status: ServiceRuntimeState["portStatus"]) {
  return status === "listening" ? "listening" : status === "checking" ? "checking" : status === "occupied" ? "occupied" : status === "available" ? "not listening" : "";
}

export function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("checking");
  const [projects, setProjects] = useState<Project[]>([]);
  const [runtime, setRuntime] = useState<ProjectRuntimeState[]>([]);
  const [serviceLogs, setServiceLogs] = useState<Record<string, ServiceLogEntry[]>>({});
  const [selectedLogServiceId, setSelectedLogServiceId] = useState<string | null>(null);
  const [logSocketState, setLogSocketState] = useState<LogSocketState>("disconnected");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isProjectsLoading, setIsProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [form, setForm] = useState<ProjectForm>(createEmptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [processAction, setProcessAction] = useState<string | null>(null);
  const [reorderingProjectId, setReorderingProjectId] = useState<string | null>(null);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedRuntime = runtime.find((state) => state.projectId === selectedProjectId);
  const selectedLogService = selectedProject?.services.find((service) => service.id === selectedLogServiceId) ?? null;

  const loadProjects = useCallback(async () => {
    setIsProjectsLoading(true);
    setProjectsError(null);

    try {
      const loadedProjects = await getProjects();
      setProjects(loadedProjects);
      setConnectionState("online");
      setSelectedProjectId((currentId) => currentId && loadedProjects.some((project) => project.id === currentId)
        ? currentId
        : loadedProjects[0]?.id ?? null);
    } catch (error) {
      setConnectionState("offline");
      setProjectsError(getTauriErrorMessage(error, "Unable to load projects."));
    } finally {
      setIsProjectsLoading(false);
    }
  }, []);

  const loadRuntime = useCallback(async () => {
    try {
      setRuntime(await getRuntime());
      setConnectionState("online");
    } catch {
      setConnectionState("offline");
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    void loadRuntime();
    const interval = window.setInterval(() => {
      void loadRuntime();
    }, 2000);

    return () => window.clearInterval(interval);
  }, [loadProjects, loadRuntime]);

  useEffect(() => {
    if (!selectedProjectId) {
      setLogSocketState("disconnected");
      return;
    }

    setLogSocketState("connecting");
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToDevDeckEvents(
      (payload) => {
        if (!disposed && payload.projectId === selectedProjectId) {
          setLogSocketState("connected");
          setServiceLogs((current) => {
            const entries = [...(current[payload.serviceId] ?? []), payload];
            return { ...current, [payload.serviceId]: entries.slice(-500) };
          });
        }
      },
      (payload) => {
        if (!disposed && payload.projectId === selectedProjectId) {
          void loadRuntime();
        }
      }
    ).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unsubscribe = unlisten;
        setLogSocketState("connected");
      }
    }).catch(() => setLogSocketState("disconnected"));

    return () => {
      disposed = true;
      unsubscribe?.();
      setLogSocketState("disconnected");
    };
  }, [loadRuntime, selectedProjectId]);

  useEffect(() => {
    setSelectedLogServiceId(null);
    setServiceLogs({});
  }, [selectedProjectId]);

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
        ? await updateProject(selectedProject.id, payload)
        : await addProject(payload);

      setProjects((current) => modalMode === "edit"
        ? current.map((project) => project.id === savedProject.id ? savedProject : project)
        : [...current, savedProject]);
      setSelectedProjectId(savedProject.id);
      setModalMode(null);
    } catch (error) {
      setFormError(getTauriErrorMessage(error, "Unable to save project."));
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
      await removeRegisteredProject(project.id);
      const remainingProjects = projects.filter((candidate) => candidate.id !== project.id);
      setProjects(remainingProjects);
      setSelectedProjectId((currentId) => currentId === project.id ? remainingProjects[0]?.id ?? null : currentId);
    } catch (error) {
      setProjectsError(getTauriErrorMessage(error, "Unable to remove project."));
    } finally {
      setDeletingProjectId(null);
    }
  }

  async function moveProject(projectId: string, direction: "up" | "down") {
    const currentIndex = projects.findIndex((project) => project.id === projectId);
    const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= projects.length || reorderingProjectId) {
      return;
    }

    const reorderedProjects = [...projects];
    [reorderedProjects[currentIndex], reorderedProjects[nextIndex]] = [reorderedProjects[nextIndex], reorderedProjects[currentIndex]];
    setReorderingProjectId(projectId);

    try {
      const savedProjects = await reorderProjects(reorderedProjects.map((project) => project.id));
      setProjects(savedProjects);
    } catch (error) {
      setProjectsError(getTauriErrorMessage(error, "Unable to reorder projects."));
    } finally {
      setReorderingProjectId(null);
    }
  }

  function getServiceRuntime(serviceId: string): ServiceRuntimeState {
    return selectedRuntime?.services[serviceId] ?? { serviceId, status: "stopped" };
  }

  async function runServiceAction(projectId: string, serviceId: string, action: ProcessAction) {
    const actionKey = `${projectId}:${serviceId}`;
    setProcessAction(actionKey);

    try {
      if (action === "start") {
        await startService(projectId, serviceId);
      } else if (action === "stop") {
        await stopService(projectId, serviceId);
      } else {
        await restartService(projectId, serviceId);
      }
      await loadRuntime();
    } catch (error) {
      setProjectsError(getTauriErrorMessage(error, `Unable to ${action} service.`));
      await loadRuntime();
    } finally {
      setProcessAction(null);
    }
  }

  async function runProjectAction(projectId: string, action: "start" | "stop") {
    setProcessAction(`${projectId}:all`);

    try {
      if (action === "start") {
        await startProject(projectId);
      } else {
        await stopProject(projectId);
      }
      await loadRuntime();
    } catch (error) {
      setProjectsError(getTauriErrorMessage(error, `Unable to ${action} project.`));
      await loadRuntime();
    } finally {
      setProcessAction(null);
    }
  }

  async function selectLogService(projectId: string, serviceId: string) {
    setSelectedLogServiceId(serviceId);

    if (serviceLogs[serviceId]) {
      return;
    }

    try {
      const history = await getServiceLogs(projectId, serviceId);
      setServiceLogs((current) => ({ ...current, [serviceId]: history }));
    } catch (error) {
      setProjectsError(getTauriErrorMessage(error, "Unable to load service logs."));
    }
  }

  const connectionLabel = {
    checking: "Checking native bridge",
    online: "Tauri commands ready",
    offline: "Tauri commands unavailable"
  }[connectionState];

  return (
    <main className="grid min-h-screen grid-cols-[248px_minmax(0,1fr)] bg-[radial-gradient(circle_at_75%_-20%,rgba(55,78,71,0.18),transparent_38%),#0b0d10]">
      <aside className="flex flex-col border-r border-[#1b2223] bg-[rgba(12,15,17,0.88)] px-[18px] pb-6 pt-7">
        <div className="flex items-center gap-3 px-2 pb-8 pt-1">
          <div className="grid h-[30px] w-[30px] grid-cols-3 items-end gap-[3px] rounded-lg border border-[#34483f] bg-[#17241f] p-1.5" aria-hidden="true"><span className="block h-[9px] rounded-[2px_2px_1px_1px] bg-[#8de1b8] opacity-55" /><span className="block h-[14px] rounded-[2px_2px_1px_1px] bg-[#8de1b8]" /><span className="block h-[11px] rounded-[2px_2px_1px_1px] bg-[#8de1b8] opacity-75" /></div>
          <div>
            <p className="text-[15px] font-semibold tracking-[-0.01em] text-[#f1f4f0]">DevDeck</p>
            <p className="mt-0.5 text-[10px] uppercase tracking-[0.04em] text-[#687672]">Local development cockpit</p>
          </div>
        </div>

        <nav className="grid gap-[5px]" aria-label="Primary navigation">
          <a className="flex min-h-10 items-center gap-2.5 rounded-[7px] border border-[#293c35] bg-[#17231f] px-[11px] text-[13px] text-[#e3ebe6] no-underline" href="#projects">
            <span className="w-[17px] text-center text-[17px] leading-none text-[#7dcba1]" aria-hidden="true">[]</span>
            Projects
            <span className="ml-auto font-mono text-[11px] text-[#61716a]">{projects.length}</span>
          </a>
          <a className="flex min-h-10 items-center gap-2.5 rounded-[7px] border border-transparent px-[11px] text-[13px] text-[#56615d] no-underline" href="#activity">
            <span className="w-[17px] text-center text-[17px] leading-none text-[#7dcba1]" aria-hidden="true">o</span>
            Activity
            <span className="ml-auto text-[10px] uppercase text-[#4f5c57]">Soon</span>
          </a>
        </nav>

        <div className="mt-auto px-2">
          <div className="flex items-center gap-2 rounded-md border border-[#202b29] px-2.5 py-[9px] text-[11px] text-[#87958e]"><StatusDot state={connectionState} /><span>{connectionLabel}</span></div>
          <p className="mt-4 font-mono text-[9px] tracking-[0.11em] text-[#45524d]">DEVDECK / NATIVE RUST</p>
        </div>
      </aside>

      <section className="mx-auto w-full max-w-[1180px] px-[52px] pb-7 pt-[42px] max-[1050px]:px-8 max-[900px]:px-6">
        <header className="mb-[34px] flex items-center justify-between">
          <div>
            <p className={eyebrowClass}>Workspace</p>
            <h1 className="mt-[7px] text-[clamp(28px,4vw,38px)] font-semibold tracking-[-0.04em] text-[#f2f4f1]">Projects</h1>
          </div>
          <button className={primaryButtonClass} type="button" onClick={openCreateModal}>
            <span className="text-lg font-normal leading-none" aria-hidden="true">+</span>
            Add project
          </button>
        </header>

        {projectsError && <div className="mb-4 rounded-md border border-[#5a3436] bg-[#24181b] px-[13px] py-[11px] text-[11px] text-[#e3a2a2]" role="alert">{projectsError}</div>}

        <div className="grid min-h-[488px] grid-cols-[minmax(260px,0.72fr)_minmax(0,1.55fr)] overflow-hidden rounded-[10px] border border-[#202b29] bg-[#0f1416] max-[900px]:grid-cols-[260px_minmax(0,1fr)]" id="projects">
          <section className="border-r border-[#202b29]" aria-label="Registered projects">
            <div className="flex items-start justify-between border-b border-[#1c2725] px-5 pb-[18px] pt-[22px]">
              <div>
                <p className={eyebrowClass}>Registered workspace</p>
                <h3 className="mt-2 text-[15px] font-semibold tracking-[-0.04em] text-[#dfe8e2]">{projects.length === 0 ? "No projects" : `${projects.length} project${projects.length === 1 ? "" : "s"}`}</h3>
              </div>
              <span className="font-mono text-[9px] tracking-[0.12em] text-[#567367]">LOCAL</span>
            </div>

            {isProjectsLoading ? (
              <div className="grid min-h-[360px] place-items-center p-5 text-center text-[11px] text-[#697770]">Loading projects...</div>
            ) : projects.length === 0 ? (
              <div className="grid min-h-[360px] content-center justify-items-center gap-[11px] p-5 text-center text-[11px] text-[#697770]">
                <span className="grid h-[34px] w-[34px] place-items-center rounded-[7px] border border-[#2a4035] bg-[#17241f] text-[19px] text-[#8de1b8]" aria-hidden="true">+</span>
                <p>Your project registry is empty.</p>
                <button className={textButtonClass} type="button" onClick={openCreateModal}>Register a project</button>
              </div>
            ) : (
              <div className="grid gap-0.5 p-2">
                {projects.map((project) => (
                  <article
                    className={`project-row ${project.id === selectedProjectId ? "project-row--selected" : ""}`}
                    key={project.id}
                    onClick={() => setSelectedProjectId(project.id)}
                  >
                    <div className="project-row__topline">
                      <h4>{project.name}</h4>
                      <div className="project-row__topline-right">
                        <span className={`runtime-badge runtime-badge--${runtime.find((state) => state.projectId === project.id)?.status ?? "stopped"}`}>
                          {statusLabel(runtime.find((state) => state.projectId === project.id)?.status ?? "stopped")}
                        </span>
                        <div className="project-reorder-controls" onClick={(event) => event.stopPropagation()}>
                          <button className="reorder-button" type="button" aria-label={`Move ${project.name} up`} disabled={projects.indexOf(project) === 0 || reorderingProjectId !== null} onClick={() => void moveProject(project.id, "up")}>↑</button>
                          <button className="reorder-button" type="button" aria-label={`Move ${project.name} down`} disabled={projects.indexOf(project) === projects.length - 1 || reorderingProjectId !== null} onClick={() => void moveProject(project.id, "down")}>↓</button>
                        </div>
                      </div>
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
                    <div className="detail-status"><StatusDot state={selectedRuntime?.status ?? "stopped"} /><span>{statusLabel(selectedRuntime?.status ?? "stopped")}</span></div>
                  </div>
                  <div className="detail-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={selectedProject.services.length === 0 || processAction !== null || selectedRuntime?.status === "running" || selectedRuntime?.status === "starting"}
                      onClick={() => void runProjectAction(selectedProject.id, "start")}
                    >
                      Start all
                    </button>
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={processAction !== null || (!selectedRuntime?.services || !Object.values(selectedRuntime.services).some((service) => service.status !== "stopped"))}
                      onClick={() => void runProjectAction(selectedProject.id, "stop")}
                    >
                      Stop all
                    </button>
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
                    {selectedProject.services.map((service) => {
                      const serviceRuntime = getServiceRuntime(service.id);
                      const actionKey = `${selectedProject.id}:${service.id}`;
                      const isBusy = processAction === actionKey || serviceRuntime.status === "starting" || serviceRuntime.status === "stopping";
                      const canStop = serviceRuntime.status === "running" || serviceRuntime.status === "starting" || serviceRuntime.status === "error";

                      return (
                        <article className="service-row" key={service.id}>
                          <div className="service-row__status"><StatusDot state={serviceRuntime.status} /><span>{statusLabel(serviceRuntime.status)}</span></div>
                          <div className="service-row__main">
                            <h4>{service.name}</h4>
                            <code>{service.command}</code>
                            {service.cwd && <span className="service-cwd">cwd {service.cwd}</span>}
                            {serviceRuntime.error && <span className="service-error">{serviceRuntime.error}</span>}
                          </div>
                          <div className="service-row__actions">
                            <button className="service-action" type="button" disabled={isBusy || canStop} onClick={() => void runServiceAction(selectedProject.id, service.id, "start")}>Start</button>
                            <button className="service-action" type="button" disabled={isBusy || !canStop} onClick={() => void runServiceAction(selectedProject.id, service.id, "stop")}>Stop</button>
                            <button className="service-action" type="button" disabled={isBusy || !canStop} onClick={() => void runServiceAction(selectedProject.id, service.id, "restart")}>Restart</button>
                            <button className={`service-action ${selectedLogServiceId === service.id ? "service-action--active" : ""}`} type="button" onClick={() => void selectLogService(selectedProject.id, service.id)}>Logs</button>
                          </div>
                          {service.port && <span className={`service-port service-port--${serviceRuntime.portStatus ?? "unknown"}`}>:{service.port} <small>{portStatusLabel(serviceRuntime.portStatus)}</small></span>}
                        </article>
                      );
                    })}
                  </div>
                )}

                {selectedLogService && (
                  <section className="log-viewer" aria-label={`${selectedLogService.name} logs`}>
                    <header className="log-viewer__header">
                      <div>
                        <p className="eyebrow">Live output</p>
                        <h3>{selectedLogService.name}</h3>
                      </div>
                      <div className="log-viewer__connection"><StatusDot state={logSocketState === "connected" ? "running" : logSocketState === "connecting" ? "starting" : "stopped"} /><span>{logSocketState}</span></div>
                    </header>
                    <div className="log-output">
                      {(serviceLogs[selectedLogService.id] ?? []).length === 0 ? (
                        <span className="log-output__empty">No output yet. Start the service to stream its terminal output.</span>
                      ) : (
                        serviceLogs[selectedLogService.id].map((entry, index) => (
                          <div className={`log-line log-line--${entry.stream}`} key={`${entry.timestamp}-${index}`}>
                            <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                            <span>{entry.message}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </section>
                )}

                <div className="detail-note">
                  <span className="detail-note__icon" aria-hidden="true">i</span>
                  <p>Output is kept in memory and limited to the latest 500 entries per service.</p>
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
          <span>React UI connected through Tauri IPC</span>
          <button className="text-button" type="button" onClick={() => { void loadProjects(); void loadRuntime(); }}>Refresh</button>
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
