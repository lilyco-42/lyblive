/** 人类可读的格式化工具：时间、数字。 */

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** 后端时间戳可能是秒或毫秒，统一换算成毫秒。 */
export function toMillis(value: number): number {
  return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
}

/** 只有时分秒的时钟，用于弹幕时间轴 */
export function formatClock(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return "—";
  }
  const date = new Date(toMillis(value));
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

export function formatDateTime(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return "—";
  }
  const date = new Date(toMillis(value));
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** 人气/在线人数：过万折成「万」 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  if (value < 10000) {
    return value.toLocaleString("zh-CN");
  }
  const wan = value / 10000;
  return (wan >= 100 ? Math.round(wan).toString() : wan.toFixed(1)) + " 万";
}

/** 已运行时长，用于弹幕监控 */
export function formatElapsed(startedAt: number | null | undefined): string {
  if (startedAt === null || startedAt === undefined || !Number.isFinite(startedAt) || startedAt <= 0) {
    return "—";
  }
  const seconds = Math.max(0, Math.round((Date.now() - toMillis(startedAt)) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return hours > 0
    ? hours + " 小时 " + minutes + " 分"
    : minutes > 0
      ? minutes + " 分 " + secs + " 秒"
      : secs + " 秒";
}
