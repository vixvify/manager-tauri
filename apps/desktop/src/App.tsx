import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { GitBranch, Project, ProjectInput, ProjectRuntimeState, Service, ServiceLogEntry, ServiceRuntimeState, ServiceStatus } from "@devdeck/shared";
import { getTauriErrorMessage } from "./lib/tauri/errors";
import { subscribeToDevDeckEvents } from "./lib/tauri/events";
import { getGitBranches, pullProject } from "./lib/tauri/git";
import { buildService, getRuntime, getServiceLogs, restartService, startProject, startService, stopProject, stopService } from "./lib/tauri/processes";
import { addProject, getProjects, removeProject as removeRegisteredProject, reorderProjects, updateProject } from "./lib/tauri/projects";
import { openServiceUrl } from "./lib/tauri/system";

type ConnectionState = "checking" | "online" | "offline";
type ModalMode = "create" | "edit" | null;
type ProjectForm = Omit<ProjectInput, "services"> & { services: Service[] };
type ProcessAction = "start" | "stop" | "restart" | "build";
type LogSocketState = "connecting" | "connected" | "disconnected";
type ActivityKind = "start" | "stop" | "restart" | "build" | "pull" | "status" | "project" | "error";
type ActivityState = "working" | "success" | "error" | "info";

interface ActivityEntry {
  id: string;
  timestamp: string;
  projectId?: string;
  projectName: string;
  serviceName?: string;
  kind: ActivityKind;
  state: ActivityState;
  message: string;
}

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
    services: project.services.map((service) => ({ ...service, buildCommand: service.buildCommand ?? "", cwd: service.cwd ?? "" }))
  };
}

const statusDotClasses: Record<ConnectionState | ServiceStatus, string> = {
  online: "bg-[#83cda3]",
  running: "bg-[#83cda3]",
  checking: "bg-[#d7b574]",
  starting: "bg-[#d7b574]",
  offline: "bg-[#c87979]",
  error: "bg-[#c87979]",
  stopping: "bg-[#c5a46c]",
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

const primaryButtonClass = "inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-[#c9dcf7] px-3.5 text-xs font-semibold text-[#17202b] transition hover:bg-[#d7e6fb] disabled:cursor-wait disabled:opacity-50";
const secondaryButtonClass = "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-[#41505f] bg-[#252d36] px-3.5 text-xs font-semibold text-[#d6e0eb] transition hover:border-[#657f9b] hover:bg-[#2c3844] disabled:cursor-wait disabled:opacity-50";
const ghostButtonClass = "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-[#343b44] bg-transparent px-3 text-xs text-[#b7c0ca] transition hover:border-[#667381] hover:bg-[#20262d] hover:text-[#edf2f7] disabled:cursor-wait disabled:opacity-50";
const dangerButtonClass = "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-[#633d42] bg-transparent px-3.5 text-xs font-semibold text-[#edb0b0] transition hover:border-[#9a5d63] hover:bg-[#382328] disabled:cursor-wait disabled:opacity-50";
const textButtonClass = "border-0 bg-transparent px-0 py-1 text-xs text-[#a9c6ea] transition hover:text-[#d8e8fb] disabled:cursor-wait disabled:opacity-50";
const eyebrowClass = "text-[10px] font-semibold uppercase tracking-[0.16em] text-[#73837b]";

function StatusDot({ state }: { state: ConnectionState | ServiceStatus }) {
  return <span className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${statusDotClasses[state]}`} aria-hidden="true" />;
}

function LoadingSpinner({ label = "กำลังโหลด", small = false }: { label?: string; small?: boolean }) {
  return <span className="inline-flex items-center gap-2" role="status"><span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${small ? "h-3 w-3" : "h-4 w-4"}`} aria-hidden="true" /><span>{label}</span></span>;
}

function ErrorBanner({ message, compact = false, onDismiss }: { message: string; compact?: boolean; onDismiss?: () => void }) {
  return <div className={`flex items-start gap-2.5 rounded-md border border-[#693d42] bg-[#2a1b20] text-[#f0b5b5] ${compact ? "px-3 py-2 text-[10px]" : "px-3.5 py-3 text-[11px]"}`} role="alert">
    <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-[#a3656b] text-[10px] font-semibold" aria-hidden="true">!</span>
    <span className="min-w-0 flex-1">{message}</span>
    {onDismiss && <button className="-mr-1 -mt-1 grid h-6 w-6 shrink-0 place-items-center rounded text-base leading-none text-[#d99a9e] transition hover:bg-[#42282d] hover:text-[#ffe1e1]" type="button" aria-label="ปิดข้อความผิดพลาด" title="ปิด" onClick={onDismiss}>×</button>}
  </div>;
}

function statusLabel(status: ServiceStatus) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function portStatusLabel(status: ServiceRuntimeState["portStatus"]) {
  return status === "listening" ? "listening" : status === "checking" ? "checking" : status === "occupied" ? "occupied" : status === "available" ? "not listening" : "";
}

function extractLocalUrl(message: string) {
  const match = message.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/i)
    ?? message.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/i);
  if (!match) {
    return null;
  }

  const value = match[0].startsWith("http") ? match[0] : `http://${match[0]}`;
  return value.replace("127.0.0.1", "localhost").replace("0.0.0.0", "localhost");
}

