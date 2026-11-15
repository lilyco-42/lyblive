import { useState } from "react";
import {
  ListMusic,
  MessageSquare,
  QrCode,
  Radio,
  Settings2,
  Tv,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { DanmuPanel } from "@/components/DanmuPanel";
import { LivePanel } from "@/components/LivePanel";
import { LoginPanel } from "@/components/LoginPanel";
import { RoomPanel } from "@/components/RoomPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { useHealth } from "@/hooks/useHealth";
import { useSession } from "@/hooks/useSession";

const TABS = [
  { value: "login", label: "登录", icon: QrCode },
  { value: "room", label: "房间", icon: Tv },
  { value: "live", label: "直播", icon: Radio },
  { value: "danmu", label: "弹幕", icon: MessageSquare },
  { value: "settings", label: "设置", icon: Settings2 },
] as const;

/** 顶栏健康徽标：正常绿点，异常红点 */
function HealthBadge({ ok, text }: { ok: boolean; text: string }) {
  return (
    <Badge
      variant="outline"
      className={
        "h-6 gap-1.5 px-2.5 font-mono text-xs " +
        (ok ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive")
      }
    >
      <span
        className={
          "size-1.5 rounded-full " + (ok ? "bg-emerald-500" : "bg-destructive")
        }
      />
      {text}
    </Badge>
  );
}

function App() {
  const [tab, setTab] = useState<string>("login");
  const { health, error: healthError } = useHealth();
  const { session, loading: sessionLoading, refresh: refreshSession } = useSession();

  const backendText =
    health !== null
      ? health.name + " v" + health.version + " · " + health.backend
      : healthError !== null
        ? "后端未就绪"
        : "连接中…";

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto w-full max-w-5xl px-4 pt-8 pb-16 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3 pb-6">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Logo className="size-5" />
            </span>
            <div className="leading-tight">
              <h1 className="text-lg font-semibold tracking-tight">lyblive · B站直播助手</h1>
              <p className="text-xs text-muted-foreground">
                {session?.loggedIn === true
                  ? "已登录 " + (session.user?.uname ?? "直播间")
                  : "扫码登录后可管理直播间"}
              </p>
            </div>
          </div>
          <HealthBadge ok={health !== null && health.ok} text={backendText} />
        </header>

        <Tabs value={tab} onValueChange={setTab} className="gap-5">
          <TabsList className="h-9 w-full justify-start gap-1 overflow-x-auto p-1 sm:w-fit">
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <TabsTrigger key={item.value} value={item.value} className="px-3">
                  <Icon />
                  {item.label}
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value="login">
            <LoginPanel
              session={session}
              loading={sessionLoading}
              onRefresh={refreshSession}
            />
          </TabsContent>
          <TabsContent value="room">
            <RoomPanel />
          </TabsContent>
          <TabsContent value="live">
            <LivePanel />
          </TabsContent>
          <TabsContent value="danmu">
            <DanmuPanel />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsPanel />
          </TabsContent>
        </Tabs>

        <footer className="mt-12 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <ListMusic className="size-3.5" />
            {health !== null ? health.name + " v" + health.version : "lyblive"}
          </span>
          <span>所有请求同源，走 /api/... 相对路径</span>
        </footer>
      </div>
      <Toaster position="top-center" theme="dark" richColors closeButton />
    </div>
  );
}

export default App;
