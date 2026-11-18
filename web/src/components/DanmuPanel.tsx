import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  Gift,
  LoaderCircle,
  MessageSquare,
  Pause,
  Play,
  Send,
  Trash2,
  TrendingUp,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/EmptyState";
import { ErrorAlert } from "@/components/ErrorAlert";
import { useDanmu } from "@/hooks/useDanmu";
import { OverlayStage } from "@/modules/danmu-overlay/OverlayStage";
import { loadOverlayConfig } from "@/modules/danmu-overlay/config";
import { errorMessage, type DanmuItem } from "@/lib/api";
import { formatClock, formatCount, formatElapsed } from "@/lib/format";

/** 消息类型配色与中文标签 */
function kindMeta(kind: string): { label: string; className: string } {
  switch (kind) {
    case "gift":
      return { label: "礼物", className: "bg-amber-500/15 text-amber-500 ring-1 ring-amber-500/30" };
    case "enter":
      return { label: "进场", className: "bg-sky-500/15 text-sky-500 ring-1 ring-sky-500/30" };
    case "danmu":
    case "chat":
      return { label: "弹幕", className: "bg-muted text-muted-foreground ring-1 ring-border" };
    default:
      return { label: kind !== "" ? kind : "消息", className: "bg-muted text-muted-foreground ring-1 ring-border" };
  }
}

function kindTextColor(kind: string): string {
  if (kind === "gift") {
    return "text-amber-500";
  }
  if (kind === "enter") {
    return "text-sky-400";
  }
  return "text-foreground";
}