function getUrlPort(url: string) {
  const port = Number(url.match(/:(\d+)/)?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function activityKindLabel(kind: ActivityKind) {
  return kind === "status" ? "STATUS" : kind === "project" ? "PROJECT" : kind.toUpperCase();
}

function processActionLabel(action: ProcessAction) {
  return action.charAt(0).toUpperCase() + action.slice(1);
}

function processActionLabelThai(action: ProcessAction) {
  return { start: "เริ่ม", stop: "หยุด", restart: "รีสตาร์ต", build: "build" }[action];
}

function activityTime(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("checking");
  const [projects, setProjects] = useState<Project[]>([]);
  const [runtime, setRuntime] = useState<ProjectRuntimeState[]>([]);
  const [serviceLogs, setServiceLogs] = useState<Record<string, ServiceLogEntry[]>>({});
  const [detectedServiceUrls, setDetectedServiceUrls] = useState<Record<string, string>>({});
  const [selectedLogServiceId, setSelectedLogServiceId] = useState<string | null>(null);
  const [logSocketState, setLogSocketState] = useState<LogSocketState>("disconnected");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isProjectsLoading, setIsProjectsLoading] = useState(true);
  const [isRuntimeLoading, setIsRuntimeLoading] = useState(true);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsNotice, setProjectsNotice] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [form, setForm] = useState<ProjectForm>(createEmptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [processAction, setProcessAction] = useState<string | null>(null);
  const [activeProcessAction, setActiveProcessAction] = useState<ProcessAction | "start-all" | "stop-all" | null>(null);
  const [reorderingProjectId, setReorderingProjectId] = useState<string | null>(null);
  const [isPullModalOpen, setIsPullModalOpen] = useState(false);
  const [gitBranches, setGitBranches] = useState<GitBranch[]>([]);
  const [selectedGitBranch, setSelectedGitBranch] = useState("");
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityProjectFilter, setActivityProjectFilter] = useState("all");
  const runtimeRequestInFlight = useRef(false);
  const hasLoadedRuntime = useRef(false);

  const recordActivity = useCallback((entry: Omit<ActivityEntry, "id" | "timestamp">) => {
    const savedEntry: ActivityEntry = {
      ...entry,
      id: createId(),
      timestamp: new Date().toISOString()
    };
    setActivity((current) => [savedEntry, ...current].slice(0, 100));
    return savedEntry.id;
  }, []);

  const updateActivity = useCallback((activityId: string, changes: Partial<Pick<ActivityEntry, "state" | "message">>) => {
    setActivity((current) => current.map((entry) => entry.id === activityId ? { ...entry, ...changes } : entry));
  }, []);

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
      setProjectsError(getTauriErrorMessage(error, "ไม่สามารถโหลดรายการโปรเจกต์ได้"));
    } finally {
      setIsProjectsLoading(false);
    }
  }, []);

  const loadRuntime = useCallback(async () => {
    if (runtimeRequestInFlight.current) {
      return;
    }
    const isInitialLoad = !hasLoadedRuntime.current;
    if (isInitialLoad) {
      setIsRuntimeLoading(true);
    }
    runtimeRequestInFlight.current = true;
    try {
      setRuntime(await getRuntime());
      setConnectionState("online");
      setRuntimeError(null);
      hasLoadedRuntime.current = true;
    } catch (error) {
      setConnectionState("offline");
      setRuntimeError(getTauriErrorMessage(error, "ไม่สามารถตรวจสอบสถานะ service ได้"));
    } finally {
      runtimeRequestInFlight.current = false;
      if (isInitialLoad) {
        setIsRuntimeLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    void loadRuntime();
    const interval = window.setInterval(() => {
      void loadRuntime();
    }, 4000);

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
          const detectedUrl = extractLocalUrl(payload.message);
          if (detectedUrl) {
            setDetectedServiceUrls((current) => ({ ...current, [`${payload.projectId}:${payload.serviceId}`]: detectedUrl }));
          }
        }
      },
      (payload) => {
        if (!disposed) {
          const project = projects.find((candidate) => candidate.id === payload.projectId);
          const service = project?.services.find((candidate) => candidate.id === payload.serviceId);
          const statusState: ActivityState = payload.status === "error"
            ? "error"
            : payload.status === "running" || payload.status === "stopped"
              ? "success"
              : "working";
          recordActivity({
            projectId: payload.projectId,
            projectName: project?.name ?? payload.projectId,
            serviceName: service?.name ?? payload.serviceId,
            kind: payload.status === "error" ? "error" : "status",
            state: statusState,
            message: payload.error
              ? getTauriErrorMessage(payload.error, "เกิดข้อผิดพลาดกับ service นี้")
              : `สถานะ service: ${payload.status}`
          });
        }
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
  }, [loadRuntime, projects, recordActivity, selectedProjectId]);

  useEffect(() => {
    setSelectedLogServiceId(null);
    setServiceLogs({});
    setDetectedServiceUrls({});
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
      services: [...current.services, { id: createId(), name: "", command: "", buildCommand: "", cwd: "" }]
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
      setFormError("ไม่สามารถเปิดตัวเลือกโฟลเดอร์ได้ กรุณากรอก path ด้วยตัวเอง");
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
        buildCommand: service.buildCommand?.trim() || undefined,
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
      recordActivity({
        projectId: savedProject.id,
        projectName: savedProject.name,
        kind: "project",
        state: "success",
        message: `${modalMode === "edit" ? "Updated" : "Added"} project configuration`
      });
      setModalMode(null);
    } catch (error) {
      setFormError(getTauriErrorMessage(error, "ไม่สามารถบันทึกโปรเจกต์ได้"));
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
      recordActivity({
        projectId: project.id,
        projectName: project.name,
        kind: "project",
        state: "success",
        message: "Removed project from DevDeck"
      });
      const remainingProjects = projects.filter((candidate) => candidate.id !== project.id);
      setProjects(remainingProjects);
      setSelectedProjectId((currentId) => currentId === project.id ? remainingProjects[0]?.id ?? null : currentId);
    } catch (error) {
      setProjectsError(getTauriErrorMessage(error, "ไม่สามารถลบโปรเจกต์ได้"));
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
      recordActivity({
        projectId,
        projectName: savedProjects.find((project) => project.id === projectId)?.name ?? projectId,
        kind: "project",
        state: "success",
        message: "Reordered project list"
      });
    } catch (error) {
      setProjectsError(getTauriErrorMessage(error, "ไม่สามารถเปลี่ยนลำดับโปรเจกต์ได้"));
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
    setActiveProcessAction(action);
    setProjectsNotice(null);
    const project = projects.find((candidate) => candidate.id === projectId);
    const serviceName = project?.services.find((service) => service.id === serviceId)?.name ?? "service";
    const activityId = recordActivity({
      projectId,
      projectName: project?.name ?? projectId,
      serviceName,
      kind: action,
      state: "working",
      message: `${processActionLabel(action)} ${serviceName}`
    });

    try {
      if (action === "start") {
        await startService(projectId, serviceId);
      } else if (action === "stop") {
        await stopService(projectId, serviceId);
      } else if (action === "build") {
        await buildService(projectId, serviceId);
        setProjectsError(null);
        setProjectsNotice(`Build completed for ${serviceName}.`);
      } else {
        await restartService(projectId, serviceId);
      }
      updateActivity(activityId, { state: "success", message: `${processActionLabel(action)} completed for ${serviceName}` });
      await loadRuntime();
    } catch (error) {
      const message = getTauriErrorMessage(error, `ไม่สามารถ${processActionLabelThai(action)} service ได้`);
      updateActivity(activityId, { state: "error", message });
      setProjectsError(message);
      await loadRuntime();
    } finally {
      setProcessAction(null);
      setActiveProcessAction(null);
    }
  }

  async function runProjectAction(projectId: string, action: "start" | "stop") {
    setProcessAction(`${projectId}:all`);
    setActiveProcessAction(action === "start" ? "start-all" : "stop-all");
    setProjectsNotice(null);
    const project = projects.find((candidate) => candidate.id === projectId);
    const activityId = recordActivity({
      projectId,
      projectName: project?.name ?? projectId,
      kind: action,
      state: "working",
      message: `${processActionLabel(action)} all services`
    });

    try {
      if (action === "start") {
        await startProject(projectId);
      } else {
        await stopProject(projectId);
      }
      updateActivity(activityId, { state: "success", message: `${processActionLabel(action)} completed for all services` });
      await loadRuntime();
    } catch (error) {
      const message = getTauriErrorMessage(error, `ไม่สามารถ${processActionLabelThai(action)}โปรเจกต์ได้`);
      updateActivity(activityId, { state: "error", message });
      setProjectsError(message);
      await loadRuntime();
    } finally {
      setProcessAction(null);
      setActiveProcessAction(null);
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
      const detectedUrl = [...history]
        .reverse()
        .map((entry) => extractLocalUrl(entry.message))
        .find((value): value is string => Boolean(value));
      if (detectedUrl) {
        setDetectedServiceUrls((current) => ({ ...current, [`${projectId}:${serviceId}`]: detectedUrl }));
      }
    } catch (error) {
      setProjectsError(getTauriErrorMessage(error, "ไม่สามารถโหลด log ของ service ได้"));
    }
  }

  async function openServiceInBrowser(service: Service, serviceUrl?: string) {
    const port = service.port ?? (serviceUrl ? getUrlPort(serviceUrl) : undefined);
    if (!port) {
      return;
    }

    try {
      await openServiceUrl(port);
    } catch (error) {
      setProjectsError(getTauriErrorMessage(error, "ไม่สามารถเปิดหน้าเว็บของ service ได้"));
    }
  }

  async function openPullModal() {
    if (!selectedProject) {
      return;
    }
    setPullError(null);
    setGitBranches([]);
    setSelectedGitBranch("");
    setIsPullModalOpen(true);
    setIsLoadingBranches(true);

    try {
      const branches = await getGitBranches(selectedProject.id);
      setGitBranches(branches);
      setSelectedGitBranch(branches.find((branch) => branch.current)?.name ?? branches[0]?.name ?? "");
    } catch (error) {
      setPullError(getTauriErrorMessage(error, "ไม่สามารถโหลด branch ของ Git ได้"));
    } finally {
      setIsLoadingBranches(false);
    }
  }

  function closePullModal() {
    if (!isPulling) {
      setIsPullModalOpen(false);
    }
  }

  async function runPull(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject || !selectedGitBranch) {
      return;
    }
    const project = selectedProject;
    const branch = selectedGitBranch;
    const activityId = recordActivity({
      projectId: project.id,
      projectName: project.name,
      kind: "pull",
      state: "working",
      message: `Pulling origin/${branch}`
    });
    setIsPulling(true);
    setPullError(null);
    try {
      await pullProject(project.id, branch);
      updateActivity(activityId, { state: "success", message: `Pulled origin/${branch}` });
      setProjectsError(null);
      setProjectsNotice(`Pulled origin/${branch} into ${project.name}.`);
      setIsPullModalOpen(false);
    } catch (error) {
      const message = getTauriErrorMessage(error, "ไม่สามารถ Pull การเปลี่ยนแปลงจาก Git ได้");
      updateActivity(activityId, { state: "error", message });
      setPullError(message);
    } finally {
      setIsPulling(false);
    }
  }

  const connectionLabel = {
    checking: "Checking native bridge",
    online: "Tauri commands ready",
    offline: "Tauri commands unavailable"
  }[connectionState];
  const visibleActivity = activityProjectFilter === "all"
    ? activity
    : activity.filter((entry) => entry.projectId === activityProjectFilter);

  return (
    <main className="grid min-h-screen grid-cols-[232px_minmax(0,1fr)] bg-[#101214]">
      <aside className="flex flex-col border-r border-[#292e34] bg-[#15181c] px-4 pb-5 pt-6">
        <div className="flex items-center gap-3 border-b border-[#20282a] px-2 pb-6">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-[#c9dcf7] text-sm font-bold text-[#17202b]" aria-hidden="true">D</div>
          <div>
            <p className="text-sm font-semibold text-[#eef4ef]">DevDeck</p>
            <p className="mt-1 text-[10px] text-[#718079]">Local workspace</p>
          </div>
        </div>

        <nav className="mt-6 grid gap-1" aria-label="Primary navigation">
          <a className="flex min-h-10 items-center gap-3 rounded-md border border-[#3d4c5b] bg-[#222b35] px-3 text-xs font-medium text-[#e3ebf4] no-underline" href="#projects">
            <span className="grid h-5 w-5 place-items-center rounded bg-[#2f4053] text-[10px] font-bold text-[#c5dbf4]" aria-hidden="true">P</span>
            Projects
            <span className="ml-auto font-mono text-[11px] text-[#61716a]">{projects.length}</span>
          </a>
          <a className="flex min-h-10 items-center gap-3 rounded-md border border-transparent px-3 text-xs text-[#8e969f] no-underline transition hover:border-[#353d46] hover:bg-[#1d2329] hover:text-[#e2e8ef]" href="#activity">
            <span className="grid h-5 w-5 place-items-center rounded bg-[#252c34] text-[10px] font-bold text-[#abb6c1]" aria-hidden="true">A</span>
            Activity
            <span className="ml-auto font-mono text-[11px] text-[#61716a]">{activity.length}</span>
          </a>
        </nav>

        <div className="mt-auto px-2">
          <div className="flex items-center gap-2 rounded-md border border-[#30363d] bg-[#1b2025] px-3 py-2.5 text-[11px] text-[#9da5ad]"><StatusDot state={connectionState} /><span>{connectionLabel}</span></div>
          <p className="mt-4 text-[10px] text-[#52615c]">Tauri desktop app</p>
        </div>
      </aside>

      <section className="mx-auto w-full max-w-[1400px] px-9 pb-8 pt-7 max-[1050px]:px-7 max-[900px]:px-5">
        <header className="mb-6 flex items-end justify-between border-b border-[#292e34] pb-5">
          <div>
            <p className="text-xs font-medium text-[#84928b]">Workspace</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-[#edf4ef]">Projects</h1>
          </div>
          <div className="flex gap-2">
            {selectedProject && <button className={ghostButtonClass} type="button" disabled={isLoadingBranches} onClick={() => void openPullModal()}>{isLoadingBranches ? <LoadingSpinner label="กำลังโหลด" small /> : "Pull"}</button>}
            <button className={primaryButtonClass} type="button" onClick={openCreateModal}>
              <span className="text-lg font-normal leading-none" aria-hidden="true">+</span>
              Add project
            </button>
          </div>
        </header>

        {projectsError && <div className="mb-3"><ErrorBanner message={projectsError} onDismiss={() => setProjectsError(null)} /></div>}
        {runtimeError && !projectsError && <div className="mb-3"><ErrorBanner message={runtimeError} compact onDismiss={() => setRuntimeError(null)} /></div>}
        {projectsNotice && <div className="mb-3 flex items-center gap-2 rounded-md border border-[#3d526a] bg-[#1b2633] px-3.5 py-3 text-[11px] text-[#c4d8ef]" role="status"><span className="grid h-4 w-4 place-items-center rounded-full border border-[#6885a5] text-[10px]" aria-hidden="true">✓</span>{projectsNotice}</div>}

        <div className="grid min-h-[500px] grid-cols-[280px_minmax(0,1fr)] overflow-hidden rounded-md border border-[#2b3138] bg-[#171a1f] max-[900px]:grid-cols-[250px_minmax(0,1fr)]" id="projects">
          <section className="border-r border-[#273133]" aria-label="Registered projects">
            <div className="flex items-start justify-between border-b border-[#273133] px-5 pb-4 pt-5">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[#74847b]">Registered projects</p>
                <h3 className="mt-2 text-sm font-semibold text-[#e1ebe4]">{projects.length === 0 ? "No projects" : `${projects.length} project${projects.length === 1 ? "" : "s"}`}</h3>
              </div>
              <span className="rounded bg-[#202c2d] px-2 py-1 text-[9px] font-medium text-[#82968b]">LOCAL</span>
            </div>

            {isProjectsLoading ? (
              <div className="grid min-h-[360px] place-items-center p-5 text-center text-[11px] text-[#788780]"><LoadingSpinner label="กำลังโหลดโปรเจกต์" /></div>
            ) : projects.length === 0 ? (
              <div className="grid min-h-[360px] content-center justify-items-center gap-[11px] p-5 text-center text-[11px] text-[#697770]">
                <span className="grid h-[34px] w-[34px] place-items-center rounded-md border border-[#384b60] bg-[#202b38] text-[19px] text-[#a8c8ed]" aria-hidden="true">+</span>
                <p>Your project registry is empty.</p>
                <button className={textButtonClass} type="button" onClick={openCreateModal}>Register a project</button>
              </div>
            ) : (
              <div className="grid gap-0.5 p-2">
                {projects.map((project) => (
                  <article
                    className={`cursor-pointer rounded-md border px-3.5 py-3.5 transition hover:border-[#46525e] hover:bg-[#1d2329] ${project.id === selectedProjectId ? "border-[#526a84] bg-[#202b38]" : "border-transparent"}`}
                    key={project.id}
                    onClick={() => setSelectedProjectId(project.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="m-0 text-[13px] font-semibold text-[#dce8df]">{project.name}</h4>
                      <div className="flex items-center gap-[9px]">
                        <span className={`rounded-full px-2 py-0.5 text-[9px] font-medium ${runtimeBadgeClasses[runtime.find((state) => state.projectId === project.id)?.status ?? "stopped"]}`}>
                          {statusLabel(runtime.find((state) => state.projectId === project.id)?.status ?? "stopped")}
                        </span>
                        <div className={`flex gap-0.5 opacity-40 transition hover:opacity-100 ${project.id === selectedProjectId ? "opacity-100" : "group-hover:opacity-100"}`} onClick={(event) => event.stopPropagation()}>
                          <button className="grid h-[19px] w-[19px] place-items-center rounded border border-[#30443a] bg-[#15201c] p-0 text-[12px] leading-none text-[#8caf9c] transition hover:border-[#6b9b7d] hover:bg-[#20362a] hover:text-[#d3f2dc] disabled:cursor-default disabled:border-[#24302b] disabled:bg-[#111719] disabled:text-[#45544d]" type="button" aria-label={`Move ${project.name} up`} disabled={projects.indexOf(project) === 0 || reorderingProjectId !== null} onClick={() => void moveProject(project.id, "up")}>↑</button>
                          <button className="grid h-[19px] w-[19px] place-items-center rounded border border-[#30443a] bg-[#15201c] p-0 text-[12px] leading-none text-[#8caf9c] transition hover:border-[#6b9b7d] hover:bg-[#20362a] hover:text-[#d3f2dc] disabled:cursor-default disabled:border-[#24302b] disabled:bg-[#111719] disabled:text-[#45544d]" type="button" aria-label={`Move ${project.name} down`} disabled={projects.indexOf(project) === projects.length - 1 || reorderingProjectId !== null} onClick={() => void moveProject(project.id, "down")}>↓</button>
                        </div>
                      </div>
                    </div>
                    <p className="mt-2 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[9px] text-[#6c7b73]" title={project.path}>{project.path}</p>
                    <div className="mt-[11px] flex gap-3 text-[10px] text-[#72847a]">
                      <span>{project.services.length} service{project.services.length === 1 ? "" : "s"}</span>
                      {project.services.some((service) => service.port) && <span>Ports configured</span>}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="min-w-0 px-[30px] py-7" aria-label="Project details">
            {selectedProject ? (
              <>
                <header className="flex items-start justify-between gap-5 border-b border-[#273133] pb-6">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[#74847b]">Project detail</p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-[#edf4ef]">{selectedProject.name}</h2>
                    <code className="mt-2.5 block max-w-[520px] overflow-hidden text-ellipsis whitespace-nowrap rounded bg-[#111719] px-2 py-1 text-[10px] text-[#849890]" title={selectedProject.path}>{selectedProject.path}</code>
                    <div className="mt-3 flex items-center gap-2 text-[11px] text-[#a5b3ac]">{isRuntimeLoading ? <LoadingSpinner label="กำลังตรวจสอบสถานะ" small /> : <><StatusDot state={selectedRuntime?.status ?? "stopped"} /><span>{statusLabel(selectedRuntime?.status ?? "stopped")}</span></>}</div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      className={secondaryButtonClass}
                      type="button"
                      disabled={selectedProject.services.length === 0 || processAction !== null || isRuntimeLoading || selectedRuntime?.status === "running" || selectedRuntime?.status === "starting"}
                      onClick={() => void runProjectAction(selectedProject.id, "start")}
                    >
                      {activeProcessAction === "start-all" ? <LoadingSpinner label="กำลังเริ่ม" small /> : "Start all"}
                    </button>
                    <button
                      className={ghostButtonClass}
                      type="button"
                      disabled={processAction !== null || isRuntimeLoading || (!selectedRuntime?.services || !Object.values(selectedRuntime.services).some((service) => service.status !== "stopped"))}
                      onClick={() => void runProjectAction(selectedProject.id, "stop")}
                    >
                      {activeProcessAction === "stop-all" ? <LoadingSpinner label="กำลังหยุด" small /> : "Stop all"}
                    </button>
                    <button className={ghostButtonClass} type="button" onClick={() => openEditModal(selectedProject)}>Edit</button>
                    <button className={dangerButtonClass} type="button" disabled={deletingProjectId === selectedProject.id} onClick={() => void removeProject(selectedProject)}>
                      {deletingProjectId === selectedProject.id ? <LoadingSpinner label="กำลังลบ" small /> : "Remove"}
                    </button>
                  </div>
                </header>

                <div className="flex items-end justify-between gap-4 py-6 pb-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[#74847b]">Services</p>
                    <h3 className="mt-2 text-sm font-semibold text-[#e1ebe4]">{selectedProject.services.length === 0 ? "No services yet" : "Registered services"}</h3>
                  </div>
                  <button className={textButtonClass} type="button" onClick={() => openEditModal(selectedProject)}>Edit services</button>
                </div>

                {isRuntimeLoading && <div className="mb-3 rounded-md border border-[#3b4a58] bg-[#1a232d] px-3.5 py-3 text-[11px] text-[#c0cfdd]"><LoadingSpinner label="กำลังตรวจสอบสถานะ service..." small /></div>}

                {selectedProject.services.length === 0 ? (
                  <div className="grid justify-items-start gap-[15px] rounded-[7px] border border-dashed border-[#2a3b34] px-[18px] py-7 text-[11px] text-[#718078]">
                    <p>Define the commands DevDeck will manage for this project.</p>
                    <button className={secondaryButtonClass} type="button" onClick={() => openEditModal(selectedProject)}>Add a service</button>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {selectedProject.services.map((service) => {
                      const serviceRuntime = getServiceRuntime(service.id);
                      const actionKey = `${selectedProject.id}:${service.id}`;
                      const serviceUrl = detectedServiceUrls[`${selectedProject.id}:${service.id}`] ?? (service.port ? `http://localhost:${service.port}` : null);
                      const isBusy = processAction !== null || serviceRuntime.status === "starting" || serviceRuntime.status === "stopping";
                      const canStop = serviceRuntime.status === "running" || serviceRuntime.status === "starting" || serviceRuntime.status === "error";

                      return (
                        <article className="grid min-h-[82px] grid-cols-[86px_minmax(0,1fr)_auto_auto] items-center gap-4 rounded-md border border-[#2f373f] bg-[#12161a] px-4 py-3.5 transition hover:border-[#4a5662] max-[1100px]:grid-cols-[86px_minmax(0,1fr)_auto]" key={service.id}>
                          <div className="flex items-center gap-2 text-[10px] text-[#a3b1a9]"><StatusDot state={serviceRuntime.status} /><span>{statusLabel(serviceRuntime.status)}</span></div>
                          <div className="min-w-0">
                            <h4 className="m-0 text-[13px] font-semibold text-[#dce8df]">{service.name}</h4>
                            <code className="mt-[7px] block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-[#a8c2b0]">{service.command}</code>
                            <span className="mt-1.5 block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[9px] text-[#607269]">build {service.buildCommand ?? "docker compose build"}</span>
                            {service.cwd && <span className="mt-1.5 inline-block font-mono text-[9px] text-[#607269]">cwd {service.cwd}</span>}
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
                              <span className="text-[#71808e]">URL</span>
                              {serviceUrl ? <code className="rounded border border-[#344659] bg-[#18212b] px-1.5 py-0.5 font-mono text-[#b8d1ee]">{serviceUrl}</code> : <span className="text-[#778390]">กำลังค้นหาจาก log หรือเพิ่ม Port ใน Edit</span>}
                              <button
                                className="border-0 bg-transparent px-0 py-0.5 text-[10px] font-medium text-[#a9c8eb] transition hover:text-[#e0edfc] disabled:cursor-not-allowed disabled:text-[#687482]"
                                type="button"
                                disabled={serviceRuntime.status !== "running" || !serviceUrl}
                                onClick={() => void openServiceInBrowser(service, serviceUrl ?? undefined)}
                              >
                                เปิดใน browser ↗
                              </button>
                            </div>
                            {serviceRuntime.error && <span className="mt-1.5 block overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-[#e39b9b]">{getTauriErrorMessage(serviceRuntime.error, "เกิดข้อผิดพลาดกับ service นี้")}</span>}
                          </div>
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <button className={ghostButtonClass} type="button" disabled={isBusy || canStop} onClick={() => void runServiceAction(selectedProject.id, service.id, "start")}>{processAction === actionKey && activeProcessAction === "start" ? <LoadingSpinner label="กำลังเริ่ม" small /> : "Start"}</button>
                            <button className={ghostButtonClass} type="button" disabled={isBusy || !canStop} onClick={() => void runServiceAction(selectedProject.id, service.id, "stop")}>{processAction === actionKey && activeProcessAction === "stop" ? <LoadingSpinner label="กำลังหยุด" small /> : "Stop"}</button>
                            <button className={ghostButtonClass} type="button" disabled={isBusy || !canStop} onClick={() => void runServiceAction(selectedProject.id, service.id, "restart")}>{processAction === actionKey && activeProcessAction === "restart" ? <LoadingSpinner label="กำลังรีสตาร์ต" small /> : "Restart"}</button>
                            <button className={secondaryButtonClass} type="button" disabled={isBusy} onClick={() => void runServiceAction(selectedProject.id, service.id, "build")}>{processAction === actionKey && activeProcessAction === "build" ? <LoadingSpinner label="กำลัง build" small /> : "Build"}</button>
                            <button className={`inline-flex min-h-9 items-center justify-center rounded-md border px-3 text-xs transition ${selectedLogServiceId === service.id ? "border-[#5d7897] bg-[#293848] text-[#e1edfb]" : "border-[#343b44] bg-transparent text-[#aeb7c1] hover:border-[#667381] hover:bg-[#20262d]"}`} type="button" onClick={() => void selectLogService(selectedProject.id, service.id)}>Logs</button>
                          </div>
                          {service.port && <div className="flex flex-col items-end gap-1">
                            <span className={`font-mono text-[11px] ${portClasses[serviceRuntime.portStatus ?? "unknown"]}`}>:{service.port}</span>
                            <small className="font-mono text-[8px] uppercase text-[#6f8c7a]">{portStatusLabel(serviceRuntime.portStatus)}</small>
                          </div>}
                        </article>
                      );
                    })}
                  </div>
                )}

                {selectedLogService && (
                  <section className="mt-4 overflow-hidden rounded-md border border-[#303842] bg-[#0d1115]" aria-label={`${selectedLogService.name} logs`}>
                    <header className="flex items-center justify-between gap-3.5 border-b border-[#27303a] bg-[#13181e] px-[15px] py-[13px]">
                      <div>
                        <p className={eyebrowClass}>Terminal output</p>
                        <h3 className="mt-1.5 text-[13px] font-semibold text-[#dce9df]">{selectedLogService.name}</h3>
                      </div>
                      <div className="flex items-center gap-[7px] font-mono text-[9px] uppercase text-[#778a7e]"><StatusDot state={logSocketState === "connected" ? "running" : logSocketState === "connecting" ? "starting" : "stopped"} /><span>{logSocketState}</span></div>
                    </header>
                    <div className="max-h-[235px] overflow-auto px-3.5 py-3 font-mono text-[10px] leading-[1.65] text-[#aeb8c3]">
                      {(serviceLogs[selectedLogService.id] ?? []).length === 0 ? (
                        <span className="block px-1 py-[19px] text-[#60736a]">ยังไม่มี output จาก process นี้ กด Start แล้วลองเปิด Logs อีกครั้ง</span>
                      ) : (
                        serviceLogs[selectedLogService.id].map((entry, index) => (
                          <div className={`grid grid-cols-[70px_52px_minmax(0,1fr)] gap-2.5 whitespace-pre-wrap break-words ${entry.stream === "stderr" ? "text-[#d6a3a3]" : ""}`} key={`${entry.timestamp}-${index}`}>
                            <time className={entry.stream === "stderr" ? "text-[#8f6565]" : "text-[#50645a]"}>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                            <span className={`text-[9px] uppercase ${entry.stream === "stderr" ? "text-[#b87979]" : "text-[#7497bc]"}`}>{entry.stream}</span>
                            <span>{entry.message}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </section>
                )}

                <div className="mt-7 flex items-center gap-[9px] rounded-md border border-[#303842] bg-[#181e25] px-[13px] py-3 text-[10px] text-[#7d8995]">
                  <span className="grid h-4 w-4 place-items-center rounded-full border border-[#52677e] font-serif text-[11px] text-[#a1bddf]" aria-hidden="true">i</span>
                  <p>Output is kept in memory and limited to the latest 500 entries per service.</p>
                </div>
              </>
            ) : (
              <div className="grid min-h-[430px] place-content-center justify-items-center gap-2 text-center text-[#718078]">
                <div className="mb-1.5 grid h-[42px] w-[42px] place-items-center rounded-md border border-[#384758] bg-[#202a35] text-[19px] text-[#9bbce1]" aria-hidden="true">[]</div>
                <p className={eyebrowClass}>No project selected</p>
                <h3 className="mt-0 text-[16px] font-semibold tracking-[-0.04em] text-[#dbe8df]">Register your first local project.</h3>
                <p className="my-[3px] mb-3 max-w-[310px] text-[11px] leading-[1.6]">DevDeck stores only the project path and service configuration.</p>
                <button className={primaryButtonClass} type="button" onClick={openCreateModal}>Add project</button>
              </div>
            )}
          </section>
        </div>

        <section className="mt-4 overflow-hidden rounded-md border border-[#2b3138] bg-[#13171b]" id="activity" aria-labelledby="activity-title">
          <header className="flex items-center gap-4 border-b border-[#2b3138] px-4 py-3">
            <div>
              <p className={eyebrowClass}>Activity</p>
              <h3 className="mt-1 text-[14px] font-semibold tracking-[-0.03em] text-[#dfe8e2]" id="activity-title">Recent workspace activity</h3>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <select className="min-h-[30px] rounded border border-[#343b44] bg-[#101419] px-2 text-[10px] text-[#b0bac5] outline-none focus:border-[#607e9e]" aria-label="Filter activity by project" value={activityProjectFilter} onChange={(event) => setActivityProjectFilter(event.target.value)}>
                <option value="all">All projects</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              <button className={textButtonClass} type="button" disabled={activity.length === 0} onClick={() => setActivity([])}>Clear</button>
            </div>
          </header>

          {visibleActivity.length === 0 ? (
            <div className="grid min-h-[120px] place-content-center gap-1.5 px-4 py-7 text-center text-[10px] text-[#68786f]">
              <p>{activity.length === 0 ? "No activity yet." : "No activity for this project."}</p>
              <span>Start, stop, build, or pull a project to see events here.</span>
            </div>
          ) : (
            <div className="max-h-[280px] overflow-auto">
              {visibleActivity.map((entry) => (
                <article className="grid grid-cols-[18px_72px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[#20262d] px-4 py-3 last:border-b-0" key={entry.id}>
                  <span className={`grid h-[18px] w-[18px] place-items-center rounded-full border text-[9px] ${entry.state === "error" ? "border-[#75474a] bg-[#2b1b1e] text-[#d89595]" : entry.state === "working" ? "border-[#806c43] bg-[#2b2518] text-[#d7b574]" : entry.state === "success" ? "border-[#3c6a50] bg-[#193022] text-[#9fe1b5]" : "border-[#3b4c44] bg-[#17211e] text-[#9cb1a5]"}`} aria-hidden="true">{entry.state === "error" ? "!" : entry.state === "working" ? "~" : entry.state === "success" ? "✓" : "·"}</span>
                  <time className="font-mono text-[9px] text-[#52645b]">{activityTime(entry.timestamp)}</time>
                  <div className="min-w-0">
                    <p className="overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-[#c9d8ce]">{entry.message}</p>
                    <p className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[9px] text-[#65786d]">{entry.projectName}{entry.serviceName ? ` / ${entry.serviceName}` : ""}</p>
                  </div>
                  <span className={`font-mono text-[8px] tracking-[0.08em] ${entry.state === "error" ? "text-[#c87979]" : entry.state === "working" ? "text-[#d7b574]" : "text-[#72957e]"}`}>{activityKindLabel(entry.kind)}</span>
                </article>
              ))}
            </div>
          )}

          <footer className="flex items-center gap-[18px] border-t border-[#2b3138] px-4 py-[10px] font-mono text-[9px] text-[#707a85]">
            <div className="flex items-center gap-2 text-[#94a59b]"><StatusDot state={connectionState} /><span>{connectionLabel}</span></div>
            <span className="ml-auto">Latest 100 events in this session</span>
            <button className={textButtonClass} type="button" onClick={() => { void loadProjects(); void loadRuntime(); }}>Refresh</button>
          </footer>
        </section>

        <footer className="mt-6 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.05em] text-[#4f5d57]">
          <span>DevDeck is local-first.</span>
          <span>Nothing leaves this machine.</span>
        </footer>
      </section>

      {modalMode && (
        <div className="fixed inset-0 z-10 grid place-items-center bg-[rgba(4,7,8,0.75)] p-[30px] backdrop-blur-[4px]" role="presentation" onMouseDown={closeModal}>
          <section className="max-h-[min(720px,calc(100vh-60px))] w-full max-w-[720px] overflow-auto rounded-md border border-[#3a444f] bg-[#171b20] p-7 shadow-[0_25px_80px_rgba(0,0,0,0.45)]" role="dialog" aria-modal="true" aria-labelledby="project-modal-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="flex items-start justify-between border-b border-[#2b323a] pb-[23px]">
              <div>
                <p className={eyebrowClass}>Project registry</p>
                <h2 className="mt-2 text-[27px] font-semibold leading-[1.1] tracking-[-0.04em] text-[#eef5ef]" id="project-modal-title">{modalMode === "create" ? "Add project" : "Edit project"}</h2>
              </div>
              <button className="grid h-7 w-7 place-items-center rounded border border-[#3b4652] bg-[#20262d] text-[#a6b1bc] transition hover:border-[#6a7e95] hover:text-[#eef4fb]" type="button" aria-label="Close" onClick={closeModal}>×</button>
            </header>

            <form onSubmit={(event) => void saveProject(event)}>
              <div className="grid grid-cols-[0.8fr_1.2fr] gap-3.5 pt-[23px] max-[900px]:grid-cols-1">
                <label className="grid gap-[7px] text-[10px] text-[#82918a]">
                  <span className="font-semibold tracking-[0.03em]">Project name</span>
                  <input className="min-h-[35px] w-full rounded-[5px] border border-[#2a3933] bg-[#0d1315] px-2.5 text-[11px] text-[#dce8df] outline-none transition placeholder:text-[#46554e] focus:border-[#66957a] focus:shadow-[0_0_0_2px_rgba(102,149,122,0.13)]" autoFocus required value={form.name} placeholder="ACS Portal" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
                </label>
                <label className="grid gap-[7px] text-[10px] text-[#82918a]">
                  <span className="font-semibold tracking-[0.03em]">Project directory</span>
                  <div className="flex gap-[7px]">
                    <input className="min-h-[35px] min-w-0 w-full rounded-[5px] border border-[#2a3933] bg-[#0d1315] px-2.5 text-[11px] text-[#dce8df] outline-none transition placeholder:text-[#46554e] focus:border-[#66957a] focus:shadow-[0_0_0_2px_rgba(102,149,122,0.13)]" required value={form.path} placeholder="C:/code/acs/acs-portal" onChange={(event) => setForm((current) => ({ ...current, path: event.target.value }))} />
                    <button className="shrink-0 rounded-[5px] border border-[#365544] bg-[#17241f] px-2.5 text-[11px] text-[#a8d6b7] transition hover:border-[#6b9b7d] hover:bg-[#1c3027]" type="button" onClick={() => void chooseProjectFolder()}>Browse</button>
                  </div>
                </label>
              </div>

              <div className="flex items-end justify-between gap-3 py-[25px] pb-[13px]">
                <div>
                  <p className={eyebrowClass}>Optional</p>
                  <h3 className="mt-[7px] text-[14px] font-semibold tracking-[-0.04em] text-[#dfe8e2]">Services</h3>
                </div>
                <button className={textButtonClass} type="button" onClick={addService}>+ Add service</button>
              </div>

              {form.services.length === 0 ? (
                <div className="rounded-md border border-dashed border-[#2c3d35] p-3.5 text-[10px] text-[#68786f]">No services configured. You can add them now or later.</div>
              ) : (
                <div className="grid gap-2.5">
                  {form.services.map((service, index) => (
                    <div className="rounded-md border border-[#2a3933] bg-[#0e1516] p-[13px]" key={service.id}>
                      <div className="mb-3 flex items-center justify-between font-mono text-[10px] text-[#a9b9b0]"><span>Service {index + 1}</span><button className="border-0 bg-transparent px-0 py-0.5 text-[11px] text-[#bd7e7e] transition hover:text-[#e3a2a2]" type="button" onClick={() => removeService(index)}>Remove</button></div>
                      <div className="grid grid-cols-[0.7fr_1.15fr_0.85fr_0.95fr_0.5fr] gap-[9px] max-[900px]:grid-cols-2">
                        <label className="grid gap-[7px] text-[10px] text-[#82918a]"><span className="font-semibold tracking-[0.03em]">Name</span><input className="min-h-[35px] w-full rounded-[5px] border border-[#2a3933] bg-[#0d1315] px-2.5 text-[11px] text-[#dce8df] outline-none transition placeholder:text-[#46554e] focus:border-[#66957a] focus:shadow-[0_0_0_2px_rgba(102,149,122,0.13)]" required value={service.name} placeholder="Frontend" onChange={(event) => updateService(index, { name: event.target.value })} /></label>
                        <label className="grid gap-[7px] text-[10px] text-[#82918a]"><span className="font-semibold tracking-[0.03em]">Command</span><input className="min-h-[35px] w-full rounded-[5px] border border-[#2a3933] bg-[#0d1315] px-2.5 text-[11px] text-[#dce8df] outline-none transition placeholder:text-[#46554e] focus:border-[#66957a] focus:shadow-[0_0_0_2px_rgba(102,149,122,0.13)]" required value={service.command} placeholder="npm run dev" onChange={(event) => updateService(index, { command: event.target.value })} /></label>
                        <label className="grid gap-[7px] text-[10px] text-[#82918a]"><span className="font-semibold tracking-[0.03em]">Docker build command <small className="text-[9px] font-normal text-[#5d6e65]">optional</small></span><input className="min-h-[35px] w-full rounded-[5px] border border-[#2a3933] bg-[#0d1315] px-2.5 text-[11px] text-[#dce8df] outline-none transition placeholder:text-[#46554e] focus:border-[#66957a] focus:shadow-[0_0_0_2px_rgba(102,149,122,0.13)]" value={service.buildCommand ?? ""} placeholder="docker compose build" onChange={(event) => updateService(index, { buildCommand: event.target.value })} /></label>
                        <label className="grid gap-[7px] text-[10px] text-[#82918a]"><span className="font-semibold tracking-[0.03em]">cwd <small className="text-[9px] font-normal text-[#5d6e65]">optional</small></span><input className="min-h-[35px] w-full rounded-[5px] border border-[#2a3933] bg-[#0d1315] px-2.5 text-[11px] text-[#dce8df] outline-none transition placeholder:text-[#46554e] focus:border-[#66957a] focus:shadow-[0_0_0_2px_rgba(102,149,122,0.13)]" value={service.cwd ?? ""} placeholder="./frontend" onChange={(event) => updateService(index, { cwd: event.target.value })} /></label>
                        <label className="grid gap-[7px] text-[10px] text-[#82918a]"><span className="font-semibold tracking-[0.03em]">Port <small className="text-[9px] font-normal text-[#5d6e65]">optional</small></span><input className="min-h-[35px] w-full rounded-[5px] border border-[#2a3933] bg-[#0d1315] px-2.5 text-[11px] text-[#dce8df] outline-none transition placeholder:text-[#46554e] focus:border-[#66957a] focus:shadow-[0_0_0_2px_rgba(102,149,122,0.13)]" type="number" min="1" max="65535" value={service.port ?? ""} placeholder="3000" onChange={(event) => updateService(index, { port: event.target.value ? Number(event.target.value) : undefined })} /></label>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {formError && <div className="mt-[18px]"><ErrorBanner message={formError} compact onDismiss={() => setFormError(null)} /></div>}
              <footer className="mt-[22px] flex justify-end gap-2 border-t border-[#24312d] pt-6">
                <button className={ghostButtonClass} type="button" onClick={closeModal}>Cancel</button>
                <button className={primaryButtonClass} type="submit" disabled={isSaving}>{isSaving ? <LoadingSpinner label="กำลังบันทึก" small /> : "Save project"}</button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {isPullModalOpen && selectedProject && (
        <div className="fixed inset-0 z-20 grid place-items-center bg-[rgba(4,7,8,0.75)] p-[30px] backdrop-blur-[4px]" role="presentation" onMouseDown={closePullModal}>
          <section className="w-full max-w-[480px] rounded-md border border-[#3a444f] bg-[#171b20] p-7 shadow-[0_25px_80px_rgba(0,0,0,0.45)]" role="dialog" aria-modal="true" aria-labelledby="pull-modal-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="flex items-start justify-between border-b border-[#2b323a] pb-[23px]">
              <div>
                <p className={eyebrowClass}>Git operation</p>
                <h2 className="mt-2 text-[27px] font-semibold leading-[1.1] tracking-[-0.04em] text-[#eef5ef]" id="pull-modal-title">Pull changes</h2>
                <p className="mt-2 text-[11px] text-[#82918a]">Pull from origin into {selectedProject.name}.</p>
              </div>
              <button className="grid h-7 w-7 place-items-center rounded border border-[#3b4652] bg-[#20262d] text-[#a6b1bc] transition hover:border-[#6a7e95] hover:text-[#eef4fb]" type="button" aria-label="Close" onClick={closePullModal}>×</button>
            </header>

            <form onSubmit={(event) => void runPull(event)}>
              <label className="mt-[23px] grid gap-[7px] text-[10px] text-[#82918a]">
                <span className="font-semibold tracking-[0.03em]">Branch</span>
                <select className="min-h-[35px] w-full rounded-[5px] border border-[#2a3933] bg-[#0d1315] px-2.5 text-[11px] text-[#dce8df] outline-none transition focus:border-[#66957a] focus:shadow-[0_0_0_2px_rgba(102,149,122,0.13)]" required value={selectedGitBranch} disabled={isPulling || isLoadingBranches || gitBranches.length === 0} onChange={(event) => setSelectedGitBranch(event.target.value)}>
                  <option value="" disabled>{isLoadingBranches ? "กำลังโหลด branch..." : gitBranches.length === 0 ? "ไม่พบ local branch" : "เลือก branch"}</option>
                  {gitBranches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}{branch.current ? " (current)" : ""}</option>)}
                </select>
              </label>

              {pullError && <div className="mt-[18px]"><ErrorBanner message={pullError} compact onDismiss={() => setPullError(null)} /></div>}
              <footer className="mt-[22px] flex justify-end gap-2 border-t border-[#24312d] pt-6">
                <button className={ghostButtonClass} type="button" onClick={closePullModal}>Cancel</button>
                <button className={primaryButtonClass} type="submit" disabled={isPulling || isLoadingBranches || !selectedGitBranch}>{isPulling ? <LoadingSpinner label="กำลัง Pull" small /> : "Pull changes"}</button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
