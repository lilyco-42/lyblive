import { useCallback, useEffect, useState } from "react";
import {
  CircleCheck,
  LogOut,
  LoaderCircle,
  QrCode,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ErrorAlert } from "@/components/ErrorAlert";
import { api, errorMessage, type LoginPollStatus, type QrcodeResponse, type Session } from "@/lib/api";

interface LoginPanelProps {
  session: Session | null;
  loading: boolean;
  /** 重新拉取 /api/session */
  onRefresh: () => Promise<unknown>;
}

const STATUS_TEXT: Record<LoginPollStatus, string> = {
  pending: "等待扫码…",
  scanned: "已扫码，请在手机上确认登录",
  confirmed: "登录成功",
  expired: "二维码已过期，请重新获取",
  error: "登录失败",
};

function statusVariant(status: LoginPollStatus | null): "default" | "secondary" | "destructive" | "outline" {
  if (status === "confirmed") {
    return "default";
  }
  if (status === "error" || status === "expired") {
    return "destructive";
  }
  if (status === "scanned") {
    return "secondary";
  }
  return "outline";
}

/**
 * 扫码登录页。
 * 二维码 SVG 由后端直接给出整段字符串，这里内联渲染；cookie / csrf / token 一律不上屏。
 */
export function LoginPanel({ session, loading, onRefresh }: LoginPanelProps) {
  const [qr, setQr] = useState<QrcodeResponse | null>(null);
  const [status, setStatus] = useState<LoginPollStatus | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [requesting, setRequesting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loggedIn = session?.loggedIn === true;

  /** 获取新二维码，并重置轮询状态 */
  const requestQrcode = useCallback(async () => {
    setRequesting(true);
    setError(null);
    try {
      const data = await api.qrcode();
      setQr(data);
      setStatus("pending");
      setStatusMessage(STATUS_TEXT.pending);
    } catch (cause: unknown) {
      const message = errorMessage(cause);
      setError(message);
      toast.error("获取二维码失败", { description: message });
    } finally {
      setRequesting(false);
    }
  }, []);

  // 每 2 秒轮询一次，直到 confirmed / expired / error
  const polling = qr !== null && (status === "pending" || status === "scanned" || status === null);
  const key = qr?.key ?? "";

  useEffect(() => {
    if (!polling || key === "") {
      return;
    }
    let cancelled = false;

    async function poll() {
      try {
        const data = await api.pollLogin(key);
        if (cancelled) {
          return;
        }
        setStatus(data.status);
        setStatusMessage(data.message !== "" ? data.message : STATUS_TEXT[data.status]);
        if (data.status === "confirmed") {
          toast.success("扫码登录成功");
          await onRefresh();
        }
        if (data.status === "error") {
          setError(data.message !== "" ? data.message : "扫码登录失败");
        }
      } catch (cause: unknown) {
        if (cancelled) {
          return;
        }
        const message = errorMessage(cause);
        setStatus("error");
        setStatusMessage(message);
        setError(message);
      }
    }

    const timer = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [polling, key, onRefresh]);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await api.logout();
      setQr(null);
      setStatus(null);
      setStatusMessage("");
      await onRefresh();
      toast.success("已退出登录");
    } catch (cause: unknown) {
      toast.error("退出登录失败", { description: errorMessage(cause) });
    } finally {
      setLoggingOut(false);
    }
  }

  if (loading && session === null) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在读取登录状态…
        </CardContent>
      </Card>
    );
  }

  if (loggedIn) {
    const user = session?.user;
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleCheck className="size-4 text-emerald-500" />
              已登录
            </CardTitle>
            <CardDescription>当前账号信息来自 /api/session，凭据只留在后端。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              {user !== undefined && user.face !== "" ? (
                <img
                  src={user.face}
                  alt={user.uname}
                  className="size-14 rounded-full object-cover ring-1 ring-border"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border">
                  <UserRound className="size-6" />
                </span>
              )}
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-medium">{user?.uname ?? "未知昵称"}</span>
                  <Badge variant="outline">UID {user?.uid ?? "—"}</Badge>
                  {user !== undefined ? <Badge variant="secondary">等级 {user.level}</Badge> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  房间号 {session?.roomId ?? "—"} · 凭据已
                  {session?.persisted === true ? "写入本地文件（0600）" : "仅保存在内存"}
                </p>
              </div>
            </div>

            <Separator />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                为安全起见，前端不展示 cookie、csrf 与任何令牌。
              </p>
              <Button variant="outline" onClick={() => void handleLogout()} disabled={loggingOut}>
                {loggingOut ? <LoaderCircle className="animate-spin" /> : <LogOut />}
                退出登录
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error !== null ? <ErrorAlert title="登录出错" message={error} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <QrCode className="size-4" />
            扫码登录
          </CardTitle>
          <CardDescription>用手机 B 站客户端扫描二维码并确认，凭据只保存在后端。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {qr === null ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <span className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border">
                <ScanLine className="size-6" />
              </span>
              <p className="text-sm text-muted-foreground">尚未获取二维码</p>
              <Button onClick={() => void requestQrcode()} disabled={requesting}>
                {requesting ? <LoaderCircle className="animate-spin" /> : <QrCode />}
                获取二维码
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-center">
                {/* qrSvg 是后端返回的完整 <svg> 字符串 */}
                <div
                  className="size-[220px] [&>svg]:size-full"
                  dangerouslySetInnerHTML={{ __html: qr.qrSvg }}
                />
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2">
                <Badge variant={statusVariant(status)}>
                  {status !== null ? STATUS_TEXT[status] : "等待扫码…"}
                </Badge>
                {statusMessage !== "" ? (
                  <span className="text-xs text-muted-foreground">{statusMessage}</span>
                ) : null}
              </div>

              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                <p className="mb-1 text-xs text-muted-foreground">二维码链接（兜底，可手动打开）</p>
                <p className="font-mono text-xs break-all select-all">{qr.url}</p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  有效期约 {Math.round(qr.expiresIn / 60)} 分钟，每 2 秒自动查询一次扫码状态。
                </span>
                <Button
                  variant="outline"
                  onClick={() => void requestQrcode()}
                  disabled={requesting}
                >
                  {requesting ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                  换一张
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <span>登录凭据由后端保管并以 0600 权限落盘，前端只会拿到昵称与 UID 等展示字段。</span>
      </div>
    </div>
  );
}