/** 弹幕监控：实时消息流 + 统计 + 发送。 */
export function DanmuPanel() {
  const {
    running,
    roomId,
    startedAt,
    stats,
    items,
    seq,
    paused,
    loading,
    error,
    setPaused,
    refresh,
    start,
    stop,
    send,
    clear,
  } = useDanmu();

  const [floatTop, setFloatTop] = useState<boolean>(() => {
    try {
      return globalThis.localStorage?.getItem("lyblive.danmuFloat") === "1";
    } catch {
      return false;
    }
  });
  const floatConfig = useMemo(() => ({ ...loadOverlayConfig(""), mode: "scroll" as const }), []);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 自动滚底；暂停时不打扰用户翻看历史
  useEffect(() => {
    if (paused) {
      return;
    }
    const node = listRef.current;
    if (node === null) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [items, paused]);

  const topKeywords = useMemo(() => stats.topKeywords.slice(0, 10), [stats.topKeywords]);

  async function handleToggle() {
    setBusy(true);
    try {
      if (running) {
        await stop();
        toast.success("已停止弹幕监控");
      } else {
        await start();
        toast.success("已开始弹幕监控");
      }
    } catch (cause: unknown) {
      toast.error(running ? "停止监控失败" : "开始监控失败", { description: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    const msg = draft.trim();
    if (msg === "") {
      toast.error("弹幕内容不能为空");
      return;
    }
    setSending(true);
    try {
      await send(msg);
      setDraft("");
      toast.success("弹幕已发送");
    } catch (cause: unknown) {
      toast.error("发送弹幕失败", { description: errorMessage(cause) });
    } finally {
      setSending(false);
    }
  }

  function toggleFloatTop(next: boolean) {
    setFloatTop(next);
    try {
      globalThis.localStorage?.setItem("lyblive.danmuFloat", next ? "1" : "0");
    } catch {
      // 隐私模式忽略，本次会话仍生效
    }
  }

  return (
    <div className="space-y-4">
      {error !== null ? <ErrorAlert title="弹幕接口出错" message={error} /> : null}

      {floatTop ? (
        <div
          className="sticky top-0 z-20 h-24 overflow-hidden rounded-xl border border-border bg-black/85 shadow-lg backdrop-blur"
          data-testid="danmu-float-top"
        >
          <OverlayStage
            feed={{ running, roomId, items, seq, error }}
            config={floatConfig}
          />
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <MessageSquare className="size-4" />
            弹幕监控
            {running ? (
              <Badge className="bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/30">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                监控中
              </Badge>
            ) : (
              <Badge variant="outline">已停止</Badge>
            )}
          </CardTitle>
          <CardDescription>
            房间 {roomId > 0 ? roomId : "—"} · 已运行 {running ? formatElapsed(startedAt) : "—"} · 事件流
            EventSource('/api/danmu/events')
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void handleToggle()} disabled={busy || loading}>
            {busy || loading ? (
              <LoaderCircle className="animate-spin" />
            ) : running ? (
              <Pause />
            ) : (
              <Play />
            )}
            {running ? "停止监控" : "开始监控"}
          </Button>
          <Button variant="outline" onClick={() => setPaused(!paused)} disabled={!running}>
            {paused ? <ArrowDownToLine /> : <Pause />}
            {paused ? "恢复自动滚底" : "暂停自动滚底"}
          </Button>
          <Button variant="outline" onClick={clear} disabled={items.length === 0}>
            <Trash2 />
            清空列表
          </Button>
          <Button variant="ghost" onClick={() => void refresh()}>
            刷新统计
          </Button>
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={floatTop} onCheckedChange={toggleFloatTop} />
            置顶滚动
          </label>
          {paused ? (
            <span className="text-xs text-amber-500">已暂停自动滚底，新消息仍会继续接收</span>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard icon={MessageSquare} label="弹幕" value={stats.danmu} />
        <StatCard icon={Gift} label="礼物" value={stats.gift} />
        <StatCard icon={Users} label="进场" value={stats.enter} />
        <StatCard icon={TrendingUp} label="人气" value={stats.popularity} />
        <StatCard icon={Activity} label="已接收" value={items.length} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="size-4" />
            关键词 Top10
          </CardTitle>
          <CardDescription>统计最近弹幕的高频词，可用于筛选话题。</CardDescription>
        </CardHeader>
        <CardContent>
          {topKeywords.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无关键词，先开启监控。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {topKeywords.map((item, index) => (
                <Badge key={item.word} variant={index === 0 ? "default" : "secondary"}>
                  {index + 1}. {item.word}
                  <span className="font-mono opacity-70">{item.count}</span>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>实时消息</CardTitle>
          <CardDescription>
            最多保留最近 300 条，新消息自动滚到底部；暂停滚动时仍会继续接收。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="还没有消息"
              description={running ? "等待观众发弹幕…" : "点击「开始监控」接入直播间事件流。"}
            />
          ) : (
            <div
              ref={listRef}
              className="h-80 space-y-1 overflow-y-auto rounded-lg border border-border bg-muted/20 p-2"
            >
              {items.map((item, index) => (
                <Row key={String(item.ts) + "-" + String(index)} item={item} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="size-4" />
            发送弹幕
          </CardTitle>
          <CardDescription>以当前登录账号在直播间发送一条弹幕。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              value={draft}
              maxLength={20}
              placeholder="说点什么…（最多 20 字）"
              className="min-w-48 flex-1"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
            />
            <Button onClick={() => void handleSend()} disabled={sending}>
              {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
              发送
            </Button>
          </div>
          <Separator />
          <div className="flex items-start gap-2 text-xs text-amber-500">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>高风控操作，请勿频繁发送。短时间内连续发言可能触发平台限流甚至封禁。</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface StatCardProps {
  icon: typeof MessageSquare;
  label: string;
  value: number;
}

function StatCard({ icon: Icon, label, value }: StatCardProps) {
  return (
    <Card size="sm">
      <CardContent className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </div>
        <p className="font-mono text-lg font-semibold">{formatCount(value)}</p>
      </CardContent>
    </Card>
  );
}

/** 单条消息行 */
function Row({ item }: { item: DanmuItem }) {
  const meta = kindMeta(item.kind);
  return (
    <div className="flex items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted/40">
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {formatClock(item.ts)}
      </span>
      <span className={"shrink-0 rounded px-1 text-[11px] " + meta.className}>{meta.label}</span>
      <span className="shrink-0 max-w-32 truncate text-xs text-muted-foreground">{item.user}</span>
      <span className={"min-w-0 flex-1 break-words " + kindTextColor(item.kind)}>{item.text}</span>
    </div>
  );
}
