import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Eye,
  EyeOff,
  LoaderCircle,
  QrCode,
  Radio,
  Square,
  TriangleAlert,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ErrorAlert } from "@/components/ErrorAlert";
import { usePartitions } from "@/hooks/usePartitions";
import { api, errorMessage, type FaceAuthResponse } from "@/lib/api";
import { copyText } from "@/lib/clipboard";

/** 密钥明文展示的秒数，超时自动恢复打码 */
const REVEAL_SECONDS = 10;

/**
 * 直播控制：开播 / 停播（高危），以及推流地址与密钥展示。
 * 密钥默认打码，点「显示」带 reveal=1 拉取明文，10 秒后自动恢复打码。
 */
export function LivePanel() {
  const { areas } = usePartitions();
  // 开播分区提交的是二级分区 id，下拉里同时显示父分区便于辨认
  const subAreas = useMemo(
    () =>
      areas.flatMap((area) =>
        area.list.map((sub) => ({ id: sub.id, name: sub.name, parentName: area.name })),
      ),
    [areas],
  );
  const [areaId, setAreaId] = useState<string>("");
  const [faceAuth, setFaceAuth] = useState<FaceAuthResponse | null>(null);

  const [addr, setAddr] = useState<string>("");
  const [code, setCode] = useState<string>("");
  const [revealed, setRevealed] = useState(false);
  const [loadingKey, setLoadingKey] = useState(false);
  const [copying, setCopying] = useState<"addr" | "code" | null>(null);

  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revealTimerRef = useRef<number | null>(null);

  const clearRevealTimer = useCallback(() => {
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  }, []);

  /** 拉推流信息；reveal 决定明文还是打码 */
  const loadStreamKey = useCallback(
    async (reveal: boolean) => {
      setLoadingKey(true);
      try {
        const data = await api.streamKey(reveal);
        setAddr(data.addr);
        setCode(data.code);
        setRevealed(reveal && !data.masked);
        setError(null);
        return true;
      } catch (cause: unknown) {
        // 请求失败时不保留任何可能已明文显示的密钥
        setCode("");
        setRevealed(false);
        setError(errorMessage(cause));
        return false;
      } finally {
        setLoadingKey(false);
      }
    },
    [],
  );

  // 首屏先拿打码版本；放到下一个事件循环，避免在 effect 中同步更新状态
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) {
        void loadStreamKey(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      clearRevealTimer();
    };
  }, [loadStreamKey, clearRevealTimer]);

  /** 显示明文：10 秒后自动打码 */
  async function handleReveal() {
    clearRevealTimer();
    const ok = await loadStreamKey(true);
    if (!ok) {
      return;
    }
    revealTimerRef.current = window.setTimeout(() => {
      revealTimerRef.current = null;
      void loadStreamKey(false);
      toast.info("推流密钥已自动重新打码");
    }, REVEAL_SECONDS * 1000);
  }

  async function handleHide() {
    clearRevealTimer();
    setCode("");
    setRevealed(false);
    await loadStreamKey(false);
  }

  async function handleCopy(kind: "addr" | "code") {
    if (kind === "code" && !revealed) {
      toast.error("密钥处于打码状态，请先点「显示」");
      return;
    }
    const text = kind === "addr" ? addr : code;
    const ok = await copyText(text);
    if (ok) {
      setCopying(kind);
      window.setTimeout(() => setCopying((current) => (current === kind ? null : current)), 1600);
      toast.success(kind === "addr" ? "已复制推流地址" : "已复制推流密钥");
    } else {
      toast.error("复制失败");
    }
  }

  async function handleCopyUrl() {
    const url = faceAuth?.notice?.buttonUrl ?? "";
    if (url === "") {
      toast.error("这次没有可复制的验证链接");
      return;
    }
    const ok = await copyText(url);
    if (ok) {
      toast.success("已复制验证链接");
    } else {
      toast.error("复制失败");
    }
  }

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      const value = Number(areaId);
      const payload = areaId !== "" && !Number.isNaN(value) ? value : undefined;
      const result = await api.startLive(payload);
      if (result.ok === false) {
        // B 站要求人脸核身：后端已把 data.qr 渲染成 SVG，这里直接展示
        setFaceAuth(result);
        setError(null);
        toast("B 站要求人脸认证", { description: "用 B 站手机 App 扫下方二维码完成核身" });
        return;
      }
      setFaceAuth(null);
      // 推流地址与密钥始终从 GET /api/stream-key 获取；绝不内联开播响应里的明文密钥
      clearRevealTimer();
      setCode("");
      setRevealed(false);
      toast.success("已开始直播", { description: "推流地址已更新，请用 OBS 推流" });
      await loadStreamKey(false);
    } catch (cause: unknown) {
      const message = errorMessage(cause);
      setError(message);
      toast.error("开播失败", { description: message });
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      await api.stopLive();
      setConfirmStop(false);
      toast.success("已停止直播");
      clearRevealTimer();
      setCode("");
      setRevealed(false);
      await loadStreamKey(false);
    } catch (cause: unknown) {
      toast.error("停播失败", { description: errorMessage(cause) });
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="space-y-4">
      <Alert variant="destructive" className="border-destructive/30">
        <TriangleAlert />
        <AlertTitle>高危操作提示</AlertTitle>
        <AlertDescription>
          开播与停播会立即改变直播间状态，且影响所有观众。停播后重新开播可能需要等待平台冷却，请确认后再操作。
        </AlertDescription>
      </Alert>

      {error !== null ? <ErrorAlert title="直播接口出错" message={error} /> : null}

      {faceAuth !== null ? (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <QrCode className="size-4" />
              {faceAuth.notice?.title || "需要完成验证"}
            </CardTitle>
            <CardDescription>
              {faceAuth.notice?.msg ||
                "B 站要求开播前完成验证（实名/人脸/风险校验）。用手机扫下方二维码，或在手机上打开验证链接；完成后回到这里重新点「开始直播」。"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {faceAuth.qrSvg !== "" ? (
              <div
                className="mx-auto w-56 rounded-lg bg-white p-2 [&>svg]:h-auto [&>svg]:w-full"
                // 二维码由后端生成的内联 SVG，不含脚本
                dangerouslySetInnerHTML={{ __html: faceAuth.qrSvg }}
              />
            ) : (
              <p className="text-xs text-destructive">
                这次 B 站没有下发二维码，请按下方提示在手机上完成验证。
              </p>
            )}
            {faceAuth.notice?.buttonUrl ? (
              <div className="space-y-1.5">
                <p className="text-xs break-all text-muted-foreground select-all">
                  {faceAuth.notice.buttonUrl}
                </p>
                <Button variant="outline" onClick={() => void handleCopyUrl()}>
                  <Copy />
                  复制验证链接
                </Button>
              </div>
            ) : null}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">B 站返回的说明</summary>
              <p className="mt-1 leading-relaxed">{faceAuth.message}</p>
            </details>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void handleStart()} disabled={starting}>
                {starting ? <LoaderCircle className="animate-spin" /> : <Radio />}
                已完成验证，重试开播
              </Button>
              <Button variant="outline" onClick={() => setFaceAuth(null)}>
                关闭
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Radio className="size-4" />
            直播控制
          </CardTitle>
          <CardDescription>开播可指定分区；停播需要二次确认。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5 sm:max-w-72">
            <Label>开播分区（可选，留空用当前分区）</Label>
            <Select value={areaId} onValueChange={setAreaId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="使用房间当前分区" />
              </SelectTrigger>
              <SelectContent>
                {subAreas.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无可选分区</div>
                ) : (
                  subAreas.map((sub) => (
                    <SelectItem key={sub.id} value={String(sub.id)}>
                      {sub.parentName} / {sub.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void handleStart()} disabled={starting || stopping}>
              {starting ? <LoaderCircle className="animate-spin" /> : <Radio />}
              开始直播
            </Button>
            <Button
              variant="destructive"
              onClick={() => setConfirmStop(true)}
              disabled={starting || stopping}
            >
              <Square />
              停止直播
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            「开始直播」调用 POST /api/live/start，「停止直播」调用 POST /api/live/stop。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            推流地址与密钥
            {revealed ? (
              <Badge variant="destructive">明文显示中</Badge>
            ) : (
              <Badge variant="outline">已打码</Badge>
            )}
          </CardTitle>
          <CardDescription>
            默认打码；点「显示」后 10 秒自动恢复打码。请勿把推流密钥泄露给他人。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field
            label="推流地址"
            value={loadingKey && addr === "" ? "加载中…" : addr}
            onCopy={() => void handleCopy("addr")}
            copied={copying === "addr"}
          />
          <Field
            label="推流密钥"
            value={loadingKey && code === "" ? "加载中…" : code}
            onCopy={() => void handleCopy("code")}
            copied={copying === "code"}
          />

          <div className="flex flex-wrap gap-2">
            {revealed ? (
              <Button variant="outline" onClick={() => void handleHide()} disabled={loadingKey}>
                {loadingKey ? <LoaderCircle className="animate-spin" /> : <EyeOff />}
                隐藏
              </Button>
            ) : (
              <Button variant="outline" onClick={() => void handleReveal()} disabled={loadingKey}>
                {loadingKey ? <LoaderCircle className="animate-spin" /> : <Eye />}
                显示
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmStop} onOpenChange={setConfirmStop}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认停止直播？</DialogTitle>
            <DialogDescription>
              停播会让直播间立刻下播，观众会被断开。此操作无法撤销，需要重新开播。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmStop(false)} disabled={stopping}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleStop()} disabled={stopping}>
              {stopping ? <LoaderCircle className="animate-spin" /> : <Square />}
              确认停播
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface FieldProps {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}

/** 单行只读字段：等宽展示 + 复制按钮 */
function Field({ label, value, copied, onCopy }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-stretch gap-2">
        <div className="flex-1 overflow-x-auto rounded-lg border border-border bg-muted/40 px-2.5 py-2">
          <code className="font-mono text-xs whitespace-nowrap select-all">{value === "" ? "—" : value}</code>
        </div>
        <Button variant="outline" size="sm" onClick={onCopy} className="h-auto">
          {copied ? <Check /> : <Copy />}
          {copied ? "已复制" : "复制"}
        </Button>
      </div>
    </div>
  );
}
