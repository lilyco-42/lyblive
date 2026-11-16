/**
 * lyblive HTTP 契约的类型定义与 fetch 封装。
 * 所有请求走相对路径 /api/...（同源），后端与本页面同端口。
 */

/** 健康检查：服务名、版本、后端标识 */
export interface Health {
  ok: true;
  name: string;
  version: string;
  backend: string;
}

/** 直播间登录态；绝不在前端展示 cookie / csrf / token */
export interface SessionUser {
  uid: number;
  uname: string;
  face: string;
  level: number;
}

export interface Session {
  loggedIn: boolean;
  persisted: boolean;
  user?: SessionUser;
  roomId?: number;
  csrfPresent: boolean;
  /** 昵称/头像拉取失败的原因；为空表示资料已就绪 */
  profileError?: string | null;
}

export interface QrcodeResponse {
  ok: true;
  key: string;
  url: string;
  /** 完整 <svg>...</svg> 字符串，直接内联渲染 */
  qrSvg: string;
  expiresIn: number;
}

export type LoginPollStatus = "pending" | "scanned" | "confirmed" | "expired" | "error";

export interface LoginPollResponse {
  ok: true;
  status: LoginPollStatus;
  message: string;
  session?: Session;
}

export interface Room {
  roomId: number;
  shortId: number;
  uid: number;
  title: string;
  liveStatus: number;
  liveStatusText: string;
  areaId: number;
  areaName: string;
  parentAreaId: number;
  parentAreaName: string;
  online: number;
  description: string;
  keyframe: string;
}

export interface RoomResponse {
  ok: true;
  room: Room;
}

export interface SubArea {
  id: number;
  name: string;
  parentId: number;
}

export interface Area {
  id: number;
  name: string;
  list: SubArea[];
}

export interface PartitionsResponse {
  ok: true;
  areas: Area[];
}

export interface RtmpInfo {
  addr: string;
  code: string;
  provider: string;
}

export interface LiveStartResponse {
  ok: true;
  rtmp: RtmpInfo;
}

/** 开播被 B 站验证拦截：后端把 data.qr（或 notice.button_url）渲染成 SVG 返回 */
export interface FaceAuthNotice {
  title: string;
  msg: string;
  buttonText: string;
  buttonUrl: string;
}

export interface FaceAuthResponse {
  ok: false;
  faceAuthRequired: true;
  message: string;
  qrSvg: string;
  notice?: FaceAuthNotice | null;
}

export type StartLiveResult = LiveStartResponse | FaceAuthResponse;

export interface StreamKeyResponse {
  ok: true;
  addr: string;
  code: string;
  /** true 表示 code 已打码 */
  masked: boolean;
}

export interface TopKeyword {
  word: string;
  count: number;
}

export interface DanmuStats {
  danmu: number;
  gift: number;
  enter: number;
  popularity: number;
  topKeywords: TopKeyword[];
}

/** 单条弹幕/礼物/进场消息 */
export interface DanmuItem {
  ts: number;
  kind: string;
  user: string;
  text: string;
}

export interface DanmuStatusResponse {
  ok: true;
  running: boolean;
  roomId: number;
  startedAt?: number;
  stats: DanmuStats;
  recent: DanmuItem[];
}

export interface CommandArg {
  name: string;
  type: string;
  required: boolean;
}

export interface CommandInfo {
  name: string;
  about: string;
  safety: string;
  args: CommandArg[];
}

export interface CommandsResponse {
  ok: true;
  commands: CommandInfo[];
}

export interface AppConfig {
  rememberLogin: boolean;
  configDir: string;
  configFile: string;
}

export interface ConfigResponse {
  ok: true;
  config: AppConfig;
}

export interface OkResponse {
  ok: true;
}

/** 后端返回的业务错误（HTTP 4xx/5xx + {ok:false,error}） */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "未知错误";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 统一解析错误响应，优先用后端给的中文消息 */
async function readErrorPayload(response: Response): Promise<string> {
  const fallback =
    "HTTP " + response.status + (response.statusText ? " " + response.statusText : "");
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === "string" && body.error.trim() !== "") {
      return body.error;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new ApiError(
      cause instanceof Error ? "网络请求失败：" + cause.message : "网络请求失败",
      0,
    );
  }

  if (!response.ok) {
    throw new ApiError(await readErrorPayload(response), response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const body: unknown = await response.json();
  return body as T;
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

export const api = {
  health: () => request<Health>("/api/health"),

  // 登录
  session: () => request<Session>("/api/session"),
  qrcode: () => request<QrcodeResponse>("/api/login/qrcode", postJson({})),
  pollLogin: (key: string) =>
    request<LoginPollResponse>("/api/login/poll?key=" + encodeURIComponent(key)),
  logout: () => request<OkResponse>("/api/login/logout", postJson({})),

  // 房间信息
  room: () => request<RoomResponse>("/api/room"),
  partitions: () => request<PartitionsResponse>("/api/partitions"),
  setTitle: (title: string) => request<OkResponse>("/api/title", postJson({ title })),
  setArea: (areaId: number) => request<OkResponse>("/api/area", postJson({ areaId })),
  setAnnouncement: (content: string) =>
    request<OkResponse>("/api/announcement", postJson({ content })),

  // 直播控制
  startLive: (areaId?: number) =>
    request<StartLiveResult>("/api/live/start", postJson(areaId === undefined ? {} : { areaId })),
  stopLive: () => request<OkResponse>("/api/live/stop", postJson({})),
  streamKey: (reveal: boolean) =>
    request<StreamKeyResponse>("/api/stream-key?" + (reveal ? "reveal=1" : "reveal=0")),

  // 弹幕
  danmuStatus: () => request<DanmuStatusResponse>("/api/danmu/status"),
  danmuStart: (roomId?: number) =>
    request<OkResponse>("/api/danmu/start", postJson(roomId === undefined ? {} : { roomId })),
  danmuStop: () => request<OkResponse>("/api/danmu/stop", postJson({})),
  danmuSend: (msg: string) => request<OkResponse>("/api/danmu/send", postJson({ msg })),

  // 设置与命令
  config: () => request<ConfigResponse>("/api/config"),
  saveConfig: (patch: { rememberLogin?: boolean }) =>
    request<OkResponse>("/api/config", postJson(patch)),
  commands: () => request<CommandsResponse>("/api/commands"),
};

/** 弹幕 SSE 事件流地址（同源相对路径） */
export const DANMU_EVENTS_URL = "/api/danmu/events";
