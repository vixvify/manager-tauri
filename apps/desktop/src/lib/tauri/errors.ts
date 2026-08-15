type TauriErrorPayload = {
  code?: string;
  message?: string;
};

const errorByCode: Record<string, string> = {
  project_not_found: "ไม่พบโปรเจกต์นี้ในรายการ",
  service_not_found: "ไม่พบ service นี้ในโปรเจกต์",
  invalid_project: "ข้อมูลโปรเจกต์ไม่ถูกต้อง กรุณาตรวจสอบชื่อและโฟลเดอร์",
  invalid_service: "ข้อมูล service ไม่ถูกต้อง กรุณาตรวจสอบชื่อและคำสั่ง",
  port_in_use: "พอร์ตนี้ถูกใช้งานอยู่แล้ว กรุณาปิดโปรแกรมที่ใช้พอร์ตนี้ก่อน",
  process_already_running: "service นี้กำลังทำงานอยู่แล้ว",
  process_still_stopping: "service นี้กำลังหยุดอยู่ กรุณารอสักครู่แล้วลองใหม่",
  docker_not_available: "เชื่อมต่อ Docker Desktop ไม่ได้ กรุณาเปิด Docker Desktop และตรวจสอบว่า Docker Engine พร้อมใช้งาน",
  io_error: "ระบบไม่สามารถอ่านหรือเขียนไฟล์ที่ต้องใช้ได้",
  storage_error: "ไม่สามารถบันทึกข้อมูล DevDeck ได้",
  command_failed: "คำสั่งทำงานไม่สำเร็จ กรุณาตรวจสอบการตั้งค่าและเครื่องมือที่เกี่ยวข้อง"
};

function extractError(error: unknown): TauriErrorPayload {
  if (typeof error === "string") {
    return { message: error };
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  if (typeof error === "object" && error !== null) {
    const payload = error as TauriErrorPayload;
    return {
      code: typeof payload.code === "string" ? payload.code : undefined,
      message: typeof payload.message === "string" ? payload.message : undefined
    };
  }

  return {};
}

function translateMessage(message: string | undefined, fallback: string) {
  if (!message) {
    return fallback;
  }

  const normalized = message.toLowerCase();
  const port = message.match(/port\s+(\d+)/i)?.[1];
  if (port && (normalized.includes("already being used") || normalized.includes("address already in use"))) {
    return `พอร์ต ${port} ถูกใช้งานอยู่แล้ว กรุณาปิดโปรแกรมที่ใช้พอร์ตนี้ก่อน`;
  }
  if (normalized.includes("docker") && (normalized.includes("npipe") || normalized.includes("daemon") || normalized.includes("not found") || normalized.includes("not recognized") || normalized.includes("not available"))) {
    return "เชื่อมต่อ Docker Desktop ไม่ได้ กรุณาเปิด Docker Desktop และตรวจสอบว่า Docker Engine พร้อมใช้งาน";
  }
  if (normalized.includes("not a git repository")) {
    return "โฟลเดอร์นี้ไม่ใช่ Git repository จึงใช้คำสั่ง Git ไม่ได้";
  }
  if (normalized.includes("your local changes") || normalized.includes("would be overwritten")) {
    return "มีไฟล์ที่แก้ไขในเครื่องและอาจถูกเขียนทับ กรุณา commit หรือเก็บการเปลี่ยนแปลงก่อน Pull";
  }
  if (normalized.includes("could not resolve host") || normalized.includes("unable to access")) {
    return "เชื่อมต่อ remote ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตหรือ URL ของ Git remote";
  }
  if (normalized.includes("not recognized") || normalized.includes("command not found") || normalized.includes("no such file or directory")) {
    return "ไม่พบคำสั่งที่ต้องใช้ กรุณาตรวจสอบว่าติดตั้งเครื่องมือนั้นและเพิ่มไว้ใน PATH แล้ว";
  }
  if (normalized.includes("permission denied")) {
    return "ไม่มีสิทธิ์เข้าถึงไฟล์ โฟลเดอร์ หรือ process ที่กำลังจัดการ";
  }
  if (normalized.includes("invalid project path") || normalized.includes("project directory does not exist")) {
    return "ไม่พบโฟลเดอร์โปรเจกต์ กรุณาตรวจสอบ path อีกครั้ง";
  }

  return fallback;
}

export function getTauriErrorMessage(error: unknown, fallback: string) {
  const payload = extractError(error);
  return translateMessage(payload.message, "") || (payload.code && errorByCode[payload.code]) || fallback;
}
