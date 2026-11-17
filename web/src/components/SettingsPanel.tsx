import { useState } from "react";
import {
  Bot,
  Info,
  Settings2,
  FileCog,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Terminal,
  ZoomIn,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/EmptyState";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ScaleControl, useUiScale } from "@/components/ScaleControl";
import { SponsorCard } from "@/components/SponsorCard";
import { OverlaySettingsCard } from "@/modules/danmu-overlay";
import { useCommands } from "@/hooks/useCommands";
import { useConfig } from "@/hooks/useConfig";
import { SCALE_PRESETS, setScale } from "@/lib/ui-scale";
import { errorMessage, type CommandArg } from "@/lib/api";

/** 参数签名：name:type，必填加 * */
function argLabel(arg: CommandArg): string {
  return arg.name + ": " + arg.type + (arg.required ? " *" : "");
}

/** 安全等级徽标：后端给的是字符串，按字面展示 */
function safetyBadge(safety: string) {
  const text = safety !== "" ? safety : "未知";
  const lower = safety.toLowerCase();
  if (lower.includes("danger") || lower.includes("never") || lower.includes("high")) {
    return <Badge variant="destructive">{text}</Badge>;
  }
  if (lower.includes("confirm") || lower.includes("write") || lower.includes("medium")) {
    return <Badge variant="secondary">{text}</Badge>;
  }
  return <Badge variant="outline">{text}</Badge>;
}

/** 设置：配置位置、记住登录开关、命令面表格。 */
export function SettingsPanel() {
  const { config, loading, saving, error, refresh, setRememberLogin } = useConfig();
  const { commands, loading: commandsLoading, error: commandsError, refresh: refreshCommands } =
    useCommands();
  const [refreshing, setRefreshing] = useState(false);
  const scale = useUiScale();

  async function handleToggle(next: boolean) {
    try {
      await setRememberLogin(next);
      toast.success(next ? "已开启记住登录" : "已关闭记住登录", {
        description: next ? "凭据将写入 0600 权限的本地文件" : "凭据只保留在内存中",
      });
    } catch (cause: unknown) {
      toast.error("更新配置失败", { description: errorMessage(cause) });
    }
  }

  async function handleRefreshCommands() {
    setRefreshing(true);
    const ok = await refreshCommands();
    setRefreshing(false);
    if (!ok) {
      toast.error("刷新命令列表失败");
    }
  }

  return (
    <div className="space-y-4">
      {error !== null ? <ErrorAlert title="读取配置失败" message={error} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="size-4" />
            配置位置
          </CardTitle>
          <CardDescription>配置文件由后端读写，前端只做展示。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && config === null ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <>
              <PathRow icon={FolderOpen} label="配置目录" value={config?.configDir ?? "—"} />
              <PathRow icon={FileCog} label="配置文件" value={config?.configFile ?? "—"} />
            </>
          )}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              刷新
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4" />
            记住登录
          </CardTitle>
          <CardDescription>
            开启后凭据写入本地 0600 权限文件，重启无需重新扫码；关闭则只保留在内存。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <div className="space-y-0.5">
              <Label htmlFor="remember-login">记住登录（0600 凭据文件）</Label>
              <p className="text-xs text-muted-foreground">
                接口 POST /api/config，当前状态：
                {config === null ? "读取中…" : config.rememberLogin ? "已开启" : "已关闭"}
              </p>
            </div>
            <Switch
              id="remember-login"
              checked={config?.rememberLogin === true}
              disabled={config === null || saving}
              onCheckedChange={(checked) => void handleToggle(checked)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ZoomIn className="size-4" />
            界面缩放
          </CardTitle>
          <CardDescription>
            OBS 停靠窗口太窄、字太小看不清时用它。右上角的 − / + 也能直接调；缩放只放大字号与间距，不会撑出横向滚动。
            设置保存在本机，重启 OBS 仍然生效。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {SCALE_PRESETS.map((preset) => (
              <Button
                key={preset}
                size="sm"
                variant={Math.abs(scale - preset) < 0.001 ? "default" : "outline"}
                onClick={() => setScale(preset)}
              >
                {Math.round(preset * 100)}%
              </Button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">当前 {Math.round(scale * 100)}%</span>
              <ScaleControl />
            </div>
          </div>

          <Alert>
            <Info />
            <AlertTitle>找不到「插件设置」是正常的</AlertTitle>
            <AlertDescription>
              lyblive 不是 OBS 插件，而是 OBS 的「自定义浏览器停靠窗口」。入口在 OBS 菜单
              「停靠窗口 → 自定义浏览器停靠窗口」；面板本身就在停靠区（右侧或底部），
              拖标题栏可移动，拖面板边界可加宽。
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Alert>
        <Bot />
        <AlertTitle>命令面同样驱动 CLI 与 MCP</AlertTitle>
        <AlertDescription>
          下表命令直接来自后端注册表 /api/commands：既可作为 CLI 子命令执行，也作为 MCP 工具暴露给 AI 调用，
          签名与安全等级完全一致。
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="size-4" />
            命令面
            <Badge variant="outline">{commands.length}</Badge>
          </CardTitle>
          <CardDescription>name / about / safety / args 均由后端提供。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {commandsError !== null ? (
            <ErrorAlert title="获取命令列表失败" message={commandsError} />
          ) : null}

          {commandsLoading && commands.length === 0 ? (
            <Skeleton className="h-24 w-full" />
          ) : commands.length === 0 ? (
            <EmptyState
              icon={Terminal}
              title="后端没有注册命令"
              description="检查后端是否注册了命令注册表。"
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">命令</TableHead>
                  <TableHead className="w-24">安全等级</TableHead>
                  <TableHead>说明</TableHead>
                  <TableHead className="hidden w-64 sm:table-cell">参数</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commands.map((command) => (
                  <TableRow key={command.name}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {command.name}
                    </TableCell>
                    <TableCell>{safetyBadge(command.safety)}</TableCell>
                    <TableCell className="text-muted-foreground">{command.about}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {command.args.length === 0 ? (
                        <span className="text-xs text-muted-foreground">无参数</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {command.args.map((arg) => (
                            <code
                              key={arg.name}
                              className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                            >
                              {argLabel(arg)}
                            </code>
                          ))}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}

          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRefreshCommands()}
              disabled={refreshing}
            >
              {refreshing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              刷新命令
            </Button>
          </div>
        </CardContent>
      </Card>

      <OverlaySettingsCard />

      <SponsorCard />
    </div>
  );
}

interface PathRowProps {
  icon: typeof FolderOpen;
  label: string;
  value: string;
}

/** 只读路径行：等宽可选中 */
function PathRow({ icon: Icon, label, value }: PathRowProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className="rounded-lg border border-border bg-muted/40 px-2.5 py-2 font-mono text-xs break-all select-all">
        {value}
      </p>
    </div>
  );
}
